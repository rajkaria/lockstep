import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { lintRepo } from '../src/lint/engine.js';
import { consumedByDependency, dependencyNames, docEnvClaims, envFileClaims, ENV_FILE, fileEnv, isWellKnown } from '../src/lint/facts-env.js';
import { scanClaims } from '../src/lint/scan.js';
import type { LintResult } from '../src/lint/types.js';
import { gitIn } from './helpers.js';

/** A git repository (files added, not committed) with these files. */
async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-env-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  return dir;
}

const brief = (r: LintResult) => r.findings.map((f) => `${f.path}:${f.line}:${f.column} ${f.rule} ${f.subject} | ${f.message}`);
const ENV_RULES = ['env-unused', 'env-undocumented'] as const;

const ENV_MD = `# Environment

| Variable | Description |
|---|---|
| \`PARTNER_API_KEY\` | Read by the partner's SDK. |
| \`DEMO_API_URL\` | API base URL. |
| \`DEMO_TEST_TOKEN\` | Token the tests use. |
| \`DEMO_COMPOSE_ONLY\` | Set by docker compose. |
| \`PIP_*\` | Passed to pip. |

\`\`\`bash
export DEMO_PROFILE=dev
DEMO_TIMEOUT=5 npm start
\`\`\`

Set the \`DEMO_LOG_DIR\` environment variable to keep logs. \`HOME\` and \`GITHUB_TOKEN\` are environment variables git reads.
The old \`DEMO_LEGACY_URL\` environment variable was removed.

<!-- staleproof: ignore -->
Set \`DEMO_IGNORED\` in your environment.

\`\`\`env
OPENAI_API_KEY=sk-...
DEMO_FROM_DOTENV_BLOCK=1
\`\`\`
`;

const CONFIG_TS = `import OpenAI from 'openai';
const { CACHE_TTL } = process.env;
export const config = {
  db: process.env.DATABASE_URL,
  region: process.env.DEMO_REGION,
  mode: process.env['NODE_ENV'],
  ttl: Number(CACHE_TTL ?? 60),
  // process.env.COMMENTED_OUT is not a read
  quiet: process.env.DEMO_QUIET, // staleproof: ignore[env-undocumented]
};
process.env.DEMO_WRITTEN = '1';
export const msg = 'set process.env.DEMO_IN_STRING';
export const client = new OpenAI();
`;

const SETTINGS_PY = `import os

API_URL = os.environ.get("DEMO_API_URL", "http://localhost")
TIMEOUT = os.getenv("DEMO_TIMEOUT")
if "DEMO_DEBUG" in os.environ:
    pass
os.environ["DEMO_CHILD"] = "1"
`;

