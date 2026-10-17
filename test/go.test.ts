import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { extractGo, extractGoExample, goModuleOf, goPackageName, registerGoModule } from '../src/indexer/go.js';
import { indexOrg, listFiles, parseRepo } from '../src/indexer/index.js';
import { classifyFile } from '../src/indexer/repo.js';
import { arityOf } from '../src/indexer/signature.js';
import { lintRepo } from '../src/lint/engine.js';
import { diffWith } from '../src/pr/changes.js';
import { analyzeChanges, contentSource, WORKTREE } from '../src/pr/local.js';
import { FIXTURES, testConfig, testGraph } from './helpers.js';

const GO = join(FIXTURES, 'go-org');
const MINIGO = { repo: 'acme/minigo', dir: join(GO, 'minigo'), sha: 'fixture' };
const GO_DOCS = { repo: 'acme/go-docs', dir: join(GO, 'go-docs'), sha: 'fixture' };
const ROOT = 'go-github-com-acme-minigo';

describe('Go extraction', () => {
  it('names packages after the module path, apart from Python and npm', () => {
    registerGoModule('github.com/acme/x/v2');
    expect(goModuleOf('github.com/acme/x/v2')).toBe('go-github-com-acme-x-v2');
    expect(goModuleOf('github.com/acme/x/v2/graph/internal')).toBe('go-github-com-acme-x-v2.graph.internal');
    expect(goModuleOf('fmt')).toBe('go-fmt');
    expect(goPackageName('github.com/go-chi/chi/v5')).toBe('chi');
    expect(goPackageName('gopkg.in/yaml.v3')).toBe('yaml');
    expect(goPackageName('github.com/redis/go-redis/v9')).toBe('redis');
  });

  it('classifies what the go tool builds', () => {
    expect(classifyFile('graph.go')).toBe('go');
    expect(classifyFile('graph_test.go')).toBeUndefined();
    expect(classifyFile('vendor/x/y.go')).toBeUndefined();
    expect(classifyFile('testdata/a.go')).toBeUndefined();
    expect(classifyFile('_examples/a/main.go')).toBeUndefined();
    expect(classifyFile('examples/basic/main.go')).toBe('go-example');
  });

  it('reads functions, methods on receivers, structs, interfaces, consts and calls', async () => {
    const mod = await extractGo(
      `package graph

import (
	"fmt"
	fdb "github.com/acme/x/v2"
	. "strings"
	_ "embed"
)

const Version = "1"

var defaultGraph = New("g", 1)

type Option func(*config)

type Graph struct {
	*fdb.Client
	base
	conn  Conn
	Name, Alias string
}

type Querier interface {
	fmt.Stringer
	Query(q string, args ...any) (*Result, error)
}

func New(name string, size int, opts ...Option) *Graph { return &Graph{Name: name} }

func (g *Graph) Query(q string, params map[string]any) (*Result, error) {
	r, err := g.conn.Do(q)
	fmt.Println(g.Name, r, err)
	return g.run(q, xs...)
}

func (g Graph) run(q string, _ ...string) (*Result, error) { return nil, nil }

func init() { setup() }
`,
      { module: 'go-github-com-acme-x-v2.graph', path: 'graph/graph.go' },
    );
    expect(mod.lang).toBe('go');
    expect(mod.defs.map((d) => `${d.kind} ${d.qualname.replace('go-github-com-acme-x-v2.graph', '~')}${d.decorators.length ? ` [${d.decorators}]` : ''}${d.bases.length ? ` (${d.bases})` : ''}`)).toEqual([
      'module ~',
      'class ~.Option',
      'class ~.Graph (fdb.Client,base)',
      'class ~.Querier (fmt.Stringer)',
      'method ~.Querier.Query',
      'function ~.New',
      'method ~.Graph.Query',
      'method ~.Graph.run [private]',
    ]);
    expect(mod.defs.every((d) => d.file === 'graph/graph.go')).toBe(true);
    const arity = (q: string) => {
      const a = mod.defs.find((d) => d.qualname.endsWith(q))!.arity!;
      return `${a.params.map((p) => p.name).join(', ')}${a.varArgs ? ' ...' : ''}`;
    };
    expect(arity('.New')).toBe('name, size ...');
    expect(arity('Graph.Query')).toBe('q, params');
    expect(arity('Querier.Query')).toBe('q ...');
    expect(mod.defs.find((d) => d.qualname.endsWith('Graph.Query'))!.signature).toBe('func (g *Graph) Query(q string, params map[string]any) (*Result, error)');
    expect(mod.defs.find((d) => d.name === 'New')!.returns).toBe('Graph');
    expect(mod.imports.map((i) => `${i.alias}=${i.target}`)).toEqual(['fmt=go-fmt', 'fdb=go-github-com-acme-x-v2', '*=go-strings']);
    expect(mod.bindings.map((b) => `${b.scope.replace('go-github-com-acme-x-v2.graph', '~')}:${b.target}${b.annotation ? `:${b.annotation}` : ''}`)).toEqual([
      '~:Version',
      '~:defaultGraph',
      '~.Graph:self.conn:Conn',
      '~.Graph:self.Name:string',
      '~.Graph:self.Alias:string',
      '~.Querier.Query:q:string',
      '~.New:name:string',
      '~.New:size:int',
      '~.Graph.Query:g:Graph',
      '~.Graph.Query:q:string',
      '~.Graph.Query:r',
      '~.Graph.Query:err',
      '~.Graph.run:g:Graph',
      '~.Graph.run:q:string',
    ]);
    expect(mod.calls.map((c) => `${c.scope.split('.').pop()} ${c.text} ${c.args ? `${c.args.positional}${c.args.starArgs ? '+' : ''}` : '-'}`)).toEqual([
      'graph New 2',
      'Query g.conn.Do 1',
      'Query fmt.Println 3',
      'Query g.run 1+',
      'graph setup 0',
    ]);
  });

  it('scopes names to their blocks: a handler’s `r` is not the router `r`', async () => {
    const mod = await extractGo(
      `package main
func main() {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		r.Context()
		x := r.URL
		x.Query()
	})
	for _, r := range routes {
		r.Pattern()
	}
	if r := other(); r != nil {
		r.Close()
	}
	r.Use(m)
}
`,
      { module: 'go-m', path: 'm.go' },
    );
    const names = (e: (typeof mod.calls)[number]['fn']): string => (e.k === 'attr' ? `${names(e.obj)}.${e.attr}` : e.k === 'name' ? e.id : e.k === 'call' ? `${names(e.fn)}()` : '?');
    expect(mod.calls.map((c) => `${c.lineno} ${names(c.fn)}`)).toEqual([
      '3 chi.NewRouter',
      '4 r.Get',
      '5 r#4.12.Context',
      '7 x#4.12.Query',
      '10 r#9.1.Pattern',
      '12 other',
      '13 r#12.1.Close',
      '15 r.Use',
    ]);
    expect(mod.bindings.find((b) => b.target === 'r#4.12')).toMatchObject({ annotation: 'http.Request' });
  });

  it('judges a lone call argument as unknown (it may pass several results)', async () => {
    const mod = await extractGo('package p\nfunc f() { g(h()); g(h(), 1) }\n', { module: 'go-p', path: 'p.go' });
    expect(mod.calls.filter((c) => c.text === 'g').map((c) => `${c.args!.positional}${c.args!.starArgs ? '+' : ''}`)).toEqual(['1+', '2']);
  });

  it('fills in fragments the way a reader would, keeping the block lines', async () => {
    const statements = await extractGoExample('db, _ := minigo.Connect(nil)\n\ndb.SelectGraph()\n', { module: 'ex', path: 'docs/a.md', earlierImports: ['"github.com/acme/minigo"'] });
    expect(statements.calls.map((c) => `${c.lineno} ${c.text}`)).toEqual(['1 minigo.Connect', '3 db.SelectGraph']);
    expect(statements.imports.map((i) => `${i.lineno} ${i.alias}`)).toEqual(['0 minigo']);
    const imports = await extractGoExample('import mg "github.com/acme/minigo"\n\nc, _ := mg.Connect(nil)\n', { module: 'ex', path: 'docs/a.md' });
    expect(imports.calls.map((c) => `${c.lineno} ${c.text}`)).toEqual(['3 mg.Connect']);
    expect(imports.imports.map((i) => `${i.lineno} ${i.alias}`)).toEqual(['1 mg']);
    const program = await extractGoExample('package main\n\nfunc main() {\n\tx.Y()\n}\n', { module: 'ex', path: 'docs/a.md' });
    expect(program.calls.map((c) => `${c.lineno} ${c.text}`)).toEqual(['4 x.Y']);
  });

  it('parses stored Go signatures back into an arity', async () => {
    const a = await arityOf('func (g *Graph) Query(q string, params map[string]interface{}, opts ...QueryOption) (*Result, error)', 'go');
    expect(a).toEqual({ params: [{ name: 'q', kind: 'pos', required: true }, { name: 'params', kind: 'pos', required: true }], varArgs: true, varKw: false });
    expect((await arityOf('func Connect(a, b string) error', 'go'))!.params.map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('indexes every package of a module, each definition in its own file', async () => {
    const p = await parseRepo(MINIGO);
    expect(p.parseErrors).toEqual([]);
    expect(p.modules.map((m) => `${m.module} ${m.path}`)).toEqual([`${ROOT} doc.go`, `${ROOT}.internal.wire internal/wire/wire.go`]);
    const root = p.modules[0]!;
    expect(root.defs[0]!.signature).toBe('package minigo');
    expect(root.defs.find((d) => d.name === 'Query')!.file).toBe('graph.go');
    expect(root.defs.find((d) => d.name === 'Get')!.file).toBe('result.go');
    expect((await listFiles(MINIGO.dir)).filter((f) => f.kind.startsWith('go')).map((f) => `${f.kind} ${f.path}`)).toEqual([
      'go client.go',
      'go doc.go',
      'go-example examples/basic/main.go',
      'go graph.go',
      'go internal/wire/wire.go',
      'go result.go',
    ]);
  });
});

describe('Go docs examples (lint)', () => {
  it('flags unexported or missing names, argument counts and imports of packages that do not exist', async () => {
    const r = await lintRepo({ dir: GO_DOCS.dir, repo: GO_DOCS.repo, with: [MINIGO.dir] });
    expect(r.findings.map((f) => `L${f.line}:${f.column} ${f.rule} ${f.message}`)).toEqual([
      'L26:2 example-missing-argument `Graph.ROQuery` requires `params`, which the example does not pass.',
      'L27:2 example-missing-attribute `Graph` has no attribute `Gone`.',
      'L28:2 example-missing-attribute `Graph.run` is unexported.',
      'L29:2 example-missing-attribute `newConn` is unexported in `github.com/acme/minigo`.',
      'L30:2 example-too-many-arguments `Client.Close` takes no arguments; the example passes 1.',
      'L38:1 example-missing-argument `Client.SelectGraph` requires `name`, which the example does not pass.',
      'L39:1 example-missing-attribute `github.com/acme/minigo` has no `Missing`.',
      'L46:1 example-too-many-arguments `Client.SelectGraph` takes at most 1 argument; the example passes 2.',
      'L51:2 example-missing-import `github.com/acme/minigo/gone` is not a package of `github.com/acme/minigo`.',
    ]);
  });
});

describe('a Go library and its docs on the graph (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  const rows = async <T>(q: string, params: Record<string, unknown> = {}) => (await graph.run<T>(q, params)).rows;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('go'));
    await indexOrg(graph, [MINIGO, GO_DOCS]);
  });
  afterAll(async () => done());

  it('writes symbols with their own files, exported-ness and calls', async () => {
    const syms = await rows<{ q: string; path: string; exported: boolean; visibility: string }>(
      `MATCH (s:Symbol) WHERE s.repo = 'acme/minigo' AND s.kind <> 'module' RETURN s.qualname AS q, s.path AS path, s.exported AS exported, s.visibility AS visibility ORDER BY q`,
    );
    const by = (q: string) => syms.find((s) => s.q === `${ROOT}.${q}`)!;
    expect(by('Graph.Query')).toMatchObject({ path: 'graph.go', exported: true, visibility: 'public' });
    expect(by('Record.Get')).toMatchObject({ path: 'result.go', exported: true });
    expect(by('Graph.run')).toMatchObject({ exported: false, visibility: 'private' });
    expect(by('newConn')).toMatchObject({ exported: false, visibility: 'private' });
    expect(syms.find((s) => s.q.endsWith('wire.Dial'))).toMatchObject({ exported: false });
    const calls = await rows<{ b: string }>(`MATCH (a:Symbol {qualname: $a})-[:CALLS]->(b:Symbol) RETURN b.qualname AS b ORDER BY b`, { a: `${ROOT}.Graph.ROQuery` });
    expect(calls.map((c) => c.b)).toEqual([`${ROOT}.Graph.Query`]);
  });

  it('links Go docs examples and example programs to what they call', async () => {
    const uses = await rows<{ ex: string; sym: string }>(`MATCH (e:CodeExample)-[:USES]->(s:Symbol) RETURN e.id AS ex, s.qualname AS sym ORDER BY ex, sym`);
    expect(uses.map((u) => `${u.ex.replace('acme/', '')} → ${u.sym.replace(ROOT, '~')}`)).toEqual([
      'go-docs:docs/go.md:0 → ~.Client.Close',
      'go-docs:docs/go.md:0 → ~.Client.SelectGraph',
      'go-docs:docs/go.md:0 → ~.Connect',
      'go-docs:docs/go.md:0 → ~.Graph.Query',
      'go-docs:docs/go.md:0 → ~.Graph.ROQuery',
      'go-docs:docs/go.md:0 → ~.Graph.run',
      'go-docs:docs/go.md:0 → ~.Record.Get',
      'go-docs:docs/go.md:0 → ~.Result.Next',
      'go-docs:docs/go.md:0 → ~.Result.Record',
      'go-docs:docs/go.md:0 → ~.WithTimeout',
      'go-docs:docs/go.md:0 → ~.newConn',
      'go-docs:docs/go.md:1 → ~.Client.SelectGraph',
      'go-docs:docs/go.md:1 → ~.Connect',
      'go-docs:docs/go.md:2 → ~.Client.SelectGraph',
      'go-docs:docs/go.md:2 → ~.Connect',
      'minigo:examples/basic/main.go:0 → ~.Client.SelectGraph',
      'minigo:examples/basic/main.go:0 → ~.Connect',
      'minigo:examples/basic/main.go:0 → ~.Graph.ROQuery',
    ]);
    const mm = await rows<{ line: number; kind: string }>(`MATCH (e:CodeExample)-[m:MISMATCH]->() RETURN m.line AS line, m.kind AS kind ORDER BY line`);
    expect(mm.map((m) => `${m.line} ${m.kind}`)).toEqual([
      '26 missing-argument',
      '27 missing-attribute',
      '28 missing-attribute',
      '29 missing-attribute',
      '30 too-many-arguments',
      '38 missing-argument',
      '39 missing-attribute',
      '46 too-many-arguments',
      '51 missing-import',
    ]);
  });

  const diff = async (edits: { path: string; content: string | null }[]) => {
    const all = ['go.mod', 'doc.go', 'client.go', 'graph.go', 'result.go', 'graph_test.go', 'internal/wire/wire.go', 'examples/basic/main.go'];
    const src = contentSource(all, edits, async (p) => readFile(join(MINIGO.dir, p), 'utf8').catch(() => undefined));
    return diffWith(src, MINIGO.repo, 'base', WORKTREE);
  };

  it('reads Go diffs by package: a function moved to another file is not removed', async () => {
    const graphGo = await readFile(join(MINIGO.dir, 'graph.go'), 'utf8');
    const resultGo = await readFile(join(MINIGO.dir, 'result.go'), 'utf8');
    const fn = graphGo.slice(graphGo.indexOf('func WithTimeout'));
    const moved = await diff([
      { path: 'graph.go', content: graphGo.replace(fn, '') },
      { path: 'result.go', content: `${resultGo}\n${fn}` },
    ]);
    expect(moved.symbols.map((s) => `${s.change} ${s.qualname}`)).toEqual([]);
    const renamed = await diff([{ path: 'graph.go', content: graphGo.replace('ROQuery(', 'ReadQuery(') }]);
    expect(renamed.symbols.map((s) => `${s.change} ${s.qualname} → ${s.renamedTo} (${s.path})`)).toEqual([`renamed ${ROOT}.Graph.ROQuery → ${ROOT}.Graph.ReadQuery (graph.go)`]);
    const body = await diff([{ path: 'graph.go', content: graphGo.replace('return &Result{}, nil', 'return nil, nil') }]);
    expect(body.symbols.map((s) => `${s.change} ${s.qualname}`)).toEqual([`modified ${ROOT}.Graph.run`]);
  });

  it('predicts the examples a Go rename breaks', async () => {
    const graphGo = await readFile(join(MINIGO.dir, 'graph.go'), 'utf8');
    const d = await diff([{ path: 'graph.go', content: graphGo.replace('ROQuery(', 'ReadQuery(') }]);
    const r = await analyzeChanges(graph, testConfig().home, MINIGO.repo, d, { url: 'local', title: 't' });
    expect(r.data.impact.predicted.map((p) => `${p.example} L${p.line} ${p.kind}: ${p.detail}`)).toEqual([
      'acme/go-docs:docs/go.md:0 L26 removed: calls `Graph.ROQuery`, which these changes rename to `Graph.ReadQuery`',
      'acme/minigo:examples/basic/main.go:0 L7 removed: calls `Graph.ROQuery`, which these changes rename to `Graph.ReadQuery`',
    ]);
  });

  it('predicts the examples a Go signature change breaks', async () => {
    const client = await readFile(join(MINIGO.dir, 'client.go'), 'utf8');
    const d = await diff([{ path: 'client.go', content: client.replace('SelectGraph(name string)', 'SelectGraph(name string, readOnly bool)') }]);
    expect(d.symbols.map((s) => `${s.change} ${s.qualname} ${s.path}`)).toEqual([`signature ${ROOT}.Client.SelectGraph client.go`]);
    const r = await analyzeChanges(graph, testConfig().home, MINIGO.repo, d, { url: 'local', title: 't' });
    expect(r.data.impact.predicted.map((p) => `${p.example} L${p.line} ${p.kind}: ${p.detail}`)).toEqual([
      'acme/go-docs:docs/go.md:0 L19 missing-argument: `Client.SelectGraph` requires `readOnly`, which the example does not pass',
      'acme/minigo:examples/basic/main.go:0 L7 missing-argument: `Client.SelectGraph` requires `readOnly`, which the example does not pass',
    ]);
  });
});
