import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Config } from '../src/config.js';
import { GraphStore } from '../src/graph/client.js';
import { Workspaces } from '../src/hosted/workspaces.js';
import { indexOrg } from '../src/indexer/index.js';
import { createApp } from '../src/server/app.js';
import type { VerifiedData } from '../src/server/verified.js';
import { FIXTURE_REPOS, STALE_DOCS, testConfig } from './helpers.js';

/**
 * `/api/verified` on `createApp`, served from
 * the badge's cached audit, local (one org graph) and hosted (workspaces), never from a private `ghp-` graph.
 */
const U = `${process.pid}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `test-sp8-verified-${U}`;
const REGISTRY = `test-sp8-verified-registry-${U}`;
const PRIVATE = `ghp-${800_000_000 + Math.floor(Math.random() * 1e8)}`;

let store: GraphStore;
let config: Config;

beforeAll(async () => {
  store = await GraphStore.connect(inject('falkordbUrl'));
  config = { ...testConfig(), org: ORG };
  await indexOrg(store.org(ORG), [...FIXTURE_REPOS, STALE_DOCS]);
  // A private repository, and a hosted registry entry pointing at it, as a bug might write.
  await store.org(PRIVATE).run(`CREATE (:Repo {name: 'secret/app', sha: 'abc', indexed_at: 1, index_version: 4}) CREATE (:DocSection {id: 's', repo: 'secret/app', path: 'README.md', status: 'live'})`);
  await store.org(REGISTRY).run(`CREATE (:HostedRepo {name: 'secret/app', graph: $graph, sha: 'abc', indexed_at: 1, last_used: 1, index_version: 4})`, { graph: PRIVATE });
});

afterAll(async () => {
  for (const g of [ORG, REGISTRY, PRIVATE]) await store.org(g).drop();
  await store.close();
});

describe('/api/verified on createApp', () => {
  it('serves per-page status of an indexed repository, CORS *, cached at the CDN', async () => {
    const app = createApp({ store, config, webDir: '/nonexistent' });
    const res = await app.request('/api/verified/acme/stale-docs.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=600');
    const d = (await res.json()) as VerifiedData;
    expect(d).toMatchObject({ version: 1, repo: 'acme/stale-docs', sha: 'fixture', checks: { references: false, examples: true } });
    expect(d.pages).toEqual([expect.objectContaining({ path: 'docs/stale.md', status: 'drift', mismatches: 5 })]);
    expect((await app.request('/api/verified/acme/nope.json')).status).toBe(404);
    const js = await app.request('/api/verified/acme/stale-docs/stamp.js');
    expect(js.status).toBe(200);
    expect(await js.text()).toContain('var R="acme/stale-docs"');
  });

  it('never serves a private (ghp-) graph, even when the hosted registry points at one', async () => {
    const workspaces = new Workspaces(store, config, store.org(ORG), {
      registry: REGISTRY,
      fetchImpl: (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch,
    });
    const app = createApp({ store, config, webDir: '/nonexistent', workspaces });
    const res = await app.request('/api/verified/secret/app.json');
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('ghp-');
    expect(body).not.toContain('README.md');
    // The curated graph still answers.
    expect((await app.request('/api/verified/acme/stale-docs.json')).status).toBe(200);
  });
});
