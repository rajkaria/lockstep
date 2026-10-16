import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { orgSlug, type Config } from '../config.js';
import type { GraphStore, OrgGraph } from '../graph/client.js';
import { indexOrg, type IndexProgress, type IndexReport } from '../indexer/index.js';
import { parseRepoName, type Checkout } from '../indexer/repo.js';
import { downloadRepo, RepoTooLargeError, type TarballLimits } from '../indexer/tarball.js';

/**
 * Hosted workspaces: the graph that answers for a repository.
 *
 * Curated graphs (the configured org graph, e.g. `falkordb`) are never touched. Any other
 * public repository is indexed on demand into a graph named after its owner (`gh-<owner>`),
 * downloaded as a tarball (no git on serverless hosts). Every repository of a workspace is
 * indexed together, so calls and doc links across them resolve. The server has a memory
 * cap (FalkorDB Cloud's free tier is 100 MB), so the least recently used workspaces are
 * dropped when it fills up and indexed again the next time someone asks for them.
 */

export const HOSTED_PREFIX = 'gh-';
const REGISTRY = 'staleproof-hosted';

export interface HostedLimits {
  /** Repositories per workspace (indexed together on every refresh). */
  maxRepos: number;
  /** A workspace bigger than this after indexing is dropped and refused. */
  maxGraphMb: number;
  /** Evict least recently used workspaces when the server uses more than this… */
  evictAboveMb: number;
  /** …until it uses less than this. */
  evictToMb: number;
  /** Re-index a workspace at its default branch's head when it is older than this. */
  staleAfterMs: number;
  /** Indexing runs started per day across the service. */
  indexesPerDay: number;
  tarball: TarballLimits;
}

export const DEFAULT_HOSTED_LIMITS: HostedLimits = {
  maxRepos: 4,
  maxGraphMb: 20,
  evictAboveMb: 70,
  evictToMb: 55,
  staleAfterMs: 7 * 24 * 3600_000,
  indexesPerDay: 500,
  tarball: { maxBytes: 150 * 1024 * 1024, maxFiles: 3000 },
};

export class HostedLimitError extends Error {}

export interface WorkspaceRepo {
  name: string;
  graph: string;
  sha: string;
  indexedAt: number;
  lastUsed: number;
}

export interface WorkspaceInfo {
  graph: string;
  curated: boolean;
  repos: WorkspaceRepo[];
}

/** Language directories of translated docs (docs/zh/, docs/pt-BR/): skipped by the hosted index. */
const LANGS =
  'ar|az|bg|bn|ca|cs|da|de|el|eo|es|et|fa|fi|fr|he|hi|hr|hu|hy|id|it|ja|ka|kk|ko|lt|lv|ms|nb|nl|no|pl|pt|ro|ru|sk|sl|sq|sr|sv|ta|th|tl|tr|uk|ur|uz|vi|yo|zh';
export const TRANSLATION_DIR = new RegExp(`(^|/)(docs?|documentation|i18n|locales?|translations?|content)/(${LANGS})([-_][A-Za-z]{2,4})?/`);

export type HostedEvent =
  | { type: 'index_started'; repos: string[]; graph: string; reason: 'new' | 'stale' | 'added' | 'refresh'; at: number }
  | { type: 'index_progress'; repo?: string; phase: IndexProgress['phase'] | 'download' | 'evict'; message: string; at: number }
  | {
      type: 'index_finished';
      graph: string;
      repos: { repo: string; sha: string; files: number; symbols: number; sections: number; examples: number }[];
      mb?: number;
      ms: number;
      at: number;
    };

export interface WorkspacesOptions {
  limits?: Partial<HostedLimits>;
  /** Graph name prefix of hosted workspaces (default `gh-`); only these are ever dropped. */
  prefix?: string;
  /** The registry graph (default `staleproof-hosted`). */
  registry?: string;
  /** Downloads (tests). */
  fetchImpl?: typeof fetch;
}

export class Workspaces {
  private readonly registry: OrgGraph;
  readonly limits: HostedLimits;
  readonly prefix: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(
    private readonly store: GraphStore,
    private readonly config: Config,
    /** The curated graph (configured org). */
    readonly curated: OrgGraph,
    opts: WorkspacesOptions = {},
  ) {
    this.registry = store.org(opts.registry ?? REGISTRY);
    this.limits = { ...DEFAULT_HOSTED_LIMITS, ...opts.limits, tarball: { ...DEFAULT_HOSTED_LIMITS.tarball, ...opts.limits?.tarball } };
    this.prefix = opts.prefix ?? HOSTED_PREFIX;
    this.fetchImpl = opts.fetchImpl;
  }

