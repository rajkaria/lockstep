import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelMessageParam } from '../src/agent/model.js';
import { ScriptedModel } from '../src/agent/scripted.js';
import { GraphStore } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import { recordPullRequest } from '../src/pr/ingest.js';
import { createApp } from '../src/server/app.js';
import { fakePr, FIXTURE_REPOS, testConfig, testGraph } from './helpers.js';

const PR = fakePr({ number: 31, url: 'https://github.com/acme/mini-client/pull/31' });
const LISTING = 'acme/mini-docs:docs/getting-started.mdx#listing-graphs';

async function sse(res: Response): Promise<{ type: string; [k: string]: unknown }[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

describe('HTTP API (FalkorDB)', () => {
  let done: () => Promise<void>;
  let store: GraphStore;
  let app: ReturnType<typeof createApp>;
  let appNoAgent: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const t = await testGraph('server');
    done = t.done;
    store = t.store;
    await indexOrg(t.graph, FIXTURE_REPOS);
    await recordPullRequest(t.graph, PR, {
      before: 'b', after: 'a', files: [], docsTouched: [],
      symbols: [{ repo: 'acme/mini-client', qualname: 'miniclient.client.Client.graph_names', name: 'graph_names', kind: 'method', change: 'removed', before: 'def graph_names(self)', path: 'miniclient/client.py', lineno: 20, endLineno: 21 }],
    });
    const config = { ...testConfig(), org: t.graph.name };
    const script = (_h: ModelMessageParam[], turn: number) =>
      turn === 0 ? { calls: [{ name: 'impact', input: {} }] }
      : turn === 1 ? { calls: [{ name: 'record_verdict', input: { section_ids: [LISTING], verdict: 'skipped' as const, reason: 'demo' } }] }
      : { text: 'All sections judged.' };
    app = createApp({ store, config, model: () => new ScriptedModel(script), preloaded: [PR.url], webDir: '/nonexistent', rateLimit: 1000 });
    appNoAgent = createApp({ store, config, preloaded: [PR.url], webDir: '/nonexistent', rateLimit: 2 });
  });
  afterAll(async () => done());

  it('reports health, including whether the agent is available', async () => {
    const h = (await (await app.request('/api/health')).json()) as any;
    expect(h).toMatchObject({ ok: true, falkordb: expect.stringMatching(/^\d+\.\d+\.\d+$/), agent: { available: true } });
    const h2 = await (await appNoAgent.request('/api/health')).json() as any;
    expect(h2.agent).toMatchObject({ available: false, reason: expect.stringContaining('ANTHROPIC_API_KEY') });
  });

  it('streams an agent check as server-sent trace events', async () => {
    const res = await app.request('/api/check', { method: 'POST', body: JSON.stringify({ pr_url: PR.url, mode: 'agent' }), headers: { 'content-type': 'application/json' } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await sse(res);
    expect(events[0]!.type).toBe('check_started');
    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.name)).toEqual(['impact', 'record_verdict']);
    expect(events.at(-1)).toMatchObject({ type: 'check_finished', status: 'done', summary: 'All sections judged.' });
    const checks = await (await app.request('/api/checks')).json() as any;
    const stored = await (await app.request(`/api/checks/${checks.checks[0].id}`)).json() as any;
    expect(stored.events.at(-1).type).toBe('check_finished');
  });

  it('refuses agent mode without credentials but runs graph mode, labelled as such', async () => {
    const refused = await appNoAgent.request('/api/check', { method: 'POST', body: JSON.stringify({ pr_url: PR.url, mode: 'agent' }) });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).agentUnavailable).toBe(true);
    const events = await sse(await appNoAgent.request('/api/check', { method: 'POST', body: JSON.stringify({ pr_url: PR.url }) }));
    expect(events[0]).toMatchObject({ type: 'check_started', model: 'graph-only (no model)' });
    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.name)).toEqual(['impact', 'clearance', 'rank_sections']);
    expect(String(events.at(-1)!.summary)).toContain('Graph mode: fixed tool order');
    const limited = await appNoAgent.request('/api/check', { method: 'POST', body: JSON.stringify({ pr_url: PR.url }) });
    expect(limited.status).toBe(429);
  });

  it('serves preloaded PRs with their latest check, sections, the graph model, and accepts decisions', async () => {
    const prs = await (await app.request('/api/prs')).json() as any;
    expect(prs.prs[0]).toMatchObject({ url: PR.url, title: PR.title, latestCheck: { status: expect.any(String) } });
    const sec = await (await app.request(`/api/sections?id=${encodeURIComponent(LISTING)}`)).json() as any;
    expect(sec.body).toContain('## Listing graphs');
    const model = await (await app.request('/api/model')).json() as any;
    expect(model.queries.find((q: { name: string }) => q.name === 'impact').cypher).toContain('[:CALLS*0..3]');
    const dec = await app.request('/api/decisions', { method: 'POST', body: JSON.stringify({ text: 'Listing graphs keeps the legacy name for one release', governs: [LISTING] }) });
    expect(((await dec.json()) as any).governed).toBe(1);
    const bad = await app.request('/api/decisions', { method: 'POST', body: JSON.stringify({ text: 'x', governs: [] }) });
    expect(bad.status).toBe(400);
    const stats = await (await app.request('/api/stats')).json() as any;
    expect(stats.repos).toHaveLength(3);
    const patch = await (await app.request(`/api/patch?pr=${encodeURIComponent(PR.url)}`)).json() as any;
    expect(patch.verdicts.map((v: { verdict: string }) => v.verdict)).toEqual(['skipped']);
  });
});
