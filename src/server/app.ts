import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
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
import { HostedLimitError, Workspaces, type HostedEvent } from '../hosted/workspaces.js';
import { RepoTooLargeError } from '../indexer/tarball.js';
import { parseRepoName } from '../indexer/repo.js';
import { NotIndexedError } from '../pr/ingest.js';
import { handleMcpRequest } from '../mcp/http.js';

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
  /**
   * Hosted mode: any public repository is indexed on demand into its own workspace graph
   * (see src/hosted/workspaces.ts). Without it the server answers from the one org graph.
   */
  workspaces?: Workspaces;
  /** Hosted mode: agent checks per day across the service (they cost model tokens). */
  agentChecksPerDay?: number;
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
  const hosted = opts.workspaces;
  const preloaded = opts.preloaded ?? DEFAULT_PRELOADED;
  const mutex = new Mutex();
  const limiter = new RateLimiter(opts.rateLimit ?? 30);
  let factsCache: { at: number; facts: Facts } | undefined;
  const app = new Hono();

  const clientKey = (c: { req: { header(n: string): string | undefined } }) =>
    c.req.header('x-real-ip') ?? c.req.header('fly-client-ip') ?? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() ?? 'local';

  /** The graph holding a repository: its hosted workspace, or the org graph. */
  const graphForRepo = async (repo: string): Promise<OrgGraph | undefined> => {
    if (!hosted) return graph;
    return (await hosted.locate(repo))?.graph;
  };
  /** Graphs to search for an id (check, verdict) that doesn't name its repository. */
  const searchGraphs = async (): Promise<OrgGraph[]> => (hosted ? hosted.graphs() : [graph]);
  const findIn = async <T>(query: string, params: Record<string, unknown>): Promise<{ graph: OrgGraph; row: T } | undefined> => {
    for (const g of await searchGraphs()) {
      const row = (await g.run<T>(query, params)).rows[0];
      if (row) return { graph: g, row };
    }
    return undefined;
  };
  const repoOfId = (id: string) => /^([\w.-]+\/[\w.-]+):/.exec(id)?.[1];
  const userError = (err: unknown) => err instanceof HostedLimitError || err instanceof RepoTooLargeError || err instanceof NotIndexedError;

  app.onError((err, c) => c.json({ error: err.message }, userError(err) ? 400 : 500));

  app.get('/api/health', async (c) => {
    const memory = hosted ? await store.memoryMb().catch(() => undefined) : undefined;
    return c.json({
      ok: true,
      version: packageVersion(),
      org: graph.name,
      falkordb: await store.serverVersion(),
      agent: opts.model
        ? { available: true, model: config.model, effort: config.effort, provider: config.modelCompatible ? new URL(config.modelBaseUrl!).hostname : 'api.anthropic.com' }
        : { available: false, reason: 'the server has no model API credentials (ANTHROPIC_API_KEY)' },
      busy: mutex.busy,
      hosted: hosted
        ? {
            enabled: true,
            limits: { maxRepos: hosted.limits.maxRepos, maxFiles: hosted.limits.tarball.maxFiles, maxGraphMb: hosted.limits.maxGraphMb },
            memory,
            githubToken: !!config.githubToken,
          }
        : { enabled: false },
    });
  });

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
    const raw = Number(c.req.query('limit') ?? 20);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 100) : 20;
    // Hosted: the newest checks across the curated graph and the most recently used workspaces.
    const graphs = (await searchGraphs()).slice(0, 8);
    const rows: (Record<string, unknown> & { startedAt: number })[] = [];
    for (const g of graphs) {
      for (const r of (await g.run<Record<string, unknown> & { startedAt: number }>(Q.recentChecks, { limit })).rows) rows.push({ ...r, org: g.name });
    }
    rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return c.json({ checks: rows.slice(0, limit) });
  });

  app.get('/api/checks/:id', async (c) => {
    const found = await findIn<{ trace: string }>(Q.checkTrace.cypher, { id: c.req.param('id') });
    if (!found) return c.json({ error: 'no such check' }, 404);
    return c.json({ id: c.req.param('id'), org: found.graph.name, events: JSON.parse(found.row.trace ?? '[]') as TraceEvent[] });
  });

  /** Hosted: which workspace holds a repository (and whether it needs indexing first). */
  app.get('/api/repos', async (c) => {
    let name: string;
    try {
      name = parseRepoName(c.req.query('name') ?? '');
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    if (!hosted) {
      const row = (await graph.run<{ sha: string; at: number }>(`MATCH (r:Repo {name: $name}) RETURN r.sha AS sha, r.indexed_at AS at`, { name })).rows[0];
      return c.json({ name, indexed: !!row, graph: graph.name, curated: true, sha: row?.sha ?? null, indexedAt: row?.at ?? null });
    }
    const found = await hosted.locate(name);
    if (!found) return c.json({ name, indexed: false, graph: hosted.graphNameFor(name), curated: false, sha: null, indexedAt: null });
    const row = (await found.graph.run<{ sha: string; at: number; name: string }>(`MATCH (r:Repo) WHERE toLower(r.name) = toLower($name) RETURN r.name AS name, r.sha AS sha, r.indexed_at AS at`, { name })).rows[0];
    const others = (await found.graph.run<{ name: string }>(`MATCH (r:Repo) RETURN r.name AS name ORDER BY name`)).rows.map((r) => r.name);
    return c.json({ name: row?.name ?? name, indexed: true, graph: found.graph.name, curated: found.curated, sha: row?.sha ?? null, indexedAt: row?.at ?? null, workspace: others });
  });

  app.get('/api/workspaces', async (c) => {
    if (!hosted) return c.json({ workspaces: [] });
    const list = await hosted.list();
    return c.json({ workspaces: list.map((w) => ({ graph: w.graph, curated: w.curated, repos: w.repos.map((r) => ({ name: r.name, sha: r.sha, indexedAt: r.indexedAt, lastUsed: r.lastUsed })) })) });
  });

  /** Hosted: index public repositories into one workspace, streaming progress. */
  app.post('/api/index', async (c) => {
    if (!hosted) return c.json({ error: 'this server indexes from the CLI only: staleproof index <owner/repo>...' }, 404);
    if (!limiter.allow(`index:${clientKey(c)}`)) return c.json({ error: 'rate limited: try again later' }, 429);
    const body = await c.req.json<{ repos?: unknown; refresh?: boolean }>().catch(() => ({}) as { repos?: unknown; refresh?: boolean });
    let repos: string[];
    try {
      repos = (Array.isArray(body.repos) ? body.repos : typeof body.repos === 'string' ? [body.repos] : []).map((r) => parseRepoName(String(r)));
      if (!repos.length) throw new Error('repos required: ["owner/name", ...]');
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return streamSSE(c, async (stream) => {
      let chain: Promise<unknown> = Promise.resolve();
      const send = (e: HostedEvent | { type: 'indexed'; graph: string; curated: boolean } | { type: 'error'; message: string }) => {
        chain = chain.then(() => stream.writeSSE({ event: 'trace', data: JSON.stringify(e) })).catch(() => undefined);
      };
      try {
        const r = await mutex.run(() => hosted.ensure(repos[0]!, { with: repos.slice(1), refresh: body.refresh === true, onEvent: send }));
        send({ type: 'indexed', graph: r.graph.name, curated: r.curated });
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
      }
      await chain;
    });
  });

  app.post('/api/check', async (c) => {
    if (!limiter.allow(`check:${clientKey(c)}`)) return c.json({ error: 'rate limited: try again later' }, 429);
    const body = await c.req.json<{ pr_url?: string; mode?: 'agent' | 'graph'; with?: unknown }>().catch(() => ({}) as { pr_url?: string; mode?: 'agent' | 'graph'; with?: unknown });
    let pr: string;
    let repo: string;
    let withRepos: string[] = [];
    try {
      const ref = parsePrUrl(body.pr_url ?? '');
      pr = ref.url;
      repo = ref.fullName;
      withRepos = (Array.isArray(body.with) ? body.with : []).map((r) => parseRepoName(String(r)));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const mode = body.mode ?? (opts.model ? 'agent' : 'graph');
    if (mode === 'agent' && !opts.model) {
      return c.json({ error: 'agent mode needs model API credentials on the server (ANTHROPIC_API_KEY); graph mode works without them', agentUnavailable: true }, 409);
    }
    if (mode === 'agent' && hosted && !(await hosted.withinDailyBudget('agent', opts.agentChecksPerDay ?? 150))) {
      return c.json({ error: "today's hosted agent checks are used up; graph mode still works, and the agent runs anywhere with your own key (npx -y staleproof check <pr-url>)", agentUnavailable: true }, 429);
    }
    const t0 = Date.now();
    return streamSSE(c, async (stream) => {
      let chain: Promise<unknown> = Promise.resolve();
      const send = (e: TraceEvent | HostedEvent | { type: 'queued' } | { type: 'error'; message: string }) => {
        chain = chain.then(() => stream.writeSSE({ event: 'trace', data: JSON.stringify(e) })).catch(() => undefined);
      };
      if (mutex.busy) send({ type: 'queued' });
      try {
        await mutex.run(async () => {
          const target = hosted ? await hosted.ensure(repo, { with: withRepos, onEvent: send }) : { graph, curated: true };
          const ctx = { graph: target.graph, config };
          // Indexing came out of the same function-time budget.
          const budgetMs = config.checkBudgetMs ? Math.max(45_000, config.checkBudgetMs - (Date.now() - t0)) : undefined;
          if (mode === 'agent') await runAgentCheck(ctx, opts.model!(), pr, { onEvent: send, budgetMs });
          // A hosted workspace has no recorded runs and the server no sandbox: don't try examples there.
          else await runGraphCheck(ctx, pr, { onEvent: send, maxRuns: target.curated ? undefined : 0 });
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
    const g = repoOfId(id) ? await graphForRepo(repoOfId(id)!) : graph;
    if (!g) return c.json({ error: 'no such section' }, 404);
    const r = await readSectionTool.run({ graph: g, config }, { section_id: id });
    return r.data ? c.json(r.data) : c.json({ error: 'no such section' }, 404);
  });

  app.get('/api/patch', async (c) => {
    let pr: ReturnType<typeof parsePrUrl>;
    try {
      pr = parsePrUrl(c.req.query('pr') ?? '');
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const g = await graphForRepo(pr.fullName);
    if (!g) return c.json({ error: `${pr.fullName} is not indexed` }, 404);
    const patch = await buildDocsPatch({ graph: g, config }, pr.url);
    return c.json({ title: patch.title, body: patch.body, diff: patch.diff, files: patch.files.map((f) => ({ repo: f.repo, path: f.path, sections: f.sections })), verdicts: patch.verdicts, conflicts: patch.conflicts });
  });

  app.post('/api/decisions', async (c) => {
    if (!limiter.allow(`write:${clientKey(c)}`)) return c.json({ error: 'rate limited: try again later' }, 429);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const parsed = writeDecisionTool.input.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    if (parsed.data.text.length > 500) return c.json({ error: 'decision text is limited to 500 characters' }, 400);
    const repo = parsed.data.governs.map(repoOfId).find(Boolean);
    const g = repo ? await graphForRepo(repo) : graph;
    if (!g) return c.json({ error: `${repo} is not indexed` }, 404);
    try {
      const r = await writeDecisionTool.run({ graph: g, config }, parsed.data);
      return c.json({ ...r.data, summary: r.summary });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/api/verdicts/:id/review', async (c) => {
    if (!limiter.allow(`write:${clientKey(c)}`)) return c.json({ error: 'rate limited: try again later' }, 429);
    const body = await c.req.json<{ status?: string; by?: string }>().catch(() => ({}) as { status?: string; by?: string });
    if (body.status !== 'accepted' && body.status !== 'rejected') return c.json({ error: 'status must be accepted or rejected' }, 400);
    const found = await findIn<{ id: string }>(`MATCH (v:Verdict {id: $id}) RETURN v.id AS id`, { id: c.req.param('id') });
    if (!found) return c.json({ error: 'no such verdict' }, 404);
    const ok = await reviewVerdict({ graph: found.graph, config }, c.req.param('id'), body.status, (body.by ?? 'web').slice(0, 60));
    return ok ? c.json({ ok }) : c.json({ error: 'no such verdict' }, 404);
  });

  /** MCP over Streamable HTTP: the same tools for any MCP client, no install. */
  app.all('/api/mcp', (c) => handleMcpRequest(c.req.raw, { store, config, graph, workspaces: hosted }));

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
    // The docs as plain text for LLMs (emitted by the web build): /llms.txt, /llms-full.txt, /docs/<slug>.md, and crawler files.
    const text = (file: string, type: string) => async (c: Context) => {
      const path = join(webDir, file);
      if (!existsSync(path)) return c.notFound();
      return c.body(await readFile(path, 'utf8'), 200, { 'content-type': `${type}; charset=utf-8` });
    };
    app.get('/llms.txt', text('llms.txt', 'text/plain'));
    app.get('/llms-full.txt', text('llms-full.txt', 'text/plain'));
    app.get('/robots.txt', text('robots.txt', 'text/plain'));
    app.get('/sitemap.xml', text('sitemap.xml', 'application/xml'));
    app.get('/snapshot.json', text('snapshot.json', 'application/json'));
    app.get('/docs/:page{[a-z0-9-]+\\.md}', (c) => text(join('docs', c.req.param('page')), 'text/markdown')(c));
    app.get('*', async (c) => c.html(await readFile(join(webDir, 'index.html'), 'utf8')));
  } else {
    app.get('/', (c) => c.text('Staleproof API is running. The web UI is not built (run `npm run build:web`).'));
  }
  return app;
}
