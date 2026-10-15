import { join } from 'node:path';
import { inject } from 'vitest';
import { GraphStore, type OrgGraph } from '../src/graph/client.js';
import type { Checkout } from '../src/indexer/repo.js';

export const FIXTURES = join(import.meta.dirname, 'fixtures');

export const FIXTURE_REPOS: Checkout[] = [
  { repo: 'acme/mini-client', dir: join(FIXTURES, 'org', 'mini-client'), sha: 'fixture' },
  { repo: 'acme/mini-sdk', dir: join(FIXTURES, 'org', 'mini-sdk'), sha: 'fixture' },
  { repo: 'acme/mini-docs', dir: join(FIXTURES, 'org', 'mini-docs'), sha: 'fixture' },
];

/** A fresh, uniquely named graph on the test FalkorDB. Call `done()` to drop it. */
export async function testGraph(prefix = 'test'): Promise<{ store: GraphStore; graph: OrgGraph; done: () => Promise<void> }> {
  const store = await GraphStore.connect(inject('falkordbUrl'));
  const graph = store.org(`${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  return {
    store,
    graph,
    done: async () => {
      await graph.drop();
      await store.close();
    },
  };
}