  graph(name: string): OrgGraph {
    return this.store.org(name);
  }

  /** The workspace graph name a repository is indexed into when it isn't anywhere yet. */
  graphNameFor(repo: string): string {
    return `${this.prefix}${orgSlug(parseRepoName(repo).split('/')[0]!)}`;
  }

  /** The graph that holds `repo`, or undefined when nobody has indexed it. */
  async locate(repo: string): Promise<{ graph: OrgGraph; curated: boolean; entry?: WorkspaceRepo } | undefined> {
    const name = parseRepoName(repo);
    const inCurated = await this.curated.run<{ n: string }>(`MATCH (r:Repo) WHERE toLower(r.name) = toLower($name) RETURN r.name AS n LIMIT 1`, { name });
    if (inCurated.rows.length) return { graph: this.curated, curated: true };
    const entry = await this.entry(name);
    if (!entry) return undefined;
    return { graph: this.graph(entry.graph), curated: false, entry };
  }

  private async entry(name: string): Promise<WorkspaceRepo | undefined> {
    const rows = await this.registry.run<WorkspaceRepo>(
      `MATCH (r:HostedRepo) WHERE toLower(r.name) = toLower($name) RETURN r.name AS name, r.graph AS graph, r.sha AS sha, r.indexed_at AS indexedAt, r.last_used AS lastUsed`,
      { name },
    );
    return rows.rows[0];
  }

  private async reposOf(graph: string): Promise<WorkspaceRepo[]> {
    return (
      await this.registry.run<WorkspaceRepo>(
        `MATCH (r:HostedRepo {graph: $graph}) RETURN r.name AS name, r.graph AS graph, r.sha AS sha, r.indexed_at AS indexedAt, r.last_used AS lastUsed ORDER BY name`,
        { graph },
      )
    ).rows;
  }

  /** Every workspace: the curated graph and the hosted ones, most recently used first. */
  async list(): Promise<WorkspaceInfo[]> {
    const curatedRepos = (await this.curated.run<{ name: string; sha: string; at: number }>(`MATCH (r:Repo) RETURN r.name AS name, r.sha AS sha, r.indexed_at AS at ORDER BY name`)).rows;
    const out: WorkspaceInfo[] = [
      {
        graph: this.curated.name,
        curated: true,
        repos: curatedRepos.map((r) => ({ name: r.name, graph: this.curated.name, sha: r.sha, indexedAt: r.at, lastUsed: r.at })),
      },
    ];
    const rows = (
      await this.registry.run<WorkspaceRepo>(
        `MATCH (r:HostedRepo) RETURN r.name AS name, r.graph AS graph, r.sha AS sha, r.indexed_at AS indexedAt, r.last_used AS lastUsed ORDER BY lastUsed DESC`,
      )
    ).rows;
    const byGraph = new Map<string, WorkspaceRepo[]>();
    for (const r of rows) byGraph.set(r.graph, [...(byGraph.get(r.graph) ?? []), r]);
    for (const [graph, repos] of byGraph) out.push({ graph, curated: false, repos: repos.sort((a, b) => a.name.localeCompare(b.name)) });
    return out;
  }

  /** Graphs to search for a check or verdict id: curated first, then hosted by recent use. */
  async graphs(): Promise<OrgGraph[]> {
    return (await this.list()).map((w) => (w.curated ? this.curated : this.graph(w.graph)));
  }

  async touch(repo: string): Promise<void> {
    await this.registry.run(`MATCH (r:HostedRepo) WHERE toLower(r.name) = toLower($name) SET r.last_used = $now`, { name: repo, now: Date.now() });
  }

