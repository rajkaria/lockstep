/**
 * Environment variable facts: the variables a repository documents (env example files,
 * env tables, `export X=` / `X=… cmd` in shell blocks, code spans next to "environment
 * variable") and the variables its code reads (`process.env.X`, `os.environ['X']`,
 * `os.getenv`, `Deno.env.get`, `import.meta.env`, Go's `os.Getenv`, Rust's `env::var`, ...),
 * found with one regex pass over every code and config file, comments masked.
 */
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { isShellLang, type ScannedDoc, type Span } from './scan.js';

/** `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.local.example`, `env.example`, ... */
export const ENV_FILE = /(^|\/)(\.env(?:[.-][\w-]+)*[.-](?:example|sample|template|dist|tpl|defaults?)|env\.(?:example|sample|template))$/i;

/** A variable a docs page or an env file says the code reads. */
export interface EnvClaim {
  name: string;
  span: Span;
  how: 'env-file' | 'table' | 'shell' | 'prose';
}

/** A read of one variable by name, located in a code file. */
export interface EnvRead {
  name: string;
  line: number;
  column: number;
  endColumn: number;
}

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const UPPER = /^[A-Z][A-Z0-9_]*$/;

/**
 * Variables every platform, shell or toolchain sets or reads itself: documenting one is
 * never stale, and code reading one needs no entry in `.env.example`.
 */
export const WELL_KNOWN = new Set(
  (
    'PATH HOME USER USERNAME USERPROFILE LOGNAME SHELL TERM COLORTERM CI NODE_ENV PORT HOST HOSTNAME TZ LANG LANGUAGE ' +
    'DEBUG PWD OLDPWD TMPDIR TMP TEMP EDITOR VISUAL PAGER BROWSER DISPLAY WAYLAND_DISPLAY COLUMNS LINES NO_COLOR FORCE_COLOR ' +
    'CLICOLOR CLICOLOR_FORCE HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy no_proxy all_proxy ' +
    'SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE SSH_AUTH_SOCK GPG_TTY APPDATA LOCALAPPDATA PROGRAMFILES ' +
    'SYSTEMROOT COMSPEC WINDIR ENV MODE DEV PROD SSR BASE_URL VIRTUAL_ENV JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT CC CXX ' +
    'CFLAGS CXXFLAGS LDFLAGS CPPFLAGS MAKEFLAGS PKG_CONFIG_PATH LD_LIBRARY_PATH LD_PRELOAD RUSTFLAGS RUSTDOCFLAGS GOPATH ' +
    'GOFLAGS GOOS GOARCH GOPROXY GOPRIVATE GOBIN GOROOT GOCACHE GOWORK GH_TOKEN GH_HOST GH_ENTERPRISE_TOKEN NETRC ' +
    'CODECOV_TOKEN NPM_TOKEN NODE_AUTH_TOKEN OMP_NUM_THREADS MKL_NUM_THREADS OPENBLAS_NUM_THREADS TOKENIZERS_PARALLELISM ' +
    'JENKINS_URL BUILD_ID BUILD_NUMBER TRAVIS CIRCLECI NETLIFY RENDER TF_BUILD SHLVL TERM_PROGRAM DJANGO_SETTINGS_MODULE ' +
    'VERCEL HUSKY SKIP_ENV_VALIDATION PLAYWRIGHT JEST_WORKER_ID VITEST VITEST_POOL_ID VITEST_WORKER_ID PYTEST_CURRENT_TEST PYTEST_XDIST_WORKER'
  ).split(' '),
);

/** Prefixes of variables set or read by platforms and toolchains (CI, package managers, runtimes). */
export const WELL_KNOWN_PREFIX =
  /^(GITHUB_|RUNNER_|npm_|NPM_CONFIG_|npm_config_|VERCEL_|NEXT_RUNTIME|NODE_|PYTHON|PIP_|UV_|POETRY_|HATCH_|PDM_|PIPX_|CONDA_|YARN_|PNPM_|BUN_|COREPACK_|DENO_|RUST_|CARGO_|RUSTUP_|RUSTC_|CGO_|GO1|DOCKER_|COMPOSE_|BUILDKIT_|GIT_|XDG_|LC_|SSH_|CI_|GITLAB_|BUILDKITE_|CIRCLE_|TRAVIS_|CODEBUILD_|NETLIFY_|RENDER_|FLY_|HEROKU_|RAILWAY_|OTEL_|CUDA_|PYTORCH_|TF_CPP_|DYLD_|MSYS|MINGW|HOMEBREW_|ACTIONS_|INPUT_|STATE_|PLAYWRIGHT_|CYPRESS_|JEST_|VITEST_|PYTEST_|PG(HOST|PORT|USER|PASSWORD|DATABASE|SSLMODE|APPNAME|PASSFILE|SERVICE|OPTIONS)$)/;

export function isWellKnown(name: string): boolean {
  return WELL_KNOWN.has(name) || WELL_KNOWN_PREFIX.test(name);
}

/**
 * Variables a dependency reads by convention, beyond the prefix its name gives
 * (`openai` → `OPENAI_*`): SDKs that read `AZURE_OPENAI_*`, `CO_API_KEY`, `HF_TOKEN`, ...
 */
