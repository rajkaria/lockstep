import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import type { PrDiff } from '../src/pr/changes.js';
import { recordPullRequest } from '../src/pr/ingest.js';
import { clearanceTool, impactTool, rankSectionsTool, readSectionTool } from '../src/tools/graph-tools.js';
import type { ToolContext } from '../src/tools/types.js';
import { fakePr, FIXTURE_REPOS, testConfig, testGraph } from './helpers.js';

const PR = fakePr();

const DIFF: PrDiff = {
  before: 'before',
  after: 'after',
  files: [{ status: 'M', path: 'miniclient/asyncio/client.py' }],
  docsTouched: [],
  symbols: [
    {
      repo: 'acme/mini-client', qualname: 'miniclient.asyncio.client.AsyncGraph.query', name: 'query', kind: 'method', change: 'signature',
      before: 'async def query(self, q: str, params=None)', after: 'async def query(self, q: str, params=None, *, timeout: float)',
      path: 'miniclient/asyncio/client.py', lineno: 5, endLineno: 6,
    },
    {
      repo: 'acme/mini-client', qualname: 'miniclient.client.Client.graph_names', name: 'graph_names', kind: 'method', change: 'removed',
      before: 'def graph_names(self)', path: 'miniclient/client.py', lineno: 20, endLineno: 21,
    },
    {
      repo: 'acme/mini-client', qualname: 'miniclient.graph.Graph.delete', name: 'delete', kind: 'method', change: 'modified',
      before: 'def delete(self)', after: 'def delete(self)', path: 'miniclient/graph.py', lineno: 20, endLineno: 21,
    },
  ],
};

describe('graph tools (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let ctx: ToolContext;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('tools'));
    await indexOrg(graph, FIXTURE_REPOS);
    const ingested = await recordPullRequest(graph, PR, DIFF);
    expect(ingested.recreated).toEqual(['acme/mini-client:miniclient.client.Client.graph_names']);
    expect(ingested.lateLinks).toBe(1);
    ctx = { graph, config: testConfig() };
  });
  afterAll(async () => done());

  it('impact: finds docs in other repositories through call chains, breaking first, with evidence paths', async () => {
    const r = await impactTool.run(ctx, { pr_url: PR.url });
    expect(r.summary).toBe('3 changed symbols reach 3 doc sections (1 breaking, 2 signature, 0 behavior; 3 in other repositories).');
    expect(r.data.sections.map((s) => `${s.severity} ${s.section} hops=${s.hops} ${s.confidence}`)).toEqual([
      'breaking acme/mini-docs:docs/getting-started.mdx#listing-graphs hops=1 late',
      'api acme/mini-docs:docs/rag.mdx#ask-a-question hops=3 exact',
      'api acme/mini-sdk:minisdk/examples/quickstart.py:0 hops=3 exact',
    ]);
    const rag = r.data.sections[1]!;
    expect(rag.evidence).toEqual([
      'miniclient.asyncio.client.AsyncGraph.query',
      'minisdk.connection.Connection.run',
      'minisdk.rag.Rag.ask',
      'acme/mini-docs:docs/rag.mdx:0',
    ]);
    expect(rag.examples).toEqual(['acme/mini-docs:docs/rag.mdx:0']);
    expect(rag.changes[0]).toMatchObject({ change: 'signature', after: 'async def query(self, q: str, params=None, *, timeout: float)' });
    expect(r.queries.map((q) => q.name)).toContain('impact');
    expect(r.queries.find((q) => q.name === 'impact')!.cypher).toContain('[:CALLS*0..3]');
  });

  it('impact: max_hops narrows the walk', async () => {
    const r = await impactTool.run(ctx, { pr_url: PR.url, max_hops: 1 });
    expect(r.data.sections.map((s) => s.section)).toEqual(['acme/mini-docs:docs/getting-started.mdx#listing-graphs']);
    expect(r.queries.find((q) => q.name === 'impact')!.cypher).toContain('[:CALLS*0..1]');
  });

  it('clearance: proves which changed symbols reach no doc', async () => {
    const r = await clearanceTool.run(ctx, { pr_url: PR.url });
    expect(r.data.cleared.map((c) => `${c.symbol} ${c.change}`)).toEqual(['miniclient.graph.Graph.delete modified']);
    expect(r.data.cleared[0]!.grep).toBe("git grep -nw delete -- '*.md' '*.mdx'");
  });

  it('rank_sections: orders by PageRank of the page', async () => {
    const r = await rankSectionsTool.run(ctx, {
      section_ids: ['acme/mini-docs:docs/rag.mdx#ask-a-question', 'acme/mini-docs:docs/getting-started.mdx#listing-graphs'],
    });
    expect(r.data.method).toBe('pagerank');
    expect(r.data.ranked[0]!.page).toBe('acme/mini-docs:docs/getting-started.mdx');
    expect(r.data.ranked).toHaveLength(2);
  });

  it('read_section: returns the section text and its examples', async () => {
    const r = await readSectionTool.run(ctx, { section_id: 'acme/mini-docs:docs/getting-started.mdx#connect' });
    expect(r.data!.body).toContain('Use `Client` and `select_graph()`');
    expect(r.data!.examples.map((e) => e.lang)).toEqual(['python']);
  });
});
