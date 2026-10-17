import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import type { Checkout } from '../src/indexer/repo.js';
import { diffRange } from '../src/pr/changes.js';
import { recordPullRequest } from '../src/pr/ingest.js';
import { ensureNodeEnv, importedPackages, isJsFragmentFailure, jsErrorLine, jsModuleFile, jsSkipReason, prepareJsExample, runJsInSandbox } from '../src/runner/js.js';
import { runExampleTool } from '../src/tools/run-example.js';
import type { ToolContext } from '../src/tools/types.js';
import { fakePr, FIXTURES, gitIn, testConfig, testGraph } from './helpers.js';

const SCRATCH = 6380; // the test FalkorDB started by global setup (only PING is sent to it here)

describe('preparing JS/TS examples', () => {
  it('skips what cannot run honestly, with the reason', () => {
    expect(jsSkipReason('echo hi', 'bash')).toBe('not JavaScript or TypeScript (bash)');
    expect(jsSkipReason("import { openai } from '@ai-sdk/openai';\nawait generateText({ model: openai('gpt-4o') });", 'ts')).toMatch(/^needs an LLM provider/);
    expect(jsSkipReason('document.querySelector("#app")', 'js')).toBe('runs in a browser (uses document/window)');
    expect(jsSkipReason("const s = readFileSync('data.csv', 'utf8');", 'js')).toBe('reads a local file the docs do not provide (data.csv)');
    expect(jsSkipReason("const c = new Client({ apiKey: '<your-api-key>' });", 'js')).toMatch(/^contains placeholders/);
    expect(jsSkipReason("await fetch('https://api.example.com/x');", 'js')).toBe('calls an external service');
    expect(jsSkipReason('app.listen(3000);', 'js')).toBe('starts a server or a timer (it never exits on its own)');
    expect(jsSkipReason('const App = () => <div>hi</div>;', 'jsx')).toBe('renders JSX (needs a UI framework to run)');
    expect(jsSkipReason("import { greet } from '@acme/hello';\nconsole.log(greet('x'));", 'js')).toBeUndefined();
  });

  it('stitches a fragment after the page’s earlier blocks, each import once', () => {
    const earlier = [
      { id: 'p:0', lang: 'js', code: "import { greet } from '@acme/hello';\nconst a = greet('a');" },
      { id: 'p:1', lang: 'ts', code: "import { greet } from '@acme/hello';\nconst b: string = greet('b');" },
      { id: 'p:2', lang: 'bash', code: 'npm i @acme/hello' },
    ];
    const p = prepareJsExample({ id: 'p:3', lang: 'js', code: 'console.log(a, b);' }, earlier);
    expect(p.stitched).toEqual(['p:0', 'p:1']);
    expect(p.lang).toBe('typescript');
    expect(p.code.match(/import \{ greet \}/g)).toHaveLength(1);
    expect(prepareJsExample({ id: 'p:4', lang: 'js', code: "const { greet } = require('@acme/hello');" }, earlier).stitched).toEqual([]);
  });

  it('runs ES modules as such, CommonJS with an async wrapper for top-level await', () => {
    expect(jsModuleFile("import x from 'y';", 'ts').file).toBe('example.mts');
    expect(jsModuleFile('console.log(1)', 'js').file).toBe('example.mjs');
    const cjs = jsModuleFile("const x = require('y');\nawait x.go();", 'js');
    expect(cjs.file).toBe('example.cjs');
    expect(cjs.code).toMatch(/^\(async \(\) => \{\n/);
    expect(importedPackages("import a from '@acme/hello/sub';\nconst b = require('falkordb');\nimport('node:fs');\nimport fs from 'fs';\nimport './local.js';")).toEqual(['@acme/hello', 'falkordb']);
  });

  it('reads Node’s error output', () => {
    const stderr = "file:///x/example.mjs:2\ng.roQuery('x');\n  ^\n\nTypeError: g.roQuery is not a function\n    at file:///x/example.mjs:2:3\n\nNode.js v22.14.0\n";
    expect(jsErrorLine(stderr)).toBe('TypeError: g.roQuery is not a function');
    expect(isJsFragmentFailure('console.log(db.x);', 'ReferenceError: db is not defined')).toBe(true);
    expect(isJsFragmentFailure('const db = connect();\nconsole.log(db.x);', 'ReferenceError: db is not defined')).toBe(false);
    expect(isJsFragmentFailure("import { db } from 'x';", 'ReferenceError: db is not defined')).toBe(false);
  });
});

describe('Node sandbox', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'staleproof-node-'));
    await writeFile(join(dir, 'package.json'), '{"private":true,"type":"module"}');
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('answers localhost:6379 with the scratch FalkorDB, also for TypeScript', async () => {
    const code = [
      "import { connect } from 'node:net';",
      'const reply: string = await new Promise((resolve, reject) => {',
      "  const s = connect(6379, 'localhost', () => s.write('*1\\r\\n$4\\r\\nPING\\r\\n'));",
      "  s.once('data', (d) => { resolve(d.toString().trim()); s.end(); });",
      "  s.once('error', reject);",
      '});',
      'console.log(reply);',
    ].join('\n');
    const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const r = await runJsInSandbox({ dir, tsx }, code, 'ts', { scratchPort: SCRATCH, timeoutMs: 30_000 });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('+PONG');
  });

  it('refuses every other connection and DNS lookup, fetch included', async () => {
    const code = [
      "import net from 'node:net';",
      "import dns from 'node:dns/promises';",
      'for (const [host, port] of [["1.1.1.1", 80], ["127.0.0.1", 22]]) {',
      '  await new Promise((resolve) => {',
      '    const s = net.connect(port, host);',
      "    s.on('connect', () => { console.log('connected', port); s.end(); resolve(); });",
      "    s.on('error', (e) => { console.log('refused', port, e.message.includes('Staleproof sandbox')); resolve(); });",
      '  });',
      '}',
      "try { await dns.lookup('example.com'); } catch (e) { console.log('dns', e.message.includes('DNS is disabled')); }",
      "try { await fetch('http://93.184.216.34/'); } catch (e) { console.log('fetch', String(e.cause?.message ?? e.message).includes('Staleproof sandbox')); }",
    ].join('\n');
    const r = await runJsInSandbox({ dir }, code, 'js', { scratchPort: SCRATCH, timeoutMs: 30_000 });
    expect(r.stdout.trim().split('\n')).toEqual(['refused 80 true', 'refused 22 true', 'dns true', 'fetch true']);
  });

  it('enforces the timeout and inherits no secrets', async () => {
    process.env.STALEPROOF_TEST_SECRET = 'nope';
    const env = await runJsInSandbox({ dir }, 'console.log(String(process.env.STALEPROOF_TEST_SECRET));', 'js', { scratchPort: SCRATCH, timeoutMs: 20_000 });
    expect(env.stdout.trim()).toBe('undefined');
    const slow = await runJsInSandbox({ dir }, 'await new Promise((r) => setTimeout(r, 30_000));', 'js', { scratchPort: SCRATCH, timeoutMs: 1500 });
    expect(slow.timedOut).toBe(true);
  });
});

