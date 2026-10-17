import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pageCommands, tokenize } from '../src/lint/check-commands.js';
import { lintRepo, workingFiles } from '../src/lint/engine.js';
import { RepoFacts } from '../src/lint/facts.js';
import { closeNames, patternMatches, scriptFacts } from '../src/lint/facts-scripts.js';
import { scanClaims } from '../src/lint/scan.js';
import type { RuleId } from '../src/lint/types.js';

/** A repository on disk (no git: every non-hidden file is part of it). */
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-commands-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

async function facts(dir: string): Promise<RepoFacts> {
  return new RepoFacts(dir, new Set(await workingFiles(dir)));
}

/** `path:line:col subject | message` of every command-missing finding. */
async function lint(files: Record<string, string>, rules: RuleId[] = ['command-missing']): Promise<string[]> {
  const dir = await repo(files);
  const r = await lintRepo({ dir, repo: 'acme/demo', examples: false, rules });
  return r.findings.map((f) => `${f.path}:${f.line}:${f.column} ${f.subject} | ${f.message}`);
}

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'demo', scripts, ...extra });

describe('commands in docs, parsed like a shell', () => {
  it('splits chains, strips prompts, assignments and wrappers, joins continuations, skips comments, output and heredocs', async () => {
    const dir = await repo({ 'packages/web/package.json': '{}', 'docs/x.md': '' });
    const doc = scanClaims(
      'docs/x.md',
      [
        'Run `npm run build` first.', // 1
        '', // 2
        '```console', // 3
        '$ FOO=1 sudo -E npm run lint && cd packages/web && npm test # comment', // 4
        '$ make \\', // 5
        '>   docs', // 6
        'make: Nothing to be done', // 7
        '```', // 8
        '', // 9
        '```bash', // 10
        'cat <<EOF', // 11
        'npm run inside-heredoc', // 12
        'EOF', // 13
        "yarn workspace web 'build' | tee log.txt 2>&1", // 14
        'pip install "pkg>=1.2" && npx tool@<version> run', // 15
        '```', // 16
      ].join('\n'),
    );
    const cmds = pageCommands(doc, { facts: await facts(dir) }).map((c) => ({
      words: c.words.map((w) => `${w.text}@${w.line}:${w.column}`).join(' '),
      cwd: c.cwd ? `${c.cwd.explicit ? 'cd ' : ''}${c.cwd.dir || '.'}` : null,
      inline: c.inline,
    }));
    expect(cmds).toEqual([
      { words: 'npm@1:6 run@1:10 build@1:14', cwd: 'docs', inline: true },
      { words: 'npm@4:17 run@4:21 lint@4:25', cwd: 'docs', inline: false },
      { words: 'npm@4:52 test@4:56', cwd: 'cd packages/web', inline: false },
      // The `cd` holds for the rest of the block.
      { words: 'make@5:3 docs@6:5', cwd: 'cd packages/web', inline: false },
      { words: 'cat@11:1', cwd: 'docs', inline: false },
      { words: 'yarn@14:1 workspace@14:6 web@14:16 build@14:20', cwd: 'docs', inline: false },
      { words: 'tee@14:30 log.txt@14:34', cwd: 'docs', inline: false },
      { words: 'pip@15:1 install@15:5 pkg>=1.2@15:13', cwd: 'docs', inline: false },
      { words: 'npx@15:27 tool@<version>@15:31 run@15:46', cwd: 'docs', inline: false },
    ]);
  });

  it('keeps quoted words whole, marks variables and substitutions dynamic, and gives up on an unclosed quote', () => {
    const chars = (s: string) => [...s].map((c, i) => ({ c, line: 1, col: i + 1 }));
    const words = tokenize(chars(`npm run "a b" $X "$(echo x)" 'c'd`))!;
    expect(words).toHaveLength(1);
    expect(words[0]!.map((w) => [w.text, w.dynamic])).toEqual([
      ['npm', false],
      ['run', false],
      ['a b', false],
      ['$X', true],
      ['$(echo x)', true],
      ['cd', false],
    ]);
    expect(tokenize(chars(`npm run "open`))).toBeUndefined();
  });
});

