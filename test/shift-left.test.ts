import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import { diffWith } from '../src/pr/changes.js';
import { analyzeChanges, checkChangesTool, contentSource, localChanges, textHunks, WORKTREE } from '../src/pr/local.js';
import { createApp } from '../src/server/app.js';
import { docsForTool } from '../src/tools/docs-for.js';
import type { ToolContext } from '../src/tools/types.js';
import { makeGitOrg, testConfig, testGraph } from './helpers.js';
import type { Checkout } from '../src/indexer/repo.js';
import type { GraphStore } from '../src/graph/client.js';

const NEW_QUERY = (src: string) => src.replace('def query(self, q: str, params=None):', 'def query(self, q: str, params=None, *, timeout: float):');

describe('before a pull request (FalkorDB)', () => {
  let graph: OrgGraph;
  let store: GraphStore;
  let done: () => Promise<void>;
  let ctx: ToolContext;
  let org: { root: string; checkouts: Checkout[] };
  const client = () => org.checkouts.find((c) => c.repo === 'acme/mini-client')!;

  beforeAll(async () => {
    org = await makeGitOrg();
    ({ graph, store, done } = await testGraph('shift'));
    await indexOrg(graph, org.checkouts);
    ctx = { graph, config: testConfig() };
  });
  afterAll(async () => {
    await done();
    await rm(org.root, { recursive: true, force: true });
  });

  it('docs_for_symbol: the docs that depend on a symbol, by qualified name, suffix or bare name', async () => {
    const r = await docsForTool.run(ctx, { symbol: 'Graph.ro_query' });
    expect(r.data.symbols.map((s) => s.qualname)).toEqual(['miniclient.graph.Graph.ro_query']);
    expect(r.data.sections.map((s) => `${s.section} ${s.hops}`)).toEqual([
      'acme/mini-docs:docs/getting-started.mdx#read-only-queries 1',
    ]);
    expect(r.summary).toBe('1 doc section reaches miniclient.graph.Graph.ro_query (1 name or call it directly; 1 repository).');

    // AsyncGraph.query is called by minisdk's Connection.run ← Rag.ask ← the RAG page, two repositories away.
    const asyncQuery = await docsForTool.run(ctx, { symbol: 'acme/mini-client:miniclient.asyncio.client.AsyncGraph.query' });
    expect(asyncQuery.data.sections.find((s) => s.section === 'acme/mini-docs:docs/rag.mdx#ask-a-question')!.evidence).toEqual([
      'miniclient.asyncio.client.AsyncGraph.query',
      'minisdk.connection.Connection.run',
      'minisdk.rag.Rag.ask',
      'acme/mini-docs:docs/rag.mdx:0',
    ]);

    const both = await docsForTool.run(ctx, { symbol: 'query' });
    expect(both.data.symbols.map((s) => s.qualname)).toEqual(['miniclient.asyncio.client.AsyncGraph.query', 'miniclient.graph.Graph.query']);
    expect(both.data.ambiguous).toBe(true);
    expect(both.summary).toContain('The name is ambiguous');
    const none = await docsForTool.run(ctx, { symbol: 'nope_nothing' });
    expect(none.summary).toBe(`No live symbol in the "${graph.name}" graph is named nope_nothing.`);
  });

  it('check_changes: edited file contents against the indexed commit, nothing written', async () => {
    const path = 'miniclient/graph.py';
    const original = await readFile(join(client().dir, path), 'utf8');
    // The base is read from a local clone when there is one (here, the fixture checkout), else from raw.githubusercontent.com.
    const withClone = { ...ctx, checkouts: { 'acme/mini-client': client().dir } };
    const r = await checkChangesTool.run(withClone, { repo: 'acme/mini-client', files: [{ path, content: NEW_QUERY(original) }] });
    expect(r.data.impact.changed.map((c) => `${c.change} ${c.symbol}`)).toEqual(['signature miniclient.graph.Graph.query']);
    expect(r.data.impact.predicted.map((p) => `${p.example.split(':').slice(1).join(':')} ${p.kind}: ${p.detail}`)).toEqual([
      'docs/getting-started.mdx:0 missing-argument: `Graph.query` requires `timeout`, which the example does not pass',
    ]);
    expect(r.summary).toMatch(/^1 changed symbol reaches \d+ doc sections? .*1 example is predicted to break/);
    const prs = await graph.run<{ n: number }>(`MATCH (p:PullRequest) RETURN count(p) AS n`);
    expect(prs.rows[0]!.n).toBe(0);
    await expect(checkChangesTool.run(ctx, {})).rejects.toThrow('this server cannot read your disk');
  });

  it('check without a pull request: the working tree of a checkout', async () => {
    const path = join(client().dir, 'miniclient/graph.py');
    const original = await readFile(path, 'utf8');
    await writeFile(path, NEW_QUERY(original).replace('    def ro_query(self, q: str):\n        """Run a read-only Cypher query."""\n        return self.query(q)\n', ''));
    try {
      const local = await localChanges(client().dir, { repo: 'acme/mini-client' });
      expect(local.base).toBe(client().sha);
      expect(local.diff.symbols.map((s) => `${s.change} ${s.qualname}`)).toEqual(['signature miniclient.graph.Graph.query', 'removed miniclient.graph.Graph.ro_query']);
      const r = await analyzeChanges(graph, ctx.config.home, local.repo, local.diff, { url: 'local', title: 'Working tree' });
      expect(r.data.impact.predicted.map((p) => `${p.example.split(':').slice(1).join(':')} ${p.kind}`)).toEqual([
        'docs/getting-started.mdx:0 missing-argument',
        'docs/getting-started.mdx:1 removed',
      ]);
      const viaTool = await checkChangesTool.run({ ...ctx, allowDir: true }, { dir: client().dir, repo: 'acme/mini-client' });
      expect(viaTool.data.impact.predicted).toHaveLength(2);
    } finally {
      await writeFile(path, original);
    }
  });

  it('serves docs-for over HTTP', async () => {
    const app = createApp({ store, config: { ...ctx.config, org: graph.name }, webDir: '/nonexistent', rateLimit: 1000 });
    const r = (await (await app.request('/api/docs-for?symbol=Graph.ro_query')).json()) as { sections: unknown[]; summary: string };
    expect(r.sections).toHaveLength(1);
    expect((await app.request('/api/docs-for')).status).toBe(400);
  });

  it('textHunks matches git -U0 line numbers, and contentSource diffs files without a clone', async () => {
    expect(textHunks('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ old: [[2, 2]], new: [[2, 2], [4, 4]] });
    const src = contentSource(['pkg/a.py'], [{ path: 'pkg/a.py', content: 'def f(x):\n    return x\n' }, { path: 'pkg/b.py', content: 'def g():\n    pass\n' }], async () => 'def f():\n    return 1\n');
    expect(await src.changedFiles('base', WORKTREE)).toEqual([{ status: 'M', path: 'pkg/a.py' }, { status: 'A', path: 'pkg/b.py' }]);
    const diff = await diffWith(src, 'acme/x', 'base', WORKTREE);
    expect(diff.symbols.map((s) => `${s.change} ${s.qualname}`)).toEqual(['signature pkg.a.f', 'added pkg.b.g']);
  });
});