describe('run_example for JS/TS (Node sandbox, FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let ctx: ToolContext;
  let root: string;
  let checkouts: Checkout[];
  const pr = fakePr({ owner: 'acme', repo: 'hello', fullName: 'acme/hello', url: 'https://github.com/acme/hello/pull/3', number: 3, title: 'Rename greet to welcome' });

  beforeAll(async () => {
    ({ graph, done } = await testGraph('jsrun'));
    root = await mkdtemp(join(tmpdir(), 'staleproof-jsorg-'));
    checkouts = [];
    for (const name of ['hello', 'hello-docs', 'broken']) {
      const dir = join(root, name);
      await cp(join(FIXTURES, 'ts-run', name), dir, { recursive: true });
      gitIn(dir, 'init', '-q', '-b', 'main');
      gitIn(dir, 'add', '-A');
      gitIn(dir, 'commit', '-q', '-m', 'init');
      checkouts.push({ repo: `acme/${name}`, dir, sha: gitIn(dir, 'rev-parse', 'HEAD') });
    }
    await indexOrg(graph, checkouts);
    const hello = checkouts[0]!;
    const file = join(hello.dir, 'src', 'index.js');
    await writeFile(file, (await readFile(file, 'utf8')).replace('export function greet(', 'export function welcome('));
    gitIn(hello.dir, 'commit', '-q', '-am', 'rename');
    await recordPullRequest(graph, pr, await diffRange(hello.dir, hello.repo, hello.sha, gitIn(hello.dir, 'rev-parse', 'HEAD')));
    const config = testConfig({ home: join(root, 'home'), scratch: { host: '127.0.0.1', port: 6393, managed: true } });
    ctx = { graph, config, checkouts: Object.fromEntries(checkouts.map((c) => [c.repo, c.dir])) };
  }, 240_000);
  afterAll(async () => {
    await done();
    await rm(root, { recursive: true, force: true });
  });

  it('proves the PR breaks a JavaScript example: built from source, passes before, fails after', async () => {
    const r = await runExampleTool.run(ctx, { example_id: 'acme/hello-docs:docs/usage.md:0', pr_url: pr.url });
    const [before, after] = r.data.runs;
    expect(before!.status).toBe('pass');
    expect(before!.stdout.trim()).toBe('Hello, docs!');
    expect(after!.status).toBe('fail');
    expect(after!.error).toBe("SyntaxError: The requested module '@acme/hello' does not provide an export named 'greet'");
    expect(r.data.verdict).toBe('breaks');
  }, 240_000);

  it('runs TypeScript through tsx, with the scratch FalkorDB on localhost:6379', async () => {
    const r = await runExampleTool.run(ctx, { example_id: 'acme/hello-docs:docs/usage.md:1' });
    expect(r.data.runs[0]!.status).toBe('pass');
    expect(r.data.runs[0]!.stdout.trim()).toBe('+PONG');
  }, 240_000);

  it('stitches a fragment after the page’s earlier blocks', async () => {
    const r = await runExampleTool.run(ctx, { example_id: 'acme/hello-docs:docs/usage.md:2' });
    expect(r.data.runs[0]).toMatchObject({ status: 'pass', stitched: ['acme/hello-docs:docs/usage.md:0', 'acme/hello-docs:docs/usage.md:1'] });
    expect(r.data.runs[0]!.stdout.trim().split('\n')).toEqual(['Hello, docs!', '+PONG', 'Hello, fragment!']);
  }, 240_000);

  it('records examples it cannot run honestly, and packages that do not build, as skipped', async () => {
    const external = await runExampleTool.run(ctx, { example_id: 'acme/hello-docs:docs/usage.md:3' });
    expect(external.summary).toBe('Not run: calls an external service.');
    const broken = await runExampleTool.run(ctx, { example_id: 'acme/hello-docs:docs/usage.md:4' });
    expect(broken.data.verdict).toBe('skipped');
    expect(broken.data.runs[0]!.reason).toMatch(/^the build script of @acme\/broken failed:\n.*cannot build/s);
  }, 240_000);

  it('builds once per commit set and reuses the sandbox', async () => {
    const hello = checkouts[0]!;
    const a = await ensureNodeEnv(ctx.config.home, [{ ...hello, sha: hello.sha }], ['@acme/hello']);
    const b = await ensureNodeEnv(ctx.config.home, [{ ...hello, sha: hello.sha }], ['@acme/hello']);
    expect(b).toEqual(a);
    expect(a.installed).toEqual([`acme/hello@${hello.sha}`]);
  });
});
