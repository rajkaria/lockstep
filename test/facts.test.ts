import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectFacts, factsMarkdown } from '../src/facts.js';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import { FIXTURE_REPOS, testGraph } from './helpers.js';

describe('facts', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ graph, done } = await testGraph('facts'));
    await indexOrg(graph, FIXTURE_REPOS);
  });
  afterAll(async () => done());

  it('computes every quoted number from the graph', async () => {
    const f = await collectFacts(graph, '4.18.3');
    expect(f.repos.map((r) => r.name)).toEqual(['acme/mini-client', 'acme/mini-docs', 'acme/mini-sdk']);
    expect(f.calls.crossRepo).toBe(4);
    expect(f.uses.byName).toBe(0);
    expect(f.dependsOn).toHaveLength(3);
    // client class ← client method ← SDK connection ← SDK facade ← docs example
    expect(f.samplePaths[0]).toMatchObject({ symbol: 'miniclient.asyncio.client.AsyncGraph', hops: 4 });
    expect(f.samplePaths[0]!.path).toEqual([
      'miniclient.asyncio.client.AsyncGraph',
      'miniclient.asyncio.client.AsyncClient.select_graph',
      'minisdk.connection.Connection.__init__',
      'minisdk.rag.Rag.__init__',
      'acme/mini-docs:docs/rag.mdx:0',
    ]);
    expect(f.crossRepoDocPaths).toBeGreaterThan(5);
    const md = factsMarkdown(f);
    expect(md).toContain('| CALLS |');
    expect(md).toContain('CALLS edges that cross a repository boundary: 4');
  });

  it('compares a grep for the changed names with what the traversal reaches', async () => {
    const { grepBaseline } = await import('../src/facts.js');
    const sections = [
      { id: 'd:a', body: 'Call `db.select_graph("g")` and then query it.' }, // reached through callers, never names the change
      { id: 'd:b', body: 'Internals: `_query` retries on MOVED.' }, // names it and is reached
      { id: 'd:c', body: 'How to _query the cluster (unrelated page).' }, // names it, not reached
      { id: 'd:d', body: 'my_query_helper is not a match' },
      { id: 'd:e', body: null },
    ];
    expect(grepBaseline('pr', ['_query'], ['d:a', 'd:b', 'd:a'], sections)).toEqual({ url: 'pr', names: ['_query'], reached: 2, grepFound: 1, grepOutside: 1 });
    expect(grepBaseline('pr', [], ['d:a'], sections)).toMatchObject({ reached: 1, grepFound: 0, grepOutside: 0 });
  });
});