describe('env facts', () => {
  it('knows env example files, and never .env itself', () => {
    for (const yes of ['.env.example', 'apps/web/.env.local.example', '.env.sample', '.env.template', '.env.dist', 'env.example', '.env-example']) expect(ENV_FILE.test(yes)).toBe(true);
    for (const no of ['.env', '.env.local', '.env.cloud', '.env.production', 'docs/env.md', '.env.example.bak']) expect(ENV_FILE.test(no)).toBe(false);
  });

  it('reads the variables an env file lists, commented optional ones included, and its ${X} references', () => {
    const { claims, refs } = envFileClaims('# Copy to .env\nA_URL=x\nexport B_KEY="y"\n# C_OPTIONAL=\n# just a comment = no\nD=${A_URL}/v1\n');
    expect(claims.map((c) => `${c.name}@${c.span.line}:${c.span.column}`)).toEqual(['A_URL@2:1', 'B_KEY@3:8', 'C_OPTIONAL@4:3', 'D@6:1']);
    expect([...refs]).toEqual(['A_URL']);
  });

  it('reads documented variables from env tables, shell and .env blocks, and code spans about the environment', () => {
    const claims = docEnvClaims(scanClaims('docs/env.md', ENV_MD));
    expect(claims.map((c) => `${c.name}@${c.span.line}:${c.span.column}/${c.how}`)).toEqual([
      'PARTNER_API_KEY@5:4/table',
      'DEMO_API_URL@6:4/table',
      'DEMO_TEST_TOKEN@7:4/table',
      'DEMO_COMPOSE_ONLY@8:4/table',
      'DEMO_PROFILE@12:8/shell',
      'DEMO_TIMEOUT@13:1/shell',
      'OPENAI_API_KEY@23:1/shell',
      'DEMO_FROM_DOTENV_BLOCK@24:1/shell',
      'DEMO_LOG_DIR@16:10/prose',
      'HOME@16:60/prose',
      'GITHUB_TOKEN@16:71/prose',
      'DEMO_LEGACY_URL@17:10/prose',
      'DEMO_IGNORED@20:6/prose',
    ]);
    const more = docEnvClaims(scanClaims('README.md', 'Use `process.env.API_TOKEN`, `$HOME_DIR`, `os.getenv("PY_KEY")` and `DEBUG=1 npm test`.\nThe `MAX_SIZE` constant.\n'));
    expect(more.map((c) => c.name)).toEqual(['API_TOKEN', 'HOME_DIR', 'PY_KEY', 'DEBUG']);
    const rst = docEnvClaims(scanClaims('docs/cli.rst', 'Set :envvar:`FLASK_APP`.\n\n.. envvar:: FLASK_DEBUG\n'));
    expect(rst.map((c) => `${c.name}@${c.span.line}:${c.span.column}`)).toEqual(['FLASK_APP@1:14', 'FLASK_DEBUG@3:13']);
  });

  it('reads environment reads in JS/TS, Python, Go, Rust and Ruby, never writes, comments or strings', () => {
    const js = fileEnv('src/config.ts', CONFIG_TS)!;
    expect(js.reads.map((r) => `${r.name}@${r.line}:${r.column}`)).toEqual(['DATABASE_URL@4:19', 'DEMO_REGION@5:23', 'DEMO_QUIET@9:22', 'NODE_ENV@6:22', 'CACHE_TTL@2:9']);
    const py = fileEnv('app/settings.py', `${SETTINGS_PY}"""Docstring: os.getenv("IN_DOC")."""\nWSGI = request.environ["PATH_INFO"]\n`)!;
    expect(py.reads.map((r) => r.name)).toEqual(['DEMO_API_URL', 'DEMO_TIMEOUT', 'DEMO_DEBUG']);
    expect(fileEnv('main.go', 'v := os.Getenv("GO_VAR") // os.Getenv("NO")\nr := \'"\'\n_, ok := os.LookupEnv(`RAW`)\n')!.reads.map((r) => r.name)).toEqual(['GO_VAR', 'RAW']);
    expect(fileEnv('main.rs', 'const HOME_VAR: &str = "CODEX_HOME";\nlet v = std::env::var("RS_VAR");\nlet w = env!("CARGO_PKG_VERSION");\nlet x = env::var(HOME_VAR);\n')!).toMatchObject({
      reads: [{ name: 'RS_VAR' }, { name: 'CARGO_PKG_VERSION' }],
      dynamic: [{ kind: 'name', key: 'HOME_VAR' }],
      constants: new Map([['HOME_VAR', 'CODEX_HOME']]),
    });
    expect(fileEnv('app.rb', 'x = ENV["RB_VAR"]\ny = ENV.fetch("RB_FETCH", nil)\n')!.reads.map((r) => r.name)).toEqual(['RB_VAR', 'RB_FETCH']);
  });

  it('tells computed reads apart: a variable key, literal fragments, an opaque expression, the environment walked or splatted', () => {
    const js = fileEnv('src/s.ts', 'const a = env[`STALEPROOF_${name}`];\nconst b = process.env[key];\nconst c = process.env[pick()];\nfor (const k of Object.keys(process.env)) if (k.startsWith("APP_")) x(k);\nenv[k] = v;\ndelete process.env[k];\n')!;
    expect(js.dynamic.map((d) => `${d.kind}:${d.key ?? d.fragments.join(',')}`)).toEqual(['name:key', 'computed:', 'computed:STALEPROOF_', 'iterate:APP_']);
    const py = fileEnv('s.py', 'from os import environ\nx = environ[f"SVC_{name}"]\nSettings(**os.environ)\nenv = {**os.environ, "X": "1"}\n')!;
    expect(py.dynamic.map((d) => `${d.kind}:${d.fragments.join(',')}`)).toEqual(['computed:SVC_', 'splat:']);
  });

  it('knows which variables platforms set and which dependencies read', () => {
    for (const v of ['PATH', 'NODE_ENV', 'GITHUB_TOKEN', 'npm_config_cache', 'VERCEL_URL', 'PYTHONPATH', 'RUST_LOG', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'PGHOST']) expect(isWellKnown(v)).toBe(true);
    for (const v of ['DATABASE_URL', 'API_KEY', 'PGX']) expect(isWellKnown(v)).toBe(false);
    const deps = new Set(['openai', '@sentry/node', 'stripe', 'boto3', '@acme/api-client', 'cohere']);
    expect(['OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'SENTRY_DSN', 'STRIPE_SECRET_KEY', 'AWS_REGION', 'CO_API_KEY'].map((v) => consumedByDependency(v, deps))).toEqual(['openai', 'openai', '@sentry/node', 'stripe', 'boto3', 'cohere']);
    expect(consumedByDependency('API_URL', deps)).toBeUndefined();
    expect(consumedByDependency('ACME_TOKEN', deps)).toBe('@acme/api-client');
  });

  it('reads dependency names from npm, PyPI, Cargo and Go manifests', async () => {
    const dir = await repoWith({
      'package.json': JSON.stringify({ dependencies: { openai: '1' }, devDependencies: { '@types/node': '1' } }),
      'pyproject.toml': '[project]\nname = "x"\ndependencies = ["httpx>=0.27", "logfire[fastapi]"]\n[dependency-groups]\ndev = ["pytest"]\n',
      'requirements-dev.txt': '# tools\nruff==0.5\n-r base.txt\n',
      'Cargo.toml': '[dependencies]\nreqwest = "0.12"\n[workspace.dependencies]\ntokio = "1"\n',
      'go.mod': 'module x\n\nrequire (\n\tgithub.com/go-chi/chi/v5 v5.0.0\n)\n',
    });
    expect([...(await dependencyNames(dir, ['package.json', 'pyproject.toml', 'requirements-dev.txt', 'Cargo.toml', 'go.mod']))].sort()).toEqual(['@types/node', 'httpx', 'logfire', 'openai', 'pytest', 'reqwest', 'ruff', 'tokio', 'v5'].sort());
  });
});

describe('env-unused and env-undocumented', () => {
  let dir: string;
  let result: LintResult;

  beforeAll(async () => {
    dir = await repoWith({
      '.env.example': '# Copy to .env.\nDATABASE_URL=postgres://localhost/demo\nCACHE_TTL=60\nLEGACY_TOKEN=\n# OPENAI_API_KEY=sk-...\nPORT=3000\n',
      'package.json': JSON.stringify({ name: 'envdemo', private: true, dependencies: { openai: '^4' } }),
      'src/config.ts': CONFIG_TS,
      'app/settings.py': SETTINGS_PY,
      'tests/test_settings.py': 'import os\nTOKEN = os.environ["DEMO_TEST_TOKEN"]\nos.getenv("DEMO_TEST_ONLY")\n',
      'scripts/release.ts': 'console.log(process.env.NPM_PUBLISH_TOKEN);\n',
      'docker-compose.yml': 'services:\n  app:\n    environment:\n      - DEMO_COMPOSE_ONLY=1\n',
      'docs/env.md': ENV_MD,
      'README.md': '# Env demo\n\n| Env var | Use |\n|---|---|\n| \`DATABASE_URI\` | Postgres connection string. |\n',
    });
    result = await lintRepo({ dir, repo: 'acme/env-demo', rules: [...ENV_RULES] });
  });

  it('reports documented variables no code reads, and product code reads the env file does not list', () => {
    expect(brief(result)).toEqual([
      'README.md:5:4 env-unused DATABASE_URI | `DATABASE_URI` is documented but no code reads it (the code reads `DATABASE_URL`).',
      'docs/env.md:12:8 env-unused DEMO_PROFILE | `DEMO_PROFILE` is documented but no code reads it.',
      'docs/env.md:16:10 env-unused DEMO_LOG_DIR | `DEMO_LOG_DIR` is documented but no code reads it.',
      'docs/env.md:24:1 env-unused DEMO_FROM_DOTENV_BLOCK | `DEMO_FROM_DOTENV_BLOCK` is documented but no code reads it.',
      '.env.example:4:1 env-unused LEGACY_TOKEN | `LEGACY_TOKEN` is listed in .env.example but no code reads it.',
      'app/settings.py:5:5 env-undocumented DEMO_DEBUG | `DEMO_DEBUG` is read in app/settings.py but not listed in .env.example.',
      'src/config.ts:5:23 env-undocumented DEMO_REGION | `DEMO_REGION` is read in src/config.ts but not listed in .env.example.',
    ]);
    expect(result.findings.map((f) => f.surface)).toEqual(['readme', 'docs', 'docs', 'docs', 'config', 'config', 'config']);
  });

  it('locates every finding on the name as written', async () => {
    for (const f of result.findings) {
      const line = (await readFile(join(dir, f.path), 'utf8')).split('\n')[f.line - 1]!;
      expect(line.slice(f.column - 1, f.endColumn - 1)).toBe(f.subject);
    }
  });

  it('honours suppressions in docs and in code', () => {
    const subjects = result.findings.map((f) => f.subject);
    expect(subjects).not.toContain('DEMO_IGNORED');
    expect(subjects).not.toContain('DEMO_QUIET');
  });

  it('judges no documented name when the code reads a name it computes', async () => {
    const opaque = await repoWith({
      'README.md': 'Set the `SVC_GONE` environment variable.\n',
      'src/env.ts': 'export const read = (a: string, b: string) => process.env[a + b];\n',
    });
    expect((await lintRepo({ dir: opaque, rules: [...ENV_RULES] })).findings).toEqual([]);
  });

  it('treats a family of names (`STALEPROOF_${name}`) as read when the code spells out the rest', async () => {
    const family = await repoWith({
      'README.md': '| Env var | Effect |\n|---|---|\n| `APP_MODEL` | The model. |\n| `APP_GONE` | A knob. |\n',
      'src/config.ts': 'export const setting = (name: string, env = process.env) => env[`APP_${name}`];\nexport const model = setting("MODEL");\n',
    });
    expect(brief(await lintRepo({ dir: family, rules: [...ENV_RULES] }))).toEqual(['README.md:4:4 env-unused APP_GONE | `APP_GONE` is documented but no code reads it.']);
  });

  it('reads pydantic settings fields as variables, with their env_prefix', async () => {
    const pyd = await repoWith({
      'docs/config.md': 'Environment variables: `SVC_DATABASE_URL`, `SVC_REMOVED_FLAG`.\n',
      'svc/settings.py': 'from pydantic_settings import BaseSettings, SettingsConfigDict\n\nclass Settings(BaseSettings):\n    model_config = SettingsConfigDict(env_prefix="SVC_")\n    database_url: str\n',
    });
    expect(brief(await lintRepo({ dir: pyd, repo: 'acme/svc', rules: [...ENV_RULES] }))).toEqual(['docs/config.md:1:45 env-unused SVC_REMOVED_FLAG | `SVC_REMOVED_FLAG` is documented but no code reads it.']);
  });

  it('never judges what another product reads: dependencies, packages the docs install, families, docs examples, named products', async () => {
    const other = await repoWith({
      'package.json': JSON.stringify({ name: 'demo-app', private: true, dependencies: { stripe: '1' } }),
      'README.md': [
        '# Demo',
        '',
        'Install the partner SDK with `npm install acme-partner-sdk`.',
        '',
        '| Env var | Use |',
        '|---|---|',
        '| `STRIPE_SECRET_KEY` | Read by the Stripe SDK. |',
        '| `PARTNER_TOKEN` | Read by the partner SDK. |',
        '| `SMOL_SECCOMP` | One of the `SMOL_*` variables smol reads. |',
        '| `EXAMPLE_ACCOUNT_ID` | Used by the example below. |',
        '| `LANGSMITH_TRACING` | LangSmith exports traces when set. |',
        '| `DEMO_GONE` | A knob of ours. |',
        '',
        '```python',
        'import os',
        'account = os.environ["EXAMPLE_ACCOUNT_ID"]',
        '```',
        '',
        '```bash',
        'export BENCH_DIR=/tmp/bench',
        'ls "$BENCH_DIR"',
        'SKIP_HOOKS_MODE=1 git commit -m wip',
        '```',
        '',
      ].join('\n'),
      'docs/tutorial.md': 'Set the `DATABASE_URL` and `DEMO_TUTORIAL_FLAG` environment variables in your project.\n',
      '.husky/pre-commit': 'if [ -n "$SKIP_HOOKS_MODE" ]; then exit 0; fi\n',
      'src/app.ts': 'export const used = process.env.DEMO_USED;\n',
    });
    expect(brief(await lintRepo({ dir: other, repo: 'acme/demo', rules: ['env-unused'] }))).toEqual([
      'README.md:12:4 env-unused DEMO_GONE | `DEMO_GONE` is documented but no code reads it.',
      'docs/tutorial.md:1:29 env-unused DEMO_TUTORIAL_FLAG | `DEMO_TUTORIAL_FLAG` is documented but no code reads it.',
    ]);
  });

  it('asks nothing of variables the code sets itself or test runners set', async () => {
    const set = await repoWith({
      '.env.example': 'APP_KEY=\n',
      'src/parent.ts': 'spawn("node", ["child.js"], { env: { ...process.env, CHILD_PHASE: "start" } });\n',
      'src/child.ts': 'export const phase = [process.env.CHILD_PHASE, process.env.PLAYWRIGHT, process.env.APP_KEY, process.env.APP_SECRET];\n',
    });
    expect(brief(await lintRepo({ dir: set, rules: ['env-undocumented'] }))).toEqual([
      'src/child.ts:1:105 env-undocumented APP_SECRET | `APP_SECRET` is read in src/child.ts but not listed in .env.example.',
    ]);
  });

  it('asks an env file for the variables of the code under its folder only', async () => {
    const mono = await repoWith({
      'apps/web/.env.example': 'WEB_URL=\n',
      'apps/web/src/app.ts': 'export const u = [process.env.WEB_URL, process.env.WEB_SECRET];\n',
      'packages/lib/src/x.ts': 'export const k = process.env.LIB_KEY;\n',
    });
    expect(brief(await lintRepo({ dir: mono, rules: ['env-undocumented'] }))).toEqual([
      'apps/web/src/app.ts:1:52 env-undocumented WEB_SECRET | `WEB_SECRET` is read in apps/web/src/app.ts but not listed in apps/web/.env.example.',
    ]);
  });
});
