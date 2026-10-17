import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { GitHubAppEnv } from '../src/app/env.js';
import { signBody } from '../src/app/webhook.js';
import type { Config } from '../src/config.js';
import { GraphStore } from '../src/graph/client.js';
import { Workspaces } from '../src/hosted/workspaces.js';
import { createApp } from '../src/server/app.js';
import { testKeys } from './fixtures/github-app/fake-github.js';
import { testConfig } from './helpers.js';

/**
 * The App's routes on `createApp`, `githubApp` in `/api/health`, and the private-graph guard in
 * `src/server/app.ts` and `src/hosted/workspaces.ts`. The guard is tested the hard way: the hosted registry is
 * made to point a repository at a private `ghp-` graph (as a bug might), and every public
 * endpoint must still refuse it.
 */

const U = `${process.pid}${Math.random().toString(36).slice(2, 6)}`;
const INST = 700_000_000 + Math.floor(Math.random() * 1e8);
const PRIVATE = `ghp-${INST}`;
const SECRET = `sp6priv${U}/secret`;
const HOSTED_REGISTRY = `test-sp6-routes-hosted-${U}`;
const APP_REGISTRY = `test-sp6-routes-app-${U}`;
const CURATED = `test-sp6-routes-curated-${U}`;
const keys = testKeys();
const ENV: GitHubAppEnv = { appId: '4444', privateKey: keys.privateKey, webhookSecret: 'whsec-routes', slug: 'staleproof-test', cronSecret: 'cron-routes' };

let store: GraphStore;
let config: Config;
let home: string;
/** Every public download fails: the hosted service never reads a private repository. */
const fetchImpl = (async () => new Response('Not Found', { status: 404 })) as typeof fetch;

beforeAll(async () => {
  store = await GraphStore.connect(inject('falkordbUrl'));
  home = await mkdtemp(join(tmpdir(), 'staleproof-app-routes-'));
  config = testConfig({ home });
  const now = Date.now();
  // A private graph with a repository, a section and a stored check...
  await store.org(PRIVATE).run(
    `CREATE (:Repo {name: $repo, sha: 'abc', indexed_at: $now, index_version: 4})
     CREATE (:DocSection {id: $section, repo: $repo, path: 'README.md', heading: 'Secret', text: 'the secret plan'})
     CREATE (:Check {id: 'chk-secret', pr: $pr, status: 'done', started_at: $now, model: 'graph-only (no model)', summary: 'secret', trace: '[]'})`,
    { repo: SECRET, section: `${SECRET}:README.md#secret`, pr: `https://github.com/${SECRET}/pull/1`, now },
  );
  // ...and a hosted registry entry pointing at it, as a bug might write.
  await store.org(HOSTED_REGISTRY).run(`CREATE (:HostedRepo {name: $repo, graph: $graph, sha: 'abc', indexed_at: $now, last_used: $now, index_version: 4})`, { repo: SECRET, graph: PRIVATE, now });
});

afterAll(async () => {
  for (const g of [PRIVATE, HOSTED_REGISTRY, APP_REGISTRY, CURATED]) await store.org(g).drop();
  await store.close();
  await rm(home, { recursive: true, force: true });
});

function app(withApp = true) {
  const workspaces = new Workspaces(store, config, store.org(CURATED), { registry: HOSTED_REGISTRY, fetchImpl });
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    app: createApp({
      store,
      config,
      workspaces,
      webDir: '/nonexistent',
      githubApp: withApp ? { env: ENV, registry: APP_REGISTRY, fetchImpl, waitUntil: (p: Promise<unknown>) => pending.push(p), log: () => undefined } : {},
    }),
  };
}