const CONSUMED: [RegExp, RegExp][] = [
  [/^(openai|@ai-sdk\/openai|@ai-sdk\/azure|langchain-openai|@langchain\/openai)$/, /^(OPENAI_|AZURE_OPENAI_)/],
  [/^(cohere|cohere-ai|@ai-sdk\/cohere)$/, /^(CO_API_KEY|COHERE_)/],
  [/^(huggingface[-_]hub|transformers|datasets|diffusers|tokenizers|@huggingface\/.*)$/, /^(HF_|HUGGINGFACE_|HUGGING_FACE_|TRANSFORMERS_)/],
  [/^(google-genai|google-generativeai|@google\/genai|@google\/generative-ai|@ai-sdk\/google|@ai-sdk\/google-vertex|vertexai|google-cloud-.*|@google-cloud\/.*|google-auth|firebase-admin|firebase|langchain-google-.*)$/, /^(GOOGLE_|GEMINI_|GCLOUD_|GCP_|CLOUDSDK_|FIREBASE_|VERTEX_)/],
  [/^(boto3|botocore|aiobotocore|aws-sdk|@aws-sdk\/.*|@ai-sdk\/amazon-bedrock|aws-cdk-lib|serverless)$/, /^AWS_/],
  [/^(azure-.*|@azure\/.*)$/, /^AZURE_/],
  [/^(prisma|@prisma\/client)$/, /^(DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|PRISMA_)/],
  [/^(next-auth|@auth\/.*)$/, /^(NEXTAUTH_|AUTH_)/],
  [/^(next)$/, /^(NEXT_PUBLIC_|NEXT_TELEMETRY_|__NEXT_)/],
  [/^(@vercel\/postgres)$/, /^POSTGRES_/],
  [/^(@vercel\/kv)$/, /^KV_/],
  [/^(@vercel\/blob)$/, /^BLOB_/],
  [/^(@vercel\/edge-config)$/, /^EDGE_CONFIG/],
  [/^(ai|@ai-sdk\/gateway)$/, /^AI_GATEWAY_/],
  [/^(langsmith|langchain|@langchain\/.*|langchain-.*)$/, /^(LANGCHAIN_|LANGSMITH_)/],
  [/^(django|djangorestframework)$/, /^DJANGO_/],
  [/^(sentry-sdk|@sentry\/.*)$/, /^SENTRY_/],
  [/^(wandb)$/, /^WANDB_/],
  [/^(mlflow)$/, /^MLFLOW_/],
  [/^(react-scripts)$/, /^REACT_APP_/],
  [/^(expo)$/, /^EXPO_/],
  [/^(vite|astro|@sveltejs\/kit|nuxt)$/, /^(VITE_|PUBLIC_|NUXT_)/],
  [/^(torch|tensorflow|jax)$/, /^(TORCH_|TF_|XLA_|JAX_)/],
  [/^(uvicorn|gunicorn|hypercorn|starlette|fastapi)$/, /^(FORWARDED_ALLOW_IPS|WEB_CONCURRENCY|UVICORN_|GUNICORN_|HYPERCORN_)/],
  [/^(nuxt|nitropack|nitro)$/, /^(NITRO_|NUXT_)/],
  [/^(dd-trace|ddtrace|datadog.*|@datadog\/.*)$/, /^DD_/],
  [/^(@vercel\/otel|@opentelemetry\/.*|opentelemetry-.*|logfire)$/, /^(OTEL_|LOGFIRE_)/],
  [/^(playwright|@playwright\/test)$/, /^(PLAYWRIGHT_|PWDEBUG|PW_)/],
  [/^(puppeteer)$/, /^PUPPETEER_/],
  [/^(@blaxel\/.*|blaxel)$/, /^BL_/],
];

/** Tokens of a dependency name too generic to be a variable prefix (`@acme/api-client` names no `API_*`). */
const GENERIC_TOKEN = new Set(
  'sdk js ts py python node client api core lib libs utils util types type common server plugin plugins cli dev test tests tools tool config base http https web app ui kit provider providers data the react vue svelte go rs rust io async sync extra extras next std'.split(' '),
);

