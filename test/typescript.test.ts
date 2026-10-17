import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditDocs } from '../src/audit.js';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import { classifyFile } from '../src/indexer/repo.js';
import { packageOf, readManifest, relativeResolver, tsModuleNames, uniquePackages } from '../src/indexer/tsmodules.js';
import { bareModule, extractTs, normalizeType, npmToken } from '../src/indexer/typescript.js';
import { diffWith } from '../src/pr/changes.js';
import { analyzeChanges, contentSource, WORKTREE } from '../src/pr/local.js';
import { FIXTURES, testConfig, testGraph } from './helpers.js';

const TS = join(FIXTURES, 'ts-org');
const MINI_JS = { repo: 'acme/mini-js', dir: join(TS, 'mini-js'), sha: 'fixture' };
const JS_DOCS = { repo: 'acme/js-docs', dir: join(TS, 'js-docs'), sha: 'fixture' };

describe('TypeScript/JavaScript extraction', () => {
  it('names npm modules apart from Python packages', () => {
    expect(npmToken('falkordb')).toBe('js-falkordb');
    expect(bareModule('@acme/minigraph/sub/x')).toBe('js-acme-minigraph.sub.x');
    expect(normalizeType(': Promise<Graph | null>')).toBe('Graph');
    expect(normalizeType('Map<string, Graph[]>')).toBe('Map[string, Graph]');
  });

  it('reads classes, functions, exports, requires, typed bindings and calls', async () => {
    const mod = await extractTs(
      `import { A as B } from './a';
import * as ns from 'pkg';
const { x, y: z } = require('other');
export class C extends B {
  private p: B;
  constructor(public q: ns.Q) { super(); this.r = new B(); }
  get size(): number { return 1; }
  async run(): Promise<B> { return this.p.go(); }
}
export const make = async (n: number) => new C(n);
function local() {}
export { local };
export default C;
export * from './star';
`,
      { module: 'js-pkg.m', path: 'm.ts', resolve: (s) => `js-pkg.${s.replace('./', '')}` },
    );
    expect(mod.lang).toBe('ts');
    expect(mod.defs.map((d) => `${d.kind} ${d.qualname}${d.decorators.length ? ` [${d.decorators}]` : ''}`)).toEqual([
      'module js-pkg.m',
      'class js-pkg.m.C',
      'method js-pkg.m.C.constructor',
      'method js-pkg.m.C.size [property]',
      'method js-pkg.m.C.run',
      'function js-pkg.m.make',
      'function js-pkg.m.local',
    ]);
    expect(mod.defs.find((d) => d.name === 'run')).toMatchObject({ returns: 'B', isAsync: true });
    expect(mod.defs.find((d) => d.name === 'C')!.bases).toEqual(['B']);
    expect(mod.imports.map((i) => `${i.alias}=${i.target}${i.exported ? ' (export)' : ''}`)).toEqual([
      'B=js-pkg.a.A',
      'ns=js-pkg',
      'x=js-other.x',
      'z=js-other.y',
      'default=js-pkg.m.C (export)',
      '*=js-pkg.star (export)',
    ]);
    expect(mod.bindings.map((b) => `${b.scope}:${b.target}${b.annotation ? `:${b.annotation}` : ''}`)).toEqual([
      'js-pkg.m.C:self.p:B',
      'js-pkg.m.C.constructor:q:ns.Q',
      'js-pkg.m.C:self.q:ns.Q',
      'js-pkg.m.C:self.r',
      'js-pkg.m.make:n:number',
    ]);
    expect(mod.calls.map((c) => `${c.scope.split('.').pop()} ${c.text}`)).toEqual(['constructor B', 'run this.p.go', 'make C']);
  });

  it('maps manifests and files to modules, and resolves relative imports', () => {
    const pkg = readManifest('packages/core', JSON.stringify({ name: '@acme/core', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }))!;
    expect(pkg.entries.slice(0, 2)).toEqual(['packages/core/dist/index.ts', 'packages/core/dist/index.tsx']);
    expect(pkg.entries).toContain('packages/core/src/index.ts');
    expect(readManifest('', JSON.stringify({ name: 'site', private: true }))).toBeUndefined();
    // A VS Code extension is not a library anyone imports, even when it shares the package's name.
    expect(readManifest('editors/vscode', JSON.stringify({ name: 'staleproof', main: './dist/extension.cjs', engines: { vscode: '^1.90.0' } }))).toBeUndefined();
    // Two manifests with one name: the shallower one is the package (`examples/` copies, fixtures).
    const twins = uniquePackages([
      readManifest('examples/fork/core', JSON.stringify({ name: '@acme/core' }))!,
      pkg,
      readManifest('', JSON.stringify({ name: 'root' }))!,
    ]);
    expect(twins.map((p) => `${p.name}@${p.dir}`)).toEqual(['@acme/core@packages/core', 'root@']);
    const names = tsModuleNames(['packages/core/src/index.ts', 'packages/core/src/graph/client.ts', 'tools/x.ts'], [pkg]);
    expect([...names].map(([p, n]) => `${p} → ${n.module}`)).toEqual([
      'packages/core/src/index.ts → js-acme-core',
      'packages/core/src/graph/client.ts → js-acme-core.graph.client',
    ]);
    expect(packageOf('tools/x.ts', [pkg])).toBeUndefined();
    expect(relativeResolver('packages/core/src/index.ts', names)('./graph/client.js')).toBe('js-acme-core.graph.client');
    expect(classifyFile('src/graph.test.ts')).toBeUndefined();
    expect(classifyFile('src/types.d.ts')).toBeUndefined();
    expect(classifyFile('vite.config.ts')).toBeUndefined();
    expect(classifyFile('examples/a.js')).toBe('js-example');
    expect(classifyFile('src/a.tsx')).toBe('typescript');
  });
});