describe('the App on createApp', () => {
  it('mounts the webhook and cron routes', async () => {
    const { app: a, pending } = app();
    const body = JSON.stringify({ zen: 'x' });
    const ping = await a.request('/api/github/webhook', { method: 'POST', headers: { 'x-github-event': 'ping', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signBody(ENV.webhookSecret, body) }, body });
    expect(ping.status).toBe(200);
    const bad = await a.request('/api/github/webhook', { method: 'POST', headers: { 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, body });
    expect(bad.status).toBe(401);
    expect((await a.request('/api/github/cron')).status).toBe(401);
    expect(pending).toHaveLength(0);
  });

  it('answers 404 on both routes when the App is not configured', async () => {
    const { app: a } = app(false);
    expect((await a.request('/api/github/webhook', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await a.request('/api/github/cron')).status).toBe(404);
  });

  it('tells /api/health whether the App is on and where to install it', async () => {
    const h = (await (await app().app.request('/api/health')).json()) as { githubApp: unknown };
    expect(h.githubApp).toEqual({ enabled: true, appSlug: 'staleproof-test', installUrl: 'https://github.com/apps/staleproof-test/installations/new' });
    expect(JSON.stringify(h)).not.toContain('whsec-routes');
    const off = (await (await app(false).app.request('/api/health')).json()) as { githubApp: unknown };
    expect(off.githubApp).toEqual({ enabled: false });
  });
});

describe('public endpoints refuse private graphs', () => {
  it('audit, badge, repos, workspaces, checks, docs-for, sections, patch, lint', async () => {
    const { app: a } = app();
    expect((await a.request(`/api/audit?repo=${SECRET}`)).status).toBe(404);
    const badge = await (await a.request(`/api/badge/${SECRET}.svg`)).text();
    expect(badge).toContain('not audited');
    const repos = (await (await a.request(`/api/repos?name=${SECRET}`)).json()) as { indexed: boolean; graph: string };
    expect(repos.indexed).toBe(false);
    expect(repos.graph).not.toBe(PRIVATE);
    const ws = (await (await a.request('/api/workspaces')).json()) as { workspaces: { graph: string }[] };
    expect(ws.workspaces.map((w) => w.graph)).not.toContain(PRIVATE);
    const checks = (await (await a.request('/api/checks')).json()) as { checks: { id: string; org: string }[] };
    expect(checks.checks.map((c) => c.id)).not.toContain('chk-secret');
    expect((await a.request('/api/checks/chk-secret')).status).toBe(404);
    expect((await a.request(`/api/docs-for?repo=${SECRET}&symbol=x`)).status).toBe(404);
    expect((await a.request(`/api/sections?id=${encodeURIComponent(`${SECRET}:README.md#secret`)}`)).status).toBe(404);
    expect((await a.request(`/api/patch?pr=${encodeURIComponent(`https://github.com/${SECRET}/pull/1`)}`)).status).toBe(404);
    expect((await a.request(`/api/lint?repo=${SECRET}`)).status).toBe(404);
    // The checked stamp.
    expect((await a.request(`/api/verified/${SECRET}.json`)).status).toBe(404);
    // Nothing anywhere says what the private graph holds.
    for (const path of [`/api/audit?repo=${SECRET}`, `/api/sections?id=${encodeURIComponent(`${SECRET}:README.md#secret`)}`, '/api/checks/chk-secret']) {
      expect(await (await a.request(path)).text()).not.toContain('the secret plan');
    }
  });

  it('a check streams an error, never the private graph', async () => {
    const { app: a } = app();
    const res = await a.request('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr_url: `https://github.com/${SECRET}/pull/1`, mode: 'graph' }) });
    const text = await res.text();
    expect(text).toContain('"type":"error"');
    expect(text).not.toContain(PRIVATE);
    expect(text).not.toContain('chk-secret');
  });

  it('MCP tools answer as if the repository were unknown', async () => {
    const { app: a } = app();
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://local/api/mcp'), { fetch: async (url, init) => a.request(String(url), init as RequestInit) }));
    const section = await client.callTool({ name: 'read_section', arguments: { section_id: `${SECRET}:README.md#secret` } });
    expect(section.isError).toBe(true);
    expect(JSON.stringify(section.content)).not.toContain('the secret plan');
    const audit = await client.callTool({ name: 'audit_docs', arguments: { repos: [SECRET] } });
    expect(audit.isError).toBe(true);
    await client.close();
  });
});