describe('script facts', () => {
  it('reads Makefile targets: rules, .PHONY, includes, patterns; computed names and unreadable includes make it open', async () => {
    const dir = await repo({
      Makefile: [
        'include rules.mk',
        'VERSION := 1.0',
        'CFLAGS = -O2',
        'export PATH := bin:$(PATH)',
        '.PHONY: build lint-all',
        'build test: deps ## build things',
        '\tgo build ./...',
        'release-%:',
        '\techo $*',
        'define TEMPLATE',
        'fake-target:',
        'endef',
        'docs: VERSION = 2',
      ].join('\n'),
      'rules.mk': 'install:\n\tcp x y\n',
      'sub/Makefile': '-include $(ENV).mk\nall:\n',
      'gen/Makefile': '$(eval $(call RULES))\n',
    });
    const sf = await scriptFacts(await facts(dir));
    const root = sf.makefiles.get('')!;
    expect([...root.targets].sort()).toEqual(['build', 'deps', 'docs', 'install', 'lint-all', 'test'].filter((t) => t !== 'deps').sort());
    expect(root.patterns).toEqual(['release-%']);
    expect(root.open).toBe(false);
    expect(sf.makefiles.get('sub')!.open).toBe(true);
    expect(sf.makefiles.get('gen')!.open).toBe(true);
    expect(patternMatches('release-%', 'release-1.2')).toBe(true);
    expect(patternMatches('%.o', 'build')).toBe(false);
    expect(patternMatches('%/install', 'bin/install')).toBe(true);
  });

  it('reads justfile recipes, aliases, imports and modules; Taskfile tasks, aliases and included namespaces', async () => {
    const dir = await repo({
      justfile: ["import 'just/extra.just'", 'mod deploy', 'alias b := build', 'set shell := ["bash", "-c"]', 'version := "1"', '[private]', '@build target="x:y" *args:', '    echo', 'test: build', '    echo'].join('\n'),
      'just/extra.just': 'lint:\n    echo\n',
      'Taskfile.yml': [
        "version: '3'",
        'includes:',
        '  docs:',
        '    taskfile: ./docs',
        '    aliases: [d]',
        '  remote: https://example.com/Taskfile.yml',
        'tasks:',
        '  build:',
        '    aliases: [b]',
        '  lint:fix:',
        '    cmds: [echo]',
        "  'start:*':",
        '    cmds: [echo]',
      ].join('\n'),
      'docs/Taskfile.yml': 'version: "3"\ntasks:\n  serve:\n    cmds:\n      - echo\n',
    });
    const sf = await scriptFacts(await facts(dir));
    const j = sf.justfiles.get('')!;
    expect([...j.recipes].sort()).toEqual(['b', 'build', 'lint', 'test']);
    expect([...j.modules]).toEqual(['deploy']);
    expect(j.open).toBe(false);
    const t = sf.taskfiles.get('')!;
    expect([...t.tasks].sort()).toEqual(['b', 'build', 'd', 'd:serve', 'docs', 'docs:serve', 'lint:fix']);
    expect(t.patterns).toEqual(['start:%']);
    // A remote include could define anything.
    expect(t.open).toBe(true);
  });

  it('reads package.json scripts and bins for every package, pyproject scripts, deps and hatch envs, and Python packages', async () => {
    const dir = await repo({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'], scripts: { build: 'tsc' }, bin: { tool: 'dist/cli.js' }, devDependencies: { vitest: '1' } }),
      'packages/web/package.json': JSON.stringify({ name: '@acme/web', scripts: { dev: 'vite' }, bin: 'bin/web.js' }),
      'node_modules/x/package.json': JSON.stringify({ name: 'x', scripts: { evil: 'x' } }),
      'pyproject.toml': '[project]\nname = "acme"\ndependencies = ["Click>=8", "rich"]\n[project.scripts]\nacme = "acme.cli:main"\n[tool.hatch.envs.docs.scripts]\nbuild = "mkdocs build"\n[tool.poetry.scripts]\nlegacy = "acme.old:main"\n',
      'src/acme/__init__.py': '',
      'src/acme/sub/__init__.py': '',
      'cmd/acmectl/main.go': 'package main',
    });
    const sf = await scriptFacts(await facts(dir));
    expect(sf.packages.map((p) => [p.dir, p.name, [...p.scripts.keys()], [...p.bins.keys()]]).sort()).toEqual([
      ['', 'root', ['build'], ['tool']],
      ['packages/web', '@acme/web', ['dev'], ['web']],
    ]);
    const py = sf.pyprojects[0]!;
    expect([...py.scripts.keys()].sort()).toEqual(['acme', 'legacy']);
    expect([...py.deps].sort()).toEqual(['click', 'rich']);
    expect([...py.hatchEnvs]).toEqual([['docs', new Set(['build'])]]);
    expect(sf.pyPackages.get('acme')).toEqual(['src/acme']);
    expect([...sf.ownTools].sort()).toEqual(['acme', 'acmectl', 'legacy', 'tool', 'web']);
  });

  it('suggests close names', () => {
    expect(closeNames('lint:docs', ['lint-docs', 'docs:lint', 'build'])).toEqual(['docs:lint', 'lint-docs']);
    expect(closeNames('tset', ['test', 'build'])).toEqual([]);
    expect(closeNames('biuld', ['build', 'test'])).toEqual(['build']);
  });
});

