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

import { execFileSync } from 'node:child_process';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

export const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** The fixture org as real git repositories (one commit each) in a temp dir. */
export async function makeGitOrg(): Promise<{ root: string; checkouts: Checkout[] }> {
  const root = await mkdtemp(join(tmpdir(), 'lockstep-org-'));
  const checkouts: Checkout[] = [];
  for (const name of ['mini-client', 'mini-sdk', 'mini-docs']) {
    const dir = join(root, name);
    await cp(join(FIXTURES, 'org', name), dir, { recursive: true });
    gitIn(dir, 'init', '-q', '-b', 'main');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'init');
    checkouts.push({ repo: `acme/${name}`, dir, sha: gitIn(dir, 'rev-parse', 'HEAD') });
  }
  return { root, checkouts };
}
