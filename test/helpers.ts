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

import { loadConfig, type Config } from '../src/config.js';
import type { PullRequestInfo } from '../src/pr/github.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({}), home: join(FIXTURES, '..', '.lockstep-test-home'), ...overrides };
}

export function fakePr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    owner: 'acme',
    repo: 'mini-client',
    fullName: 'acme/mini-client',
    number: 7,
    url: 'https://github.com/acme/mini-client/pull/7',
    title: 'Async query timeout; drop graph_names',
    body: '',
    author: 'dev',
    state: 'closed',
    mergedAt: '2026-10-01T00:00:00Z',
    mergeSha: 'after',
    baseSha: 'before',
    baseRef: 'main',
    headSha: 'head',
    headRef: 'feature',
    ...overrides,
  };
}
