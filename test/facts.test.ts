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
});
