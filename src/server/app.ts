import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AnthropicModel, claudeCredentialsAvailable } from '../agent/anthropic.js';
import { runGraphCheck } from '../agent/graph-check.js';
import { runAgentCheck } from '../agent/loop.js';
import type { ModelClient } from '../agent/model.js';
import type { TraceEvent } from '../agent/trace.js';
import type { Config } from '../config.js';
import { collectFacts, type Facts } from '../facts.js';
import type { GraphStore, OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import { buildDocsPatch } from '../patch.js';
import { parsePrUrl } from '../pr/github.js';
import { packageRoot, packageVersion } from '../pkg.js';
import { readSectionTool } from '../tools/graph-tools.js';
import { reviewVerdict, writeDecisionTool } from '../tools/memory-tools.js';
import { ALL_TOOLS } from '../tools/index.js';

export const DEFAULT_PRELOADED = [
  'https://github.com/FalkorDB/falkordb-py/pull/262',
  'https://github.com/FalkorDB/falkordb-py/pull/267',
  'https://github.com/FalkorDB/falkordb-py/pull/276',
];

export interface AppOptions {
  store: GraphStore;
  config: Config;
  /** Model factory; undefined → agent mode unavailable (graph mode still works). */
  model?: () => ModelClient;
  preloaded?: string[];
  /** Directory with the built web UI. */
  webDir?: string;
  /** Requests per hour per client for POST endpoints. */
  rateLimit?: number;
}

/** One check at a time: example runs share a scratch database and the model budget is shared. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  busy = false;
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      this.busy = true;
      try {
        return await fn();
      } finally {
        this.busy = false;
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}

class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly perHour: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= this.perHour) return false;
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export function defaultModelFactory(config: Config): (() => ModelClient) | undefined {
  if (!config.anthropicApiKey && !claudeCredentialsAvailable()) return undefined;
  return () =>
    new AnthropicModel({
      model: config.model,
      effort: config.effort,
      fallbacks: config.fallbacks,
      apiKey: config.anthropicApiKey,
      baseURL: config.modelBaseUrl,
      compatible: config.modelCompatible,
    });
}

export function createApp(opts: AppOptions): Hono {
  const { store, config } = opts;
  const graph: OrgGraph = store.org(config.org);
  const preloaded = opts.preloaded ?? DEFAULT_PRELOADED;
  const mutex = new Mutex();
  const limiter = new RateLimiter(opts.rateLimit ?? 30);
  let factsCache: { at: number; facts: Facts } | undefined;
  const app = new Hono();

  const clientKey = (c: { req: { header(n: string): string | undefined } }) =>
    c.req.header('fly-client-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';

  app.onError((err, c) => c.json({ error: err.message }, 500));

  app.get('/api/health', async (c) =>
    c.json({
      ok: true,
      version: packageVersion(),
      org: graph.name,
      falkordb: await store.serverVersion(),
      agent: opts.model
        ? { available: true, model: config.model, effort: config.effort, provider: config.modelCompatible ? new URL(config.modelBaseUrl!).hostname : 'api.anthropic.com' }
        : { available: false, reason: 'the server has no model API credentials (ANTHROPIC_API_KEY)' },
      busy: mutex.busy,
    }),
  );

  app.get('/api/stats', async (c) => {
    if (!factsCache || Date.now() - factsCache.at > 60_000) {
      factsCache = { at: Date.now(), facts: await collectFacts(graph, await store.serverVersion()) };
    }
    return c.json(factsCache.facts);
  });

  app.get('/api/prs', async (c) => {
    const rows = [];
    for (const url of preloaded) {
      const pr = (
        await graph.run<{ title: string; state: string; repo: string }>(`MATCH (p:PullRequest {url: $url}) RETURN p.title AS title, p.state AS state, p.repo AS repo`, { url })
      ).rows[0];
      const check = (
        await graph.run<{ id: string; model: string; status: string; summary: string; startedAt: number }>(
          `MATCH (c:Check)-[:FOR]->(:PullRequest {url: $url}) RETURN c.id AS id, c.model AS model, c.status AS status, c.summary AS summary, c.started_at AS startedAt ORDER BY startedAt DESC LIMIT 1`,
          { url },
        )
      ).rows[0];
      const runs = (
        await graph.run<{ example: string; side: string; status: string; error: string }>(
          `MATCH (r:Run)-[:AT]->(:PullRequest {url: $url}) MATCH (r)-[:OF]->(e:CodeExample) RETURN e.id AS example, r.side AS side, r.status AS status, r.error AS error ORDER BY example, side`,
          { url },
        )
      ).rows;
      rows.push({ url, ref: parsePrUrl(url), title: pr?.title ?? null, state: pr?.state ?? null, latestCheck: check ?? null, runs });
    }
    return c.json({ prs: rows });
  });

  app.get('/api/checks', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);
    return c.json({ checks: (await graph.run(Q.recentChecks, { limit })).rows });
  });

  app.get('/api/checks/:id', async (c) => {
    const row = (await graph.run<{ trace: string }>(Q.checkTrace, { id: c.req.param('id') })).rows[0];
    if (!row) return c.json({ error: 'no such check' }, 404);
    return c.json({ id: c.req.param('id'), events: JSON.parse(row.trace ?? '[]') as TraceEvent[] });
  });

  app.post('/api/check', async (c) => {
    if (!limiter.allow(`check:${clientKey(c)}`)) return c.json({ error: 'rate limited: try again later' }, 429);
    const body = await c.req.json<{ pr_url?: string; mode?: 'agent' | 'graph' }>().catch(() => ({}) as { pr_url?: string; mode?: 'agent' | 'graph' });
    let pr: string;
    try {
      pr = parsePrUrl(body.pr_url ?? '').url;
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const mode = body.mode ?? (opts.model ? 'agent' : 'graph');
    if (mode === 'agent' && !opts.model) {
      return c.json({ error: 'agent mode needs Claude API credentials on the server (ANTHROPIC_API_KEY); graph mode works without them', agentUnavailable: true }, 409);
    }
    return streamSSE(c, async (stream) => {
      let chain: Promise<unknown> = Promise.resolve();
      const send = (e: TraceEvent | { type: 'queued' } | { type: 'error'; message: string }) => {
        chain = chain.then(() => stream.writeSSE({ event: 'trace', data: JSON.stringify(e) })).catch(() => undefined);
      };
      if (mutex.busy) send({ type: 'queued' });
      try {
        await mutex.run(async () => {
          const ctx = { graph, config };
          if (mode === 'agent') await runAgentCheck(ctx, opts.model!(), pr, { onEvent: send });
          else await runGraphCheck(ctx, pr, { onEvent: send });
        });
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
      }
      await chain;
    });
  });

  app.get('/api/sections', async (c) => {
    const id = c.req.query('id');
    if (!id) return c.json({ error: 'id required' }, 400);
    const r = await readSectionTool.run({ graph, config }, { section_id: id });
    return r.data ? c.json(r.data) : c.json({ error: 'no such section' }, 404);
  });

  app.get('/api/patch', async (c) => {
    const pr = c.req.query('pr');
    if (!pr) return c.json({ error: 'pr required' }, 400);
    const patch = await buildDocsPatch({ graph, config }, parsePrUrl(pr).url);
    return c.json({ title: patch.title, body: patch.body, diff: patch.diff, files: patch.files.map((f) => ({ repo: f.repo, path: f.path, sections: f.sections })), verdicts: patch.verdicts, conflicts: patch.conflicts });
  });

  app.post('/api/decisions', async (c) => {
    if (!limiter.allow(`write:${clientKey(c)}`)) return c.json({ error: 'rate limited: try again later' }, 429);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const parsed = writeDecisionTool.input.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    if (parsed.data.text.length > 500) return c.json({ error: 'decision text is limited to 500 characters' }, 400);
    try {
      const r = await writeDecisionTool.run({ graph, config }, parsed.data);
      return c.json({ ...r.data, summary: r.summary });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/api/verdicts/:id/review', async (c) => {
    if (!limiter.allow(`write:${clientKey(c)}`)) return c.json({ error: 'rate limited: try again later' }, 429);
    const body = await c.req.json<{ status?: string; by?: string }>().catch(() => ({}) as { status?: string; by?: string });
    if (body.status !== 'accepted' && body.status !== 'rejected') return c.json({ error: 'status must be accepted or rejected' }, 400);
    const ok = await reviewVerdict({ graph, config }, c.req.param('id'), body.status, (body.by ?? 'web').slice(0, 60));
    return ok ? c.json({ ok }) : c.json({ error: 'no such verdict' }, 404);
  });

  app.get('/api/model', (c) =>
    c.json({
      queries: Q.ALL_QUERIES.map((q) => ({ name: q.name, group: q.group, purpose: q.purpose, cypher: q.cypher })),
      tools: ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, queries: t.queries.map((q) => q.name) })),
    }),
  );

  const webDir = opts.webDir ?? join(packageRoot(), 'web', 'dist');
  if (existsSync(webDir)) {
    const root = relative(process.cwd(), webDir) || '.';
    app.use('/assets/*', serveStatic({ root }));
    app.get('/favicon.svg', serveStatic({ root }));
    app.get('*', async (c) => c.html(await readFile(join(webDir, 'index.html'), 'utf8')));
  } else {
    app.get('/', (c) => c.text('Lockstep API is running. The web UI is not built (run `npm run build:web`).'));
  }
  return app;
}