describe('a TypeScript library and its docs on the graph (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('ts'));
    const r = await indexOrg(graph, [MINI_JS, JS_DOCS]);
    expect(r.dependsOn).toEqual([{ from: 'acme/js-docs', to: 'acme/mini-js', spec: 'examples import js-acme-minigraph' }]);
  });
  afterAll(async () => done());

  const rows = async <T>(q: string) => (await graph.run<T>(q)).rows;

  it('links JS/TS examples and scripts through the package entry, re-exports and types', async () => {
    const uses = await rows<{ ex: string; sym: string }>(`MATCH (e:CodeExample)-[u:USES]->(s:Symbol) RETURN e.id AS ex, s.qualname AS sym ORDER BY ex, sym`);
    expect(uses.map((u) => `${u.ex.replace('acme/', '')} → ${u.sym.replace('js-acme-minigraph', '~')}`)).toEqual([
      'js-docs:docs/js.md:0 → ~.client.Client',
      'js-docs:docs/js.md:0 → ~.client.Client.constructor',
      'js-docs:docs/js.md:0 → ~.client.Client.selectGraph',
      'js-docs:docs/js.md:0 → ~.graph.Graph.query',
      'js-docs:docs/js.md:1 → ~.client.Client.selectGraph',
      'js-docs:docs/js.md:1 → ~.connect',
      'mini-js:examples/quickstart.js:0 → ~.client.Client',
      'mini-js:examples/quickstart.js:0 → ~.client.Client.constructor',
      'mini-js:examples/quickstart.js:0 → ~.client.Client.selectGraph',
      'mini-js:examples/quickstart.js:0 → ~.graph.Graph.roQuery',
    ]);
    const calls = await rows<{ a: string; b: string }>(`MATCH (a:Symbol)-[:CALLS]->(b:Symbol) WHERE a.qualname = 'js-acme-minigraph.graph.Graph.roQuery' RETURN a.qualname AS a, b.qualname AS b`);
    expect(calls.map((c) => c.b)).toEqual(['js-acme-minigraph.graph.Graph.query']);
  });

  it('flags names the package does not export and methods the class does not have', async () => {
    const mm = await rows<{ ex: string; detail: string; line: number }>(`MATCH (e:CodeExample)-[m:MISMATCH]->() RETURN e.id AS ex, m.detail AS detail, m.line AS line ORDER BY line`);
    expect(mm).toEqual([
      { ex: 'acme/js-docs:docs/js.md:1', detail: '`@acme/minigraph` has no `Gone`', line: 21 },
      { ex: 'acme/js-docs:docs/js.md:1', detail: '`Graph` has no attribute `readOnly`', line: 23 },
    ]);
  });

  it('audits API coverage over what the package exports', async () => {
    const r = await auditDocs({ graph, config: testConfig() }, { repos: ['acme/mini-js'] });
    // Exported: connect, Client (+ selectGraph, listGraphs), Graph (+ query, roQuery); Pool and Emitting are not exported, send is private.
    expect(r.data.coverage).toEqual({ api: 7, documented: 6, percent: 85.7 });
    expect(r.data.undocumented.map((u) => u.qualname)).toEqual(['js-acme-minigraph.client.Client.listGraphs']);
  });

  it('detects TypeScript changes and predicts the examples they break', async () => {
    const path = 'src/graph/index.ts';
    const original = await readFile(join(MINI_JS.dir, path), 'utf8');
    const edited = original.replace(/  roQuery\(q: string\) \{\n    return this.query\(q\);\n  \}\n\n/, '');
    const all = ['package.json', 'src/index.ts', 'src/client.ts', 'src/types.ts', path, 'examples/quickstart.js'];
    const src = contentSource(all, [{ path, content: edited }], async (p) => readFile(join(MINI_JS.dir, p), 'utf8').catch(() => undefined));
    const diff = await diffWith(src, 'acme/mini-js', 'base', WORKTREE);
    expect(diff.symbols.map((s) => `${s.change} ${s.qualname}`)).toEqual(['removed js-acme-minigraph.graph.Graph.roQuery']);
    const r = await analyzeChanges(graph, testConfig().home, 'acme/mini-js', diff, { url: 'local', title: 't' });
    expect(r.data.impact.predicted.map((p) => `${p.example} L${p.line} ${p.kind}: ${p.detail}`)).toEqual([
      'acme/mini-js:examples/quickstart.js:0 L4 removed: calls `Graph.roQuery`, which these changes remove',
    ]);
    expect(r.data.impact.sections.map((s) => s.section)).toEqual(['acme/mini-js:examples/quickstart.js:0']);
  });
});