  /**
   * The graph for `repo`, indexing it first when no graph has it (or its workspace is
   * older than `staleAfterMs`). `with` adds repositories to index together with it — the
   * docs site of a library, say — so cross-repository paths resolve.
   */
  async ensure(
    repo: string,
    opts: { with?: string[]; refresh?: boolean; onEvent?: (e: HostedEvent) => void } = {},
  ): Promise<{ graph: OrgGraph; curated: boolean; report?: IndexReport }> {
    // Hosted workspaces name repositories in lower case (GitHub names are case-insensitive); curated ones keep their spelling.
    const name = parseRepoName(repo).toLowerCase();
    const extra = (opts.with ?? []).map((r) => parseRepoName(r).toLowerCase()).filter((r) => r !== name);
    const found = await this.locate(name);
    if (found?.curated) {
      if (extra.length) throw new HostedLimitError(`${name} is in the curated "${found.graph.name}" graph, which the hosted service does not re-index; index other repositories on their own.`);
      return found;
    }
    const missing: string[] = [];
    for (const r of extra) {
      const where = await this.locate(r);
      if (!where || where.graph.name !== found?.graph.name) missing.push(r);
    }
    const stale = found?.entry && Date.now() - found.entry.indexedAt > this.limits.staleAfterMs;
    if (found && !missing.length && !stale && !opts.refresh) {
      await this.touch(name);
      return found;
    }
    const graphName = found?.graph.name ?? this.graphNameFor(name);
    const current = (await this.reposOf(graphName)).map((r) => r.name);
    const repos = [...new Set([...current, name, ...missing].map((r) => r))];
    if (repos.length > this.limits.maxRepos) {
      throw new HostedLimitError(
        `the hosted workspace ${graphName} would hold ${repos.length} repositories (limit ${this.limits.maxRepos}: ${repos.join(', ')}). Run Staleproof yourself for bigger organisations: npx -y staleproof index ${repos.join(' ')}`,
      );
    }
    const reason = !found ? 'new' : missing.length ? 'added' : stale ? 'stale' : 'refresh';
    const report = await this.index(graphName, repos, reason, opts.onEvent);
    return { graph: this.graph(graphName), curated: false, report };
  }

  /** Index `repos` together into the hosted graph `graphName`, holding a lock across instances. */
  private async index(graphName: string, repos: string[], reason: Extract<HostedEvent, { type: 'index_started' }>['reason'], onEvent: (e: HostedEvent) => void = () => {}): Promise<IndexReport> {
    if (!graphName.startsWith(this.prefix)) throw new Error(`refusing to index into ${graphName}: not a hosted workspace`);
    const me = randomUUID();
    const deadline = Date.now() + 150_000;
    // Another request (maybe another server instance) may be indexing the same workspace: wait for it.
    for (;;) {
      const lock = await this.registry.run<{ mine: boolean; until: number }>(
        `MERGE (l:Lock {graph: $graph})
         WITH l, (coalesce(l.until, 0) < $now OR l.owner = $me) AS free
         SET l.owner = CASE WHEN free THEN $me ELSE l.owner END, l.until = CASE WHEN free THEN $until ELSE l.until END
         RETURN l.owner = $me AS mine, l.until AS until`,
        { graph: graphName, me, now: Date.now(), until: Date.now() + 170_000 },
      );
      if (lock.rows[0]?.mine) break;
      if (Date.now() > deadline) throw new HostedLimitError(`${graphName} is being indexed by another request; try again in a minute`);
      onEvent({ type: 'index_progress', phase: 'checkout', message: `waiting for another request indexing ${graphName}`, at: Date.now() });
      await new Promise((r) => setTimeout(r, 3000));
      const done = await Promise.all(repos.map((r) => this.entry(r)));
      if (done.every((e) => e && Date.now() - e.indexedAt < 60_000)) {
        return { org: graphName, run: 'concurrent', repos: [], docs: [], dependsOn: [], ms: 0 };
      }
    }
    try {
      await this.countIndexRun();
      onEvent({ type: 'index_started', repos, graph: graphName, reason, at: Date.now() });
      await this.makeRoom(graphName, onEvent);
      const started = Date.now();
      const checkouts: Checkout[] = [];
      for (const repo of repos) {
        onEvent({ type: 'index_progress', repo, phase: 'download', message: `downloading ${repo}`, at: Date.now() });
        // No token: the hosted service indexes public repositories only, whatever its GITHUB_TOKEN can read.
        const c = await downloadRepo(this.config.home, repo, 'HEAD', {
          token: undefined,
          limits: this.limits.tarball,
          fetchImpl: this.fetchImpl,
          skip: (path) => TRANSLATION_DIR.test(path),
        });
        onEvent({ type: 'index_progress', repo, phase: 'download', message: `${repo}@${c.sha.slice(0, 7)} downloaded`, at: Date.now() });
        checkouts.push(c);
      }
      const graph = this.graph(graphName);
      const report = await indexOrg(graph, checkouts, (p) => onEvent({ type: 'index_progress', repo: p.repo, phase: p.phase, message: p.message, at: Date.now() })).finally(() =>
        // The extracted files are only read while indexing; serverless /tmp is small.
        Promise.all(checkouts.map((c) => rm(c.dir, { recursive: true, force: true }))),
      );
      const mb = await this.store.graphMemoryMb(graphName);
      if (mb !== undefined && mb > this.limits.maxGraphMb) {
        await graph.drop();
        await this.registry.run(`MATCH (r:HostedRepo {graph: $graph}) DELETE r`, { graph: graphName });
        throw new RepoTooLargeError(
          `${repos.join(' + ')} came to ${mb} MB of graph, over the hosted limit of ${this.limits.maxGraphMb} MB. Run it on your own FalkorDB: npx -y staleproof check <pr-url>, or the GitHub Action.`,
        );
      }
      const now = Date.now();
      await this.registry.run(
        `UNWIND $rows AS row
         MERGE (r:HostedRepo {name: row.name})
         SET r.graph = $graph, r.sha = row.sha, r.indexed_at = $now, r.last_used = $now, r.mb = $mb`,
        { rows: checkouts.map((c) => ({ name: c.repo, sha: c.sha })), graph: graphName, now, mb: mb ?? 0 },
      );
      onEvent({
        type: 'index_finished',
        graph: graphName,
        repos: report.repos.map((r) => {
          const d = report.docs.find((x) => x.repo === r.repo);
          return { repo: r.repo, sha: r.sha, files: r.files, symbols: r.symbols, sections: d?.sections ?? 0, examples: d?.examples.total ?? 0 };
        }),
        mb,
        ms: now - started,
        at: now,
      });
      return report;
    } finally {
      await this.registry.run(`MATCH (l:Lock {graph: $graph, owner: $me}) DELETE l`, { graph: graphName, me }).catch(() => undefined);
    }
  }