/** Normalised dependency names of every manifest in the repository (npm, PyPI, Cargo, Go). */
export async function dependencyNames(dir: string, paths: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const add = (n: string) => {
    const name = n.trim().toLowerCase();
    if (name) out.add(name);
  };
  const manifests = paths.filter(
    (p) =>
      !/(^|\/)(node_modules|vendor|\.venv|venv|site-packages)\//.test(p) &&
      /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|Pipfile|Cargo\.toml|go\.mod|setup\.cfg)$|(^|\/)requirements\/[^/]+\.txt$/.test(p),
  );
  await Promise.all(
    manifests.map(async (path) => {
      const text = await readFile(join(dir, path), 'utf8').catch(() => '');
      if (!text) return;
      const base = posix.basename(path);
      try {
        if (base === 'package.json') {
          const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
          for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const d of Object.keys(pkg[k] ?? {})) add(d);
        } else if (base === 'pyproject.toml' || base === 'Cargo.toml' || base === 'Pipfile') {
          const t = parseToml(text) as Record<string, any>;
          const specs: string[] = [];
          const keys = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o) : []);
          specs.push(...(t.project?.dependencies ?? []));
          for (const g of Object.values(t.project?.['optional-dependencies'] ?? {})) specs.push(...(g as string[]));
          for (const g of Object.values(t['dependency-groups'] ?? {})) specs.push(...(g as unknown[]).filter((x): x is string => typeof x === 'string'));
          specs.push(...(t.tool?.uv?.['dev-dependencies'] ?? []));
          for (const k of [...keys(t.tool?.poetry?.dependencies), ...keys(t.tool?.poetry?.['dev-dependencies'])]) add(k);
          for (const g of Object.values(t.tool?.poetry?.group ?? {})) for (const k of keys((g as Record<string, unknown>).dependencies)) add(k);
          for (const k of [...keys(t.packages), ...keys(t['dev-packages'])]) add(k);
          for (const k of [...keys(t.dependencies), ...keys(t['dev-dependencies']), ...keys(t['build-dependencies']), ...keys(t.workspace?.dependencies)]) add(k);
          for (const s of specs) add(s.split(/[\s\[<>=!~;@(]/)[0] ?? '');
        } else if (base === 'go.mod') {
          for (const m of text.matchAll(/^\s*(?:require\s+)?([\w.-]+\/[\w./-]+)\s+v[\d.]/gm)) add(m[1]!.split('/').pop()!);
        } else {
          for (const line of text.split('\n')) {
            const l = line.replace(/#.*$/, '').trim();
            if (!l || l.startsWith('-') || l.startsWith('[')) continue;
            add(l.split(/[\s\[<>=!~;@(]/)[0] ?? '');
          }
        }
      } catch {
        // an unreadable manifest names nothing
      }
    }),
  );
  return out;
}

/** Whether a dependency reads this variable by convention: its name's prefix (`stripe` → `STRIPE_*`) or a known SDK variable. */
export function consumedByDependency(name: string, deps: Set<string>): string | undefined {
  for (const dep of deps) {
    for (const [pkg, vars] of CONSUMED) if (pkg.test(dep) && vars.test(name)) return dep;
    const tokens = dep
      .split(/[@/._-]+/)
      .map((t) => t.replace(/\d+$/, ''))
      .filter((t) => t.length >= 2 && !GENERIC_TOKEN.has(t));
    for (const t of tokens) if (name.startsWith(`${t.toUpperCase()}_`)) return dep;
    const whole = dep.replace(/^@/, '').replace(/[^a-z0-9]+/g, '_').toUpperCase();
    if (whole.length >= 3 && name.startsWith(`${whole}_`)) return dep;
  }
  return undefined;
}

/** Variables an env example file lists: `KEY=value`, `export KEY=`, and commented `# KEY=` (optional ones). */
export function envFileClaims(text: string): { claims: EnvClaim[]; refs: Set<string> } {
  const claims: EnvClaim[] = [];
  const refs = new Set<string>();
  for (const [i, line] of text.replace(/\r\n?/g, '\n').split('\n').entries()) {
    const m = new RegExp(`^(\\s*(?:export\\s+)?)(${NAME})\\s*=`).exec(line) ?? /^(\s*#+\s*(?:export\s+)?)([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) {
      const column = m[1]!.length + 1;
      claims.push({ name: m[2]!, span: { text: m[2]!, line: i + 1, column, endColumn: column + m[2]!.length }, how: 'env-file' });
    }
    // dotenv-expand: `URL=http://${HOST}:${PORT}` reads HOST and PORT.
    for (const r of line.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) refs.add(r[1]!);
  }
  return { claims, refs };
}

const ENV_CONTEXT = /\benv(?:ironment)?[ -]?var(?:iable)?s?\b|\.env\b|\benvironment\b|\benv\b/i;
const ENV_EXPLICIT = /\benv(?:ironment)?[ -]?var(?:iable)?s?\b|\.env\b/i;

/** The variable an explicit read in prose names: `process.env.X`, `os.environ["X"]`, `$X`, `${X}`, `%X%`. */
function explicitName(t: string): string | undefined {
  const m =
    /^process\.env(?:\.|\[['"`])([A-Za-z_]\w*)['"`\]]*$/.exec(t) ??
    /^import\.meta\.env\.([A-Za-z_]\w*)$/.exec(t) ??
    /^(?:os\.)?environ(?:\[|\.get\()\s*['"]([A-Za-z_]\w*)['"].*$/.exec(t) ??
    /^(?:os\.)?getenv\(\s*['"]([A-Za-z_]\w*)['"].*$/.exec(t) ??
    /^Deno\.env\.get\(\s*['"]([A-Za-z_]\w*)['"]\)$/.exec(t) ??
    /^\$\{?([A-Z][A-Z0-9_]*)\}?$/.exec(t) ??
    /^%([A-Z][A-Z0-9_]*)%$/.exec(t) ??
    /^\$env:([A-Za-z_]\w*)$/.exec(t);
  return m?.[1];
}

/** Leading `X=v Y=w` assignments of a shell line (`export X=`, `X=1 cmd`, `set X=`, `$env:X =`, `docker run -e X=`). */
function shellAssignments(line: string): { name: string; at: number }[] {
  const out: { name: string; at: number }[] = [];
  const prompt = /^(\s*(?:\$|>|PS>|%|#(?=\s*export\b))?\s*)/.exec(line)![1]!.length;
  const body = line.slice(prompt);
  if (/^#/.test(body)) return out;
  let m = /^(export|set|setenv|declare\s+-x)\s+([A-Za-z_]\w*)(\s*=|\s+\S|$)/.exec(body);
  if (m) {
    out.push({ name: m[2]!, at: prompt + body.indexOf(m[2]!, m[1]!.length) });
    return out;
  }
  m = /^\$env:([A-Za-z_]\w*)\s*=/.exec(body);
  if (m) return [{ name: m[1]!, at: prompt + 5 }];
  // `X=1 Y=2 cmd args` or a bare `X=1`.
  let rest = body;
  let offset = prompt;
  for (;;) {
    const a = /^([A-Z_][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S*)(\s+|$)/.exec(rest);
    if (!a) break;
    out.push({ name: a[1]!, at: offset });
    offset += a[0].length;
    rest = rest.slice(a[0].length);
  }
  for (const d of line.matchAll(/(?:^|\s)(?:-e|--env)(?:\s+|=)([A-Z_][A-Z0-9_]*)(?==|\s|$)/g)) out.push({ name: d[1]!, at: d.index! + d[0].lastIndexOf(d[1]!) });
  return out;
}

/** Split a Markdown table row into cells with their start columns (0-based), `|` inside code spans kept. */
function tableCells(line: string): { text: string; at: number }[] {
  const cells: { text: string; at: number }[] = [];
  let start = 0;
  let inCode = false;
  const body = line.trimEnd();
  let k = 0;
  if (body.trimStart().startsWith('|')) {
    k = body.indexOf('|') + 1;
    start = k;
  }
  for (; k <= body.length; k++) {
    const c = body[k];
    if (c === '`') inCode = !inCode;
    if ((c === '|' && !inCode && body[k - 1] !== '\\') || k === body.length) {
      if (k === body.length && body.endsWith('|')) break;
      cells.push({ text: body.slice(start, k), at: start });
      start = k + 1;
    }
  }
  return cells;
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/** Variables a docs page documents: env tables, shell assignments, `.env` blocks, code spans about the environment, Sphinx `envvar`. */
export function docEnvClaims(doc: ScannedDoc): EnvClaim[] {
  const out: EnvClaim[] = [];
  // `PIP_*`, `STALEPROOF_<NAME>`: a family of names, not one variable.
  const at = (name: string, line: number, col0: number, how: EnvClaim['how']) => {
    if (!name.endsWith('_')) out.push({ name, span: { text: name, line, column: col0 + 1, endColumn: col0 + 1 + name.length }, how });
  };
  const fenced = new Set<number>();
  for (const f of doc.fences) {
    fenced.add(f.line);
    for (const l of f.lines) fenced.add(l.line);
    fenced.add((f.lines.at(-1)?.line ?? f.line) + 1);
  }

  // Env tables: a header cell matching /env|variable/ heads the column of names.
  for (let i = 0; i + 1 < doc.lines.length; i++) {
    if (fenced.has(i + 1) || !doc.lines[i]!.includes('|') || !TABLE_DELIMITER.test(doc.lines[i + 1]!)) continue;
    const header = tableCells(doc.lines[i]!);
    const col = header.findIndex((c) => /env|variable/i.test(c.text));
    if (col < 0) continue;
    const strict = !/env/i.test(header[col]!.text);
    for (let j = i + 2; j < doc.lines.length && doc.lines[j]!.includes('|') && doc.lines[j]!.trim(); j++) {
      const cell = tableCells(doc.lines[j]!)[col];
      if (!cell) continue;
      for (const m of cell.text.matchAll(/`?\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?`?/g)) {
        const name = m[1]!;
        if (!UPPER.test(name) || name.length < 2 || (strict && !name.includes('_'))) continue;
        at(name, j + 1, cell.at + m.index! + m[0].indexOf(name), 'table');
      }
      i = j;
    }
  }

  // Shell blocks: `export X=`, `X=1 cmd`; `.env` blocks: `X=1` lines.
  for (const f of doc.fences) {
    const lines = f.lines.filter((l) => l.text.trim() && !/^\s*(#|\/\/)/.test(l.text) || /^\s*#\s*export\s/.test(l.text));
    const dotenv = ['env', 'dotenv', '.env', 'properties', 'ini', 'text', 'txt', ''].includes(f.lang) && lines.length > 0 && lines.every((l) => /^\s*(export\s+)?[A-Z_][A-Z0-9_]*=/.test(l.text));
    const shell = isShellLang(f.lang) || (f.lang === '' && f.lines.some((l) => /^\s*\$ /.test(l.text)));
    if (!dotenv && !shell) continue;
    for (const l of lines) {
      const raw = doc.lines[l.line - 1] ?? l.text;
      for (const a of shellAssignments(raw)) at(a.name, l.line, a.at, 'shell');
    }
  }

  // Code spans: an explicit read (`process.env.X`, `$X`), an assignment (`X=1`), or a name next to "environment variable".
  for (const s of doc.spans) {
    if (fenced.has(s.line)) continue;
    const line = doc.lines[s.line - 1] ?? '';
    const t = s.text.trim();
    const explicit = explicitName(t);
    if (explicit) {
      at(explicit, s.line, s.column - 1 + s.text.indexOf(explicit), 'prose');
      continue;
    }
    const assigned = shellAssignments(t);
    if (assigned.length && /^(export\s+|set\s+|\$env:)?[A-Za-z_]\w*=/.test(t)) {
      for (const a of assigned) at(a.name, s.line, s.column - 1 + a.at, 'prose');
      continue;
    }
    if (!UPPER.test(t) || t.length < 2) continue;
    const context = line.slice(0, s.column - 2) + line.slice(s.endColumn);
    if (ENV_EXPLICIT.test(context) || (ENV_CONTEXT.test(context) && t.includes('_'))) at(t, s.line, s.column - 1, 'prose');
  }

  // Sphinx: `:envvar:`X`` and `.. envvar:: X`.
  if (/\.rst$/i.test(doc.path)) {
    for (const [i, line] of doc.lines.entries()) {
      for (const m of line.matchAll(/:envvar:`([A-Za-z_]\w*)`/g)) at(m[1]!, i + 1, m.index! + 9, 'prose');
      const d = /^(\s*\.\.\s+envvar::\s+)([A-Za-z_]\w*)/.exec(line);
      if (d) at(d[2]!, i + 1, d[1]!.length, 'prose');
    }
  }
  return out;
}

const CODE_FENCE: Record<string, string> = {
  python: 'x.py', py: 'x.py', python3: 'x.py', pycon: 'x.py', ipython: 'x.py',
  js: 'x.ts', javascript: 'x.ts', ts: 'x.ts', typescript: 'x.ts', jsx: 'x.ts', tsx: 'x.ts', mjs: 'x.ts', cjs: 'x.ts',
  go: 'x.go', rust: 'x.rs', rs: 'x.rs', ruby: 'x.rb', rb: 'x.rb',
};

/**
 * Variables a page's own examples use: read by its code blocks (`os.environ['X']`), or
 * referenced by its commands (`"$X"`, `${X}`). A variable the docs tell readers to set for
 * their own example is not stale even if the repository's code never reads it.
 */
export function docEnvReads(doc: ScannedDoc): Set<string> {
  const out = new Set<string>();
  for (const f of doc.fences) {
    const code = f.lines.map((l) => l.text).join('\n');
    const as = CODE_FENCE[f.lang];
    if (as) for (const r of fileEnv(as, code)?.reads ?? []) out.add(r.name);
    for (const m of code.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)|%([A-Z_][A-Z0-9_]*)%|\$env:([A-Za-z_]\w*)/g)) out.add(m[1] ?? m[2] ?? m[3]!);
  }
  return out;
}

/** Families of names a page describes as a group: `PIP_*`, `SMOLVM_<NAME>`, `APP_{KEY}`. */
export function docFamilies(doc: ScannedDoc): Set<string> {
  const out = new Set<string>();
  for (const line of doc.lines) for (const m of line.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_)(?:\*|<|\{|\.\.\.|\[)/g)) out.add(m[1]!);
  return out;
}

/** Packages a page tells readers to install (`npm i x`, `pip install y`): their variables are theirs. */
export function docInstalls(doc: ScannedDoc): Set<string> {
  const out = new Set<string>();
  const texts = [...doc.spans.map((s) => s.text), ...doc.fences.flatMap((f) => f.lines.map((l) => l.text))];
  for (const t of texts) {
    const m = /\b(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|i|install)|yarn\s+add|bun\s+add|pip3?\s+install|uv\s+(?:add|pip\s+install)|poetry\s+add|cargo\s+add|go\s+get)\s+(.+)$/.exec(t);
    if (!m) continue;
    for (const w of m[1]!.split(/\s+/)) {
      if (!w || w.startsWith('-') || /[$<>|&;]/.test(w)) continue;
      const name = w.replace(/^["']|["']$/g, '').replace(/(?<=.)@[^/]*$/, '').replace(/[\[<>=!~].*$/, '').toLowerCase();
      if (/^[@a-z0-9][\w./@-]*$/.test(name)) out.add(name);
    }
  }
  return out;
}

/** The sentence (or table row, or the paragraph above a code block) a claim sits in, code spans blanked. */
export function claimContext(doc: ScannedDoc, claim: EnvClaim): string {
  const fence = doc.fences.find((f) => f.lines.some((l) => l.line === claim.span.line));
  const lineText = (n: number) => (doc.lines[n - 1] ?? '').replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
  if (fence) {
    const above: string[] = [];
    for (let n = fence.line - 1; n >= 1 && above.length < 4; n--) {
      if (!doc.lines[n - 1]!.trim()) {
        if (above.length) break;
        continue;
      }
      above.unshift(lineText(n));
    }
    return above.join(' ');
  }
  if (claim.how === 'table') return lineText(claim.span.line);
  return sentenceAt(doc, claim.span.line, claim.span.column);
}

/** The sentence of a page's paragraph that holds line:column (sentences wrap across lines), code spans blanked. */
export function sentenceAt(doc: ScannedDoc, line: number, column: number): string {
  const raw = (n: number) => doc.lines[n - 1] ?? '';
  const lineText = (n: number) => raw(n).replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
  // A list item, a table row or a heading starts its own unit.
  const head = (n: number) => /^\s*(?:[-*+]|\d+[.)])\s|^\s*\||^\s*#/.test(raw(n));
  let start = line;
  while (start > 1 && start > line - 3 && !head(start) && raw(start - 1).trim()) start--;
  let end = line;
  while (end < doc.lines.length && end < line + 3 && raw(end + 1).trim() && !head(end + 1)) end++;
  const lines: string[] = [];
  for (let n = start; n <= end; n++) lines.push(lineText(n));
  const text = lines.join(' ');
  const at = lines.slice(0, line - start).join(' ').length + (line > start ? 1 : 0) + column - 1;
  const from = Math.max(text.lastIndexOf('. ', at), text.lastIndexOf('; ', at)) + 1;
  const stop = text.slice(at).search(/[.;](\s|$)/);
  return text.slice(from, stop < 0 ? undefined : at + stop);
}

/**
 * The sentence names the product the variable's prefix stands for (`LANGSMITH_TRACING` in
 * "LangSmith can export traces", `EJENTUM_API_KEY` in "your Ejentum API key"): a proper
 * noun, not one of the repository's own names.
 */
export function namesProduct(name: string, context: string, own: Set<string>): boolean {
  const segs = name.split('_').filter(Boolean);
  const heads = [segs[0]!, segs.slice(0, 2).join('')].filter((h) => h.length >= 3).map((h) => h.toLowerCase());
  if (heads.some((h) => own.has(h))) return false;
  const words = [...context.matchAll(/[A-Za-z][A-Za-z0-9]*/g)];
  return words.some((w, i) => {
    const word = w[0];
    if (!heads.includes(word.toLowerCase())) return false;
    const camel = /[A-Z]/.test(word.slice(1)) && /[a-z]/.test(word);
    const sentenceStart = i === 0 || /[.!?:]\s*$/.test(context.slice(0, w.index!));
    return camel || (/^[A-Z][a-z]/.test(word) && !sentenceStart);
  });
}

/**
 * Names that are the repository's own: its owner and name, its packages (npm, PyPI, Cargo,
 * Go) and top-level Python packages, as lower-case tokens (`pydantic`, `pydantic_ai`, ...).
 */
export async function ownNames(dir: string, paths: string[], repo?: string): Promise<{ tokens: Set<string>; packages: Set<string> }> {
  const out = new Set<string>();
  const packages = new Set<string>();
  const add = (n: string | undefined, pkg = false) => {
    if (!n) return;
    if (pkg) packages.add(n.toLowerCase());
    const name = n.toLowerCase().replace(/^@/, '');
    const parts = name.split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !GENERIC_TOKEN.has(t));
    for (const t of parts) out.add(t);
    const joined = name.replace(/[^a-z0-9]+/g, '');
    if (joined.length >= 3) out.add(joined);
  };
  for (const part of (repo ?? '').split('/')) add(part);
  add(posix.basename(dir));
  for (const p of paths) {
    const m = /^(?:src\/)?([A-Za-z_]\w*)\/__init__\.py$/.exec(p);
    if (m) add(m[1]);
  }
  const manifests = paths.filter((p) => !/(^|\/)(node_modules|vendor|\.venv|venv|site-packages|fixtures?|examples?)\//.test(p) && /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(p));
  await Promise.all(
    manifests.map(async (path) => {
      const text = await readFile(join(dir, path), 'utf8').catch(() => '');
      try {
        if (path.endsWith('package.json')) add((JSON.parse(text) as { name?: string }).name, true);
        else if (path.endsWith('go.mod')) add(/^module\s+(\S+)/m.exec(text)?.[1]?.split('/').pop(), true);
        else {
          const t = parseToml(text) as { project?: { name?: string }; package?: { name?: string }; tool?: { poetry?: { name?: string } } };
          add(t.project?.name ?? t.package?.name ?? t.tool?.poetry?.name, true);
        }
      } catch {
        // no name
      }
    }),
  );
  return { tokens: out, packages };
}

/** The variable is named after one of the repository's own names (`STALEPROOF_HOME`, `FLASK_APP`, `PYDANTIC_AI_X`). */
export function ownPrefix(name: string, own: Set<string>): boolean {
  const segs = name.toLowerCase().split('_').filter(Boolean);
  for (let k = 1; k < segs.length; k++) {
    if (own.has(segs.slice(0, k).join('')) || (k === 1 && own.has(segs[0]!))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// Reads in code

const JS_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|astro)$/;
const PY_EXT = /\.(py|pyi)$/;
export type CodeLang = 'js' | 'python' | 'go' | 'rust' | 'ruby';

export function codeLang(path: string): CodeLang | undefined {
  if (JS_EXT.test(path) && !/\.d\.[cm]?ts$/.test(path)) return 'js';
  if (PY_EXT.test(path)) return 'python';
  if (path.endsWith('.go')) return 'go';
  if (path.endsWith('.rs')) return 'rust';
  if (path.endsWith('.rb')) return 'ruby';
  return undefined;
}

/**
 * The file with comments (and Python docstrings) replaced by spaces, every offset and line
 * break kept; and where its string literals are (a template literal's `${…}` is code).
 */
export function maskComments(text: string, lang: CodeLang): { masked: string; strings: [number, number][] } {
  const out = text.split('');
  const strings: [number, number][] = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const hash = lang === 'python' || lang === 'ruby';
  for (let k = 0; k < text.length; k++) {
    const c = text[k]!;
    if (lang === 'python' && (text.startsWith('"""', k) || text.startsWith("'''", k))) {
      const q = text.slice(k, k + 3);
      const end = text.indexOf(q, k + 3);
      const stop = end < 0 ? text.length : end + 3;
      // A docstring (a string statement), not a value: blank it.
      const before = text.slice(text.lastIndexOf('\n', k - 1) + 1, k);
      if (/^\s*[rRuU]?$/.test(before)) blank(k, stop);
      else strings.push([k, stop]);
      k = stop - 1;
    } else if ((lang === 'go' || lang === 'rust') && c === "'") {
      // A rune or char literal (`'"'`), or a Rust lifetime (`'static`): never a string.
      const ch = /^'(?:\\.|[^\\'\n])'/.exec(text.slice(k, k + 4));
      if (ch) k += ch[0].length - 1;
    } else if (c === '`' && lang === 'js') {
      let start = k;
      let j = k + 1;
      for (; j < text.length && text[j] !== '`'; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '$' && text[j + 1] === '{') {
          strings.push([start, j]);
          let depth = 0;
          for (; j < text.length; j++) {
            if (text[j] === '{') depth++;
            else if (text[j] === '}' && --depth === 0) break;
          }
          start = j;
        }
      }
      strings.push([start, j + 1]);
      k = j;
    } else if (c === '"' || c === "'" || (c === '`' && lang === 'go')) {
      // Single and double quotes end at the line (an unclosed quote is an apostrophe or a regex).
      let j = k + 1;
      for (; j < text.length; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === c) break;
        else if (text[j] === '\n' && c !== '`') break;
      }
      strings.push([k, j + 1]);
      k = j;
    } else if (hash && c === '#') {
      const end = text.indexOf('\n', k);
      blank(k, end < 0 ? text.length : end);
      k = end < 0 ? text.length : end;
    } else if (!hash && c === '/' && text[k + 1] === '/') {
      const end = text.indexOf('\n', k);
      blank(k, end < 0 ? text.length : end);
      k = end < 0 ? text.length : end;
    } else if (!hash && c === '/' && text[k + 1] === '*') {
      const end = text.indexOf('*/', k + 2);
      blank(k, end < 0 ? text.length : end + 2);
      k = end < 0 ? text.length : end + 1;
    }
  }
  return { masked: out.join(''), strings };
}

/** Literal parts of a computed name: `` `STALEPROOF_${n}` `` → STALEPROOF_, `"APP_" + k` → APP_, `f"{p}_KEY"` → _KEY. */
export function fragmentsOf(expr: string): string[] {
  const out: string[] = [];
  for (const m of expr.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
    for (const piece of m[2]!.split(/\$\{[^}]*\}|\{[^}]*\}/)) if (/^[A-Za-z0-9_]{2,}$/.test(piece) && /[A-Z]/.test(piece)) out.push(piece);
  }
  return out;
}

/** Index of the bracket closing the one at `open` (same kind), or -1. */
function closeAt(text: string, open: number): number {
  const pair: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const want = pair[text[open]!]!;
  let depth = 0;
  for (let k = open; k < text.length && k < open + 400; k++) {
    const c = text[k]!;
    if (c === '"' || c === "'" || c === '`') {
      const end = text.indexOf(c, k + 1);
      if (end < 0) return -1;
      k = end;
    } else if (c === text[open]) depth++;
    else if (c === want && --depth === 0) return k;
  }
  return -1;
}

/** The first argument of a call's argument text (up to a top-level comma). */
function firstArg(inner: string): string {
  let depth = 0;
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k]!;
    if (c === '"' || c === "'" || c === '`') {
      const end = inner.indexOf(c, k + 1);
      if (end < 0) break;
      k = end;
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) return inner.slice(0, k).trim();
  }
  return inner.trim();
}

/** A computed read: what its name may be. */
export interface DynamicRead {
  /**
   * `name`: keyed by a variable (`process.env[v]`), whose values come from the code;
   * `computed`: an expression (its literal `fragments` say what names it builds);
   * `iterate`: the whole environment walked (`Object.keys(process.env)`, `os.environ.items()`);
   * `splat`: the environment as keyword arguments (`Settings(**os.environ)`).
   */
  kind: 'name' | 'computed' | 'iterate' | 'splat';
  key?: string;
  fragments: string[];
  line: number;
  text: string;
}

/** What one code file does with the environment. */
export interface FileEnv {
  reads: EnvRead[];
  dynamic: DynamicRead[];
  /** Field names become variable names (pydantic `BaseSettings`, clap `#[arg(env)]`, envconfig), or names are upper-cased. */
  derived: boolean;
  /** `env_prefix="APP_"`, `envvar_prefix="APP"`: prefixes derived names carry. */
  prefixes: string[];
  /** `const KEY = "FOO_URL"`: string constants a keyed read may use. */
  constants: Map<string, string>;
  /** Prefix- and suffix-like literals (`"APP_"`, `'_API_KEY'`): what a keyed or iterating read may build names from. */
  fragments: string[];
  /** Names the code sets itself (`process.env.X = …`, `os.environ["X"] = …`, an env object's `X:` key). */
  sets: string[];
  /** Families of names the code matches by pattern (`UV_\w+`, `startsWith("APP_")`): passed on or read as a group. */
  families: string[];
}

function lineAt(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let k = text.indexOf('\n'); k >= 0 && k < index; k = text.indexOf('\n', k + 1)) {
    line++;
    last = k;
  }
  return { line, column: index - last };
}

/**
 * Every environment read of a code file. Reads are found in its comment-masked form, never
 * inside a string, so commented-out code, docstrings and messages read nothing; a write
 * (`process.env.X = 1`, `os.environ["X"] = "1"`, `delete process.env.X`) is not a read.
 */
export function fileEnv(path: string, text: string): FileEnv | undefined {
  const lang = codeLang(path);
  if (!lang) return undefined;
  const { masked: src, strings } = maskComments(text, lang);
  const inString = (i: number) => {
    let lo = 0;
    let hi = strings.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [a, b] = strings[mid]!;
      if (i < a) hi = mid - 1;
      else if (i >= b) lo = mid + 1;
      else return true;
    }
    return false;
  };
  const out: FileEnv = { reads: [], dynamic: [], derived: false, prefixes: [], constants: new Map(), fragments: [], sets: [], families: [] };
  const read = (name: string, index: number) => {
    const { line, column } = lineAt(src, index);
    out.reads.push({ name, line, column, endColumn: column + name.length });
  };
  const dyn = (d: Omit<DynamicRead, 'line'>, index: number) => out.dynamic.push({ ...d, line: lineAt(src, index).line });
  const written = (start: number, end: number) => /^\s*=(?![=>])/.test(src.slice(end, end + 4)) || /\bdelete\s+$/.test(src.slice(Math.max(0, start - 9), start)) || /\bdel\s+$/.test(src.slice(Math.max(0, start - 6), start));
  /** An access `X[` or `f(` at `open`, the match starting at `start`: a literal name, a variable, or an expression. */
  const keyed = (start: number, open: number) => {
    const close = closeAt(src, open);
    if (close < 0 || (src[open] === '[' && written(start, close + 1))) return;
    const inner = src.slice(open + 1, close);
    const arg = src[open] === '(' ? firstArg(inner) : inner.trim();
    const lit = /^[rRbB]?(["'`])([A-Za-z_][A-Za-z0-9_]*)\1$/.exec(arg);
    if (lit) return read(lit[2]!, open + 1 + inner.indexOf(lit[2]!));
    // A variable, a constant path (`codex_core::spawn::HOME_VAR`), a reference (`&var`).
    const key = arg.replace(/^[&*]+\s*(?:mut\s+)?/, '').replace(/(?:\.(?:clone|as_str|as_ref|to_string|to_owned)\(\))+$/, '');
    if (/^[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*$/.test(key)) return dyn({ kind: 'name', key: key.split(/\.|::/).pop()!, fragments: [], text: src.slice(start, close + 1) }, start);
    dyn({ kind: 'computed', fragments: fragmentsOf(arg), text: src.slice(start, close + 1) }, start);
  };
  const each = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    for (const m of src.matchAll(re)) if (!inString(m.index!)) fn(m);
  };
  /** The statement around an iteration, for the prefixes it filters by. */
  const stmt = (i: number) => {
    const end = src.indexOf('\n', i + 160);
    return src.slice(i, end < 0 ? undefined : end);
  };
  const affix = (f: string) => /^[A-Z][A-Z0-9]*_$|^_[A-Z0-9_]*[A-Z0-9]$/.test(f);

  if (lang === 'js') {
    const ENV = String.raw`(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|Bun\s*\.\s*env)`;
    each(new RegExp(String.raw`\b${ENV}\s*(?:\?\.|!)?\s*\.\s*([A-Za-z_$][\w$]*)`, 'g'), (m) => {
      if (written(m.index!, m.index! + m[0].length)) return;
      read(m[1]!, m.index! + m[0].length - m[1]!.length);
    });
    each(new RegExp(String.raw`\b${ENV}\s*(?:\?\.)?\s*\[`, 'g'), (m) => keyed(m.index!, m.index! + m[0].length - 1));
    each(/\bDeno\s*\.\s*env\s*\.\s*get\s*\(/g, (m) => keyed(m.index!, m.index! + m[0].length - 1));
    // `env[...]` on an object named env (a parameter defaulting to process.env, a copy of it).
    each(/(?<![\w$.])env\s*\[/g, (m) => {
      const open = m.index! + m[0].length - 1;
      const close = closeAt(src, open);
      if (close < 0 || written(m.index!, close + 1)) return;
      const inner = src.slice(open + 1, close).trim();
      if (/^(["'`])[A-Za-z_]\w*\1$/.test(inner)) return;
      if (/^[A-Za-z_$][\w$.]*$/.test(inner)) dyn({ kind: 'name', key: inner.split('.').pop()!, fragments: [], text: src.slice(m.index!, close + 1) }, m.index!);
      else dyn({ kind: 'computed', fragments: fragmentsOf(inner), text: src.slice(m.index!, close + 1) }, m.index!);
    });
    // `const { A, B: b, C = 1 } = process.env`
    each(new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${ENV}\b`, 'g'), (m) => {
      const start = m.index! + 1;
      for (const p of m[1]!.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)/g)) if (!p[0].includes('...')) read(p[1]!, start + p.index! + p[0].indexOf(p[1]!));
    });
    each(/\bObject\s*\.\s*(?:keys|entries|values)\s*\(\s*process\s*\.\s*env\s*\)|\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+in\s+process\s*\.\s*env\b|\bDeno\s*\.\s*env\s*\.\s*toObject\s*\(/g, (m) =>
      dyn({ kind: 'iterate', fragments: fragmentsOf(stmt(m.index!)).filter(affix), text: m[0] }, m.index!),
    );
    each(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(["'`])([A-Za-z_][A-Za-z0-9_]*)\2/g, (m) => out.constants.set(m[1]!, m[3]!));
    if (/\.toUpperCase\s*\(/.test(src)) out.derived = true;
  } else if (lang === 'python') {
    // `environ` alone is the WSGI environ dict unless the file imports it from `os`.
    const bare = /^\s*from\s+os\s+import\s+[^\n]*\b(environ|getenv)\b/m.test(src);
    const os = bare ? String.raw`(?:(?<![\w.])|\bos\s*\.\s*)` : String.raw`\bos\s*\.\s*`;
    const at = (re: string) => new RegExp(re.replace(/OS/g, os), 'g');
    each(at(String.raw`OSenviron\s*\[`), (m) => keyed(m.index!, m.index! + m[0].length - 1));
    each(at(String.raw`(?:OSenviron\s*\.\s*(?:get|pop|setdefault)|OSgetenvb?)\s*\(`), (m) => keyed(m.index!, m.index! + m[0].length - 1));
    // `"X" in os.environ`
    for (const m of src.matchAll(at(String.raw`(["'])([A-Za-z_][A-Za-z0-9_]*)\1\s+(?:not\s+)?in\s+OSenviron\b`))) {
      if (!inString(m.index! + m[0].length - 1)) read(m[2]!, m.index! + 1);
    }
    each(at(String.raw`\bfor\s+[\w\s,()]+\s+in\s+OSenviron\b|OSenviron\s*\.\s*(?:items|keys|values|copy)\s*\(`), (m) =>
      dyn({ kind: 'iterate', fragments: fragmentsOf(stmt(m.index!)).filter(affix), text: m[0] }, m.index!),
    );
    // `Settings(**os.environ)`; `{**os.environ, "X": "1"}` only copies it (for a child process).
    each(at(String.raw`\(\s*\*\*\s*OSenviron\b`), (m) => dyn({ kind: 'splat', fragments: [], text: m[0] }, m.index!));
    if (/\bBaseSettings\b|\.upper\s*\(/.test(src)) out.derived = true;
    for (const m of src.matchAll(/\benv(?:var)?_prefix\s*[=:]\s*[rRbB]?(["'])([^"']*)\1/g)) out.prefixes.push(m[2]!.endsWith('_') || !m[2] ? m[2]! : `${m[2]}_`);
    each(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[\w.[\], ]+)?=\s*[rRbB]?(["'])([A-Za-z_][A-Za-z0-9_]*)\2\s*$/gm, (m) => out.constants.set(m[1]!, m[3]!));
  } else if (lang === 'go') {
    each(/\bos\s*\.\s*(?:Getenv|LookupEnv)\s*\(/g, (m) => keyed(m.index!, m.index! + m[0].length - 1));
    each(/\bos\s*\.\s*Environ\s*\(\s*\)/g, (m) => dyn({ kind: 'iterate', fragments: fragmentsOf(stmt(m.index!)).filter(affix), text: m[0] }, m.index!));
    if (/\benvconfig\s*\.\s*Process\b|strings\s*\.\s*ToUpper\s*\(/.test(src)) out.derived = true;
    each(/\b([A-Za-z_]\w*)\s*(?:string\s*)?=\s*"([A-Za-z_][A-Za-z0-9_]*)"/g, (m) => out.constants.set(m[1]!, m[2]!));
  } else if (lang === 'rust') {
    each(/\b(?:std\s*::\s*)?env\s*::\s*(?:var|var_os)\s*\(|\b(?:option_)?env!\s*\(/g, (m) => keyed(m.index!, m.index! + m[0].length - 1));
    each(/\benv\s*::\s*vars(?:_os)?\s*\(\s*\)/g, (m) => dyn({ kind: 'iterate', fragments: fragmentsOf(stmt(m.index!)).filter(affix), text: m[0] }, m.index!));
    // clap: `#[arg(long, env)]` names the variable after the field.
    if (/#\[\s*(?:arg|clap)\s*\([^\]]*\benv\b(?!\s*=)/.test(src) || /\.to_uppercase\s*\(/.test(src)) out.derived = true;
    each(/\b(?:const|static)\s+([A-Z_][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/g, (m) => out.constants.set(m[1]!, m[2]!));
  } else if (lang === 'ruby') {
    each(/\bENV\s*(?:\[|\.fetch\s*\()/g, (m) => keyed(m.index!, m.index! + m[0].length - 1));
    if (/\.upcase\b/.test(src)) out.derived = true;
  }
  if (out.dynamic.length) {
    for (const [a, b] of strings) {
      const s = text.slice(a, b).replace(/^[`'"]|[`'"]$/g, '').replace(/^\}/, '');
      if (affix(s)) out.fragments.push(s);
    }
  }
  const SET = /\b(?:process\s*\.\s*env\s*\.\s*([A-Za-z_]\w*)|(?:process\s*\.\s*env|os\s*\.\s*environ)\s*\[\s*["'`]([A-Za-z_]\w*)["'`]\s*\])\s*=(?![=>])/g;
  for (const m of src.matchAll(SET)) out.sets.push(m[1] ?? m[2]!);
  for (const m of src.matchAll(/\b(?:set_var|Setenv|putenv|setdefault)\s*\(\s*["']([A-Za-z_]\w*)["']/g)) out.sets.push(m[1]!);
  for (const m of src.matchAll(/(?<![\w$.])["']?([A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9])["']?\s*:(?!:)/g)) out.sets.push(m[1]!);
  for (const m of src.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_)(?:\\w|\.\*|\[[^\]]*\][*+])/g)) out.families.push(m[1]!);
  for (const m of src.matchAll(/\b(?:startsWith|startswith|HasPrefix|starts_with|start_with\?)\s*\(\s*(?:\w+\s*,\s*)?["'`]([A-Z][A-Z0-9_]*_)["'`]/g)) out.families.push(m[1]!);
  return out;
}

/** `FOO_BAR` → `foobar`, `fooBar` → `foobar`, `foo_bar` → `foobar`: how derived names compare. */
export function looseName(name: string): string {
  return name.replace(/_/g, '').toLowerCase();
}