describe('command-missing', () => {
  it('reports npm, pnpm, yarn and bun scripts that package.json does not define, with the whole command located', async () => {
    const out = await lint({
      'package.json': pkg({ build: 'tsc', 'docs:build': 'x', test: 'vitest' }),
      'README.md': [
        'Run `npm run lint:docs`, `npm run build` and `npm test`.',
        '',
        '```sh',
        'npm run -s docs:serve',
        'pnpm run typecheck',
        'pnpm docs:check',
        'yarn lint',
        'bun run test:e2e',
        'npm start',
        '```',
      ].join('\n'),
    });
    expect(out).toEqual([
      'README.md:1:6 npm run lint:docs | `lint:docs` is not a script in package.json.',
      'README.md:4:1 npm run -s docs:serve | `docs:serve` is not a script in package.json.',
      'README.md:5:1 pnpm run typecheck | `typecheck` is not a script in package.json.',
      'README.md:6:1 pnpm docs:check | `docs:check` is not a script in package.json.',
      'README.md:7:1 yarn lint | `lint` is not a script in package.json.',
      'README.md:8:1 bun run test:e2e | `test:e2e` is not a script in package.json.',
      'README.md:9:1 npm start | `start` is not a script in package.json.',
    ]);
  });

  it('never judges names a dependency binary or a file could have, placeholders, --if-present, or package-manager built-ins', async () => {
    const out = await lint({
      'package.json': pkg({ build: 'tsc' }, { devDependencies: { typecheck: '1' } }),
      'server.js': '',
      'README.md': [
        '```sh',
        'pnpm eslint .',
        'yarn run tsc',
        'pnpm typecheck',
        'bun run index.ts',
        'bun test',
        'npm run <script>',
        'npm run $SCRIPT',
        'npm run my-script',
        'npm run x',
        'npm run docs --if-present',
        'pnpm install && pnpm add -D vitest && yarn dlx create-x && npm ci',
        'npm start',
        'npm run',
        'npx vitest run',
        '```',
      ].join('\n'),
    });
    expect(out).toEqual([]);
  });

  it('reads the package that -w/--workspace, --prefix, --filter, yarn workspace and cd pick', async () => {
    const out = await lint({
      'package.json': pkg({ build: 'tsc' }, { workspaces: ['packages/*'] }),
      'packages/web/package.json': JSON.stringify({ name: '@acme/web', scripts: { dev: 'vite' } }),
      'packages/api/package.json': JSON.stringify({ name: '@acme/api', scripts: { serve: 'node .' } }),
      'CONTRIBUTING.md': [
        '```sh',
        'npm run dev -w @acme/web',
        'npm run serve --workspace=@acme/web',
        'npm --prefix packages/api run serve',
        'pnpm --filter @acme/api dev',
        'pnpm -F ./packages/* build',
        'yarn workspace @acme/web serve',
        'yarn workspace @acme/web lint',
        'cd packages/api && npm run dev',
        'npm run build -ws',
        '```',
      ].join('\n'),
    });
    expect(out).toEqual([
      'CONTRIBUTING.md:3:1 npm run serve | `serve` is not a script in packages/web/package.json.',
      'CONTRIBUTING.md:5:1 pnpm --filter @acme/api dev | `dev` is not a script in packages/api/package.json.',
      // `serve` may be a binary (the `serve` package); `lint` is a script name no package ships.
      'CONTRIBUTING.md:8:1 yarn workspace @acme/web lint | `lint` is not a script in packages/web/package.json.',
      'CONTRIBUTING.md:9:20 npm run dev | `dev` is not a script in packages/api/package.json.',
    ]);
  });

  it('takes the nearest package.json up from the page and the root; a script another package defines is not judged from prose', async () => {
    const out = await lint({
      'package.json': pkg({ build: 'tsc' }),
      'site/package.json': pkg({ preview: 'vite preview' }),
      'examples/app/package.json': pkg({ 'start:dev': 'x' }),
      'site/docs/guide.md': 'Use `npm run preview`, `npm run build`, `npm run start:dev` and `npm run deploy:site`.\n',
    });
    expect(out).toEqual(['site/docs/guide.md:1:66 npm run deploy:site | `deploy:site` is not a script in site/package.json.']);
  });

  it('skips repositories without the manifest, scripts the page defines, the reader\'s project, scaffolded and foreign layouts', async () => {
    expect(await lint({ 'README.md': '`npm run build`, `make docs`, `just x1`, `task t1`\n' })).toEqual([]);
    const out = await lint({
      'package.json': pkg({ build: 'tsc' }),
      'docs/a.md': 'Add this to your package.json:\n\n```json\n{ "scripts": { "docs:check": "staleproof lint" } }\n```\n\nThen `npm run docs:check`.\n',
      'docs/b.md': 'In your project, run `npm run lint`.\n',
      'docs/c.md': '```sh\nnpx create-next-app my-app\ncd my-app\nnpm run dev\n```\n',
      'docs/d.md': '```sh\ncd packages/core\nnpm run test:native\n```\n\n`npm run test:unit`\n',
      'docs/e.md': '```sh\ngit clone https://github.com/other/tool\nnpm run setup\n```\n',
      'docs/f.md': '`npm run compile` was renamed to `npm run build`.\n\nBefore v2:\n\n```sh\nnpm run bundle\n```\n',
      'AGENTS.md': 'In your project, run `npm run lint`.\n',
    });
    // Agent instructions describe this repository, whatever the sentence says.
    expect(out).toEqual(['AGENTS.md:1:23 npm run lint | `lint` is not a script in package.json.']);
  });

  it('follows a clone of this repository (or a fork) into its root', async () => {
    const out = await lint({
      'package.json': pkg({ build: 'tsc' }),
      'CONTRIBUTING.md': '```sh\ngit clone git@github.com:<your username>/demo.git\ncd demo\nnpm run bootstrap\n```\n',
    });
    expect(out).toEqual(['CONTRIBUTING.md:4:1 npm run bootstrap | `bootstrap` is not a script in package.json.']);
  });

  it('reports make targets, honouring -C, variables, files, patterns, generated and open Makefiles', async () => {
    const out = await lint({
      Makefile: '.PHONY: build\nbuild:\n\techo\nrelease-%:\n\techo\n',
      'docs/Makefile': '%: Makefile\n\tsphinx-build $@\n',
      'native/Makefile': 'all:\n',
      'native/configure': '',
      'hello.c': '',
      'README.md': [
        '```sh',
        'make build DEBUG=1',
        'make -j 4 test',
        'make release-2.0',
        'make -C docs html',
        'make hello',
        'make README.md',
        'make -C native install',
        'make TARGET',
        'make -f other.mk x1',
        'make help',
        '```',
        '',
        'Build the docs with `make linkcheck`; `make latexpdf` is not a root target.',
      ].join('\n'),
    });
    expect(out).toEqual([
      // `make -j 4 test`: the finding points at the target.
      'README.md:3:11 make test | `test` is not a target in Makefile.',
      'README.md:11:1 make help | `help` is not a target in Makefile.',
    ]);
  });

  it('reports just recipes and Taskfile tasks (namespaces, aliases, wildcards), and skips runners the repository is', async () => {
    const out = await lint({
      justfile: 'alias b := build\nmod deploy\nbuild:\n    echo\n',
      'Taskfile.yml': "version: '3'\ntasks:\n  serve:\n    cmds: [echo]\n  'gen:*':\n    cmds: [echo]\n",
      'README.md': ['```sh', 'just b', 'just --list', 'just deploy', 'just publish', 'just VAR=1 build', 'task serve gen:api', 'task --list-all', 'task stop', 'task -- serve', '```'].join('\n'),
    });
    expect(out).toEqual([
      'README.md:5:1 just publish | `publish` is not a recipe in justfile.',
      'README.md:9:1 task stop | `stop` is not a task in Taskfile.yml.',
    ]);
    // go-task/task documents `task` itself: its `task deploy` is the reader's.
    expect(await lint({ 'go.mod': 'module github.com/go-task/task/v3\n', 'Taskfile.yml': 'tasks:\n  build:\n    cmds: [go build]\n', 'docs/usage.md': '`task deploy`\n' })).toEqual([]);
    // A page that shows a Taskfile teaches writing one.
    expect(await lint({ 'Taskfile.yml': 'tasks:\n  build:\n    cmds: [x]\n', 'docs/howto.md': '```yaml\ntasks:\n  greet:\n    cmds: [echo hi]\n```\n\nRun `task hello`.\n' })).toEqual([]);
  });

  it('reports `python -m` modules of the repository\'s own packages, never the standard library or other packages', async () => {
    const out = await lint({
      'pyproject.toml': '[project]\nname = "acme"\n',
      'src/acme/__init__.py': '',
      'src/acme/cli.py': '',
      'src/acme/tools/__init__.py': '',
      'src/acme/ns/x.py': '',
      'README.md': ['```sh', 'python -m acme.cli', 'python -m acme.server', 'python3 -m acme', 'uv run python -m acme.tools', 'python -m acme.ns', 'python -m venv .venv', 'python -m pytest', 'python -m http.server', '```'].join('\n'),
    });
    expect(out).toEqual([
      'README.md:3:1 python -m acme.server | `acme.server` is not a module of this repository.',
      'README.md:4:1 python3 -m acme | `acme` is a package without `__main__.py`, so `python -m acme` cannot run it.',
      'README.md:5:8 python -m acme.tools | `acme.tools` is a package without `__main__.py`, so `python -m acme.tools` cannot run it.',
    ]);
  });

  it('judges uv/poetry/hatch run only for names close to the repository\'s own scripts, and hatch environments', async () => {
    const out = await lint({
      'pyproject.toml': '[project]\nname = "acme"\ndependencies = ["acme-tool"]\n[project.scripts]\nacme-serve = "acme.cli:serve"\n[tool.hatch.envs.docs.scripts]\nbuild = "mkdocs build"\n',
      'scripts/release.py': '',
      'README.md': ['```sh', 'uv run acme-server', 'uv run acme-serve', 'uv run pytest -x', 'uv run acme-tool', 'uv run uvicorn app:app', 'poetry run scripts/release.py', 'uv run --with rich python -m acme', 'hatch run docs:build', 'hatch run test:cov', 'hatch run unrelated-tool', '```'].join('\n'),
    });
    expect(out).toEqual([
      'README.md:2:1 uv run acme-server | `acme-server` is not a script of this repository (pyproject.toml [project.scripts]).',
      'README.md:10:1 hatch run test:cov | `test` is not a hatch environment in pyproject.toml (so `cov` cannot run in it).',
    ]);
  });

  it('reads reStructuredText literals and console blocks with exact columns', async () => {
    const out = await lint({
      'package.json': pkg({ build: 'tsc' }),
      'docs/dev.rst': 'Development\n===========\n\nRun ``npm run lint`` first.\n\n.. code-block:: console\n\n    $ npm run build\n    $ npm run fmt:check\n    some output\n',
    });
    expect(out).toEqual([
      'docs/dev.rst:4:7 npm run lint | `lint` is not a script in package.json.',
      'docs/dev.rst:9:7 npm run fmt:check | `fmt:check` is not a script in package.json.',
    ]);
  });

  it('is silenced by a staleproof: ignore comment, like every rule', async () => {
    const out = await lint({ 'package.json': pkg({ build: 'tsc' }), 'README.md': '<!-- staleproof: ignore command-missing -->\n`npm run gone`\n\n`npm run gone-too`\n' });
    expect(out).toEqual(['README.md:4:2 npm run gone-too | `gone-too` is not a script in package.json.']);
  });
});