  /** Drop least recently used hosted workspaces until the server has room for another. */
  private async makeRoom(keep: string, onEvent: (e: HostedEvent) => void): Promise<void> {
    let { used } = await this.store.memoryMb();
    if (used <= this.limits.evictAboveMb) return;
    const candidates = (
      await this.registry.run<{ graph: string; last: number }>(`MATCH (r:HostedRepo) WHERE r.graph <> $keep RETURN r.graph AS graph, max(r.last_used) AS last ORDER BY last ASC`, { keep })
    ).rows;
    for (const c of candidates) {
      if (used <= this.limits.evictToMb) break;
      onEvent({ type: 'index_progress', phase: 'evict', message: `making room: dropping the least recently used workspace ${c.graph}`, at: Date.now() });
      await this.evict(c.graph);
      used = (await this.store.memoryMb()).used;
    }
    if (used > this.limits.evictAboveMb) {
      throw new HostedLimitError(
        'the hosted service is full right now. Run Staleproof on your own machine or in CI instead: npx -y staleproof check <pr-url>, or the GitHub Action.',
      );
    }
  }

  async evict(graphName: string): Promise<void> {
    if (!graphName.startsWith(this.prefix)) throw new Error(`refusing to drop ${graphName}: not a hosted workspace`);
    await this.graph(graphName).drop();
    await this.registry.run(`MATCH (r:HostedRepo {graph: $graph}) DELETE r`, { graph: graphName });
  }

  /** Count an indexing run against the service's daily budget. */
  private async countIndexRun(): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const n = (await this.registry.run<{ n: number }>(`MERGE (c:Counter {day: $day, kind: 'index'}) SET c.n = coalesce(c.n, 0) + 1 RETURN c.n AS n`, { day })).rows[0]?.n ?? 0;
    if (n > this.limits.indexesPerDay) {
      throw new HostedLimitError(`the hosted service has indexed ${this.limits.indexesPerDay} workspaces today, its daily limit. Run it yourself: npx -y staleproof check <pr-url>`);
    }
  }

  /**
   * A shared daily budget (agent checks cost model tokens): increments and returns
   * whether the call is still within `limit`.
   */
  async withinDailyBudget(kind: string, limit: number): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const n = (await this.registry.run<{ n: number }>(`MERGE (c:Counter {day: $day, kind: $kind}) SET c.n = coalesce(c.n, 0) + 1 RETURN c.n AS n`, { day, kind })).rows[0]?.n ?? 0;
    return n <= limit;
  }
}
