import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { GraphStore, OrgGraph } from '../graph/client.js';
import { DEFAULT_HOSTED_LIMITS, HostedLimitError, TRANSLATION_DIR, type HostedEvent, type HostedLimits, type Workspaces } from '../hosted/workspaces.js';
import { INDEX_VERSION, indexOrg, type IndexReport } from '../indexer/index.js';
import { parseRepoName, type Checkout } from '../indexer/repo.js';
import { RepoTooLargeError } from '../indexer/tarball.js';
import { downloadTree } from '../lint/sources.js';
import { isPrivateGraph, privateGraphName } from './guard.js';
import type { AppRegistry } from './registry.js';

/**
 * Private repositories the App reads, indexed into one graph per installation
 * (`ghp-<installation id>`) with the installation's token. The same limits as the hosted
 * workspaces (repositories per graph, graph size, least-recently-used eviction), but
 * recorded in the App's registry, never the hosted one: nothing public can find them.
 * When a graph would hold more repositories than the limit, the least recently used
 * ones leave it (the graph is rebuilt without them).
 */
export class PrivateWorkspaces {
  readonly limits: HostedLimits;
  private readonly fetchImpl?: typeof fetch;
  private readonly hosted?: Workspaces;

  constructor(
    private readonly store: GraphStore,
    private readonly config: Config,
    private readonly registry: AppRegistry,
    opts: { limits?: Partial<HostedLimits>; fetchImpl?: typeof fetch; hosted?: Workspaces } = {},
  ) {
    this.limits = { ...DEFAULT_HOSTED_LIMITS, ...opts.limits, tarball: { ...DEFAULT_HOSTED_LIMITS.tarball, ...opts.limits?.tarball } };
    this.fetchImpl = opts.fetchImpl;
    this.hosted = opts.hosted;
  }

  graphFor(installationId: number): OrgGraph {
    return this.store.org(privateGraphName(installationId));
  }

  /** Whether the installation's graph holds `repo`. */
  async has(installationId: number, repo: string): Promise<boolean> {
    const name = parseRepoName(repo).toLowerCase();
    return (await this.registry.indexed(privateGraphName(installationId))).some((r) => r.name === name);
  }

  /**
   * The installation's graph with `repo` (and `with`) indexed in it: indexed now when it
   * is missing, older than `staleAfterMs`, written by an older Staleproof, or `refresh`.
   */
  async ensure(
    installationId: number,
    repo: string,
    token: string,
    opts: { with?: string[]; refresh?: boolean; onEvent?: (e: HostedEvent) => void } = {},
  ): Promise<{ graph: OrgGraph; report?: IndexReport; skipped: string[] }> {
    const graphName = privateGraphName(installationId);
    const name = parseRepoName(repo).toLowerCase();
    const extra = [...new Set((opts.with ?? []).map((r) => parseRepoName(r).toLowerCase()))].filter((r) => r !== name);
    const current = await this.registry.indexed(graphName);
    const entry = current.find((r) => r.name === name);
    const missing = extra.filter((r) => !current.some((c) => c.name === r));
    const stale = entry && (Date.now() - entry.indexedAt > this.limits.staleAfterMs || (entry.indexVersion ?? 0) < INDEX_VERSION);
    if (entry && !missing.length && !stale && !opts.refresh) {
      await this.registry.touchIndexed(graphName, name);
      return { graph: this.store.org(graphName), skipped: [] };
    }
    const wanted = [name, ...extra];
    if (wanted.length > this.limits.maxRepos) {
      throw new HostedLimitError(`${name} with also-index would put ${wanted.length} repositories in one graph (limit ${this.limits.maxRepos}): ${wanted.join(', ')}`);
    }
    const others = current
      .filter((r) => !wanted.includes(r.name))
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .map((r) => r.name);
    const repos = [...wanted, ...others].slice(0, this.limits.maxRepos);
    const reason = !entry ? 'new' : missing.length ? 'added' : stale ? 'stale' : 'refresh';
    const { report, skipped } = await this.index(graphName, repos, token, reason, new Set(extra.concat(others)), current.length > 0 && current.some((r) => !repos.includes(r.name)), opts.onEvent);
    return { graph: this.store.org(graphName), report, skipped };
  }

  private async index(
    graphName: string,
    repos: string[],
    token: string,
    reason: Extract<HostedEvent, { type: 'index_started' }>['reason'],
    optional: Set<string>,
    rebuild: boolean,
    onEvent: (e: HostedEvent) => void = () => {},
  ): Promise<{ report: IndexReport; skipped: string[] }> {
    if (!isPrivateGraph(graphName)) throw new Error(`refusing to index into ${graphName}: not an App graph`);
    const me = randomUUID();
    const deadline = Date.now() + 150_000;
    while (!(await this.registry.lock(graphName, me, 170_000))) {
      if (Date.now() > deadline) throw new HostedLimitError(`${graphName} is being indexed by another request; try again in a minute`);
      onEvent({ type: 'index_progress', phase: 'checkout', message: `waiting for another request indexing ${graphName}`, at: Date.now() });
      await new Promise((r) => setTimeout(r, 3000));
    }
    const checkouts: Checkout[] = [];
    try {
      if (!(await this.registry.withinDailyBudget('private-index', this.limits.indexesPerDay))) {
        throw new HostedLimitError(`the App has indexed ${this.limits.indexesPerDay} private workspaces today, its daily limit; the next check will index it`);
      }
      onEvent({ type: 'index_started', repos, graph: graphName, reason, at: Date.now() });
      await this.makeRoom(graphName, onEvent);
      const started = Date.now();
      const files: Record<string, string[]> = {};
      const skipped: string[] = [];
      for (const repo of repos) {
        onEvent({ type: 'index_progress', repo, phase: 'download', message: `downloading ${repo}`, at: Date.now() });
        try {
          // The installation token reads the private archive (codeload answers 404 for it first).
          const c = await downloadTree(this.config.home, repo, 'HEAD', { token, limits: this.limits.tarball, fetchImpl: this.fetchImpl, skip: (p) => TRANSLATION_DIR.test(p) });
          checkouts.push({ repo: c.repo, dir: c.dir, sha: c.sha });
          files[c.repo] = c.paths;
        } catch (err) {
          // An also-index repository the installation cannot read is left out, not fatal.
          if (!optional.has(repo) || !/not found/i.test((err as Error).message)) throw err;
          skipped.push(repo);
          onEvent({ type: 'index_progress', repo, phase: 'download', message: `${repo} skipped: the installation cannot read it`, at: Date.now() });
        }
      }
      const graph = this.store.org(graphName);
      // Repositories leaving the graph: start from an empty graph so none of their nodes stay behind.
      if (rebuild || skipped.length) {
        await graph.drop();
        await this.registry.dropIndexed(graphName);
      }
      const report = await indexOrg(graph, checkouts, (p) => onEvent({ type: 'index_progress', repo: p.repo, phase: p.phase, message: p.message, at: Date.now() }), {
        lint: { files },
      });
      const mb = await this.store.graphMemoryMb(graphName);
      if (mb !== undefined && mb > this.limits.maxGraphMb) {
        await this.evict(graphName);
        throw new RepoTooLargeError(`${repos.join(' + ')} came to ${mb} MB of graph, over the limit of ${this.limits.maxGraphMb} MB for one installation. The GitHub Action checks repositories of any size.`);
      }
      await this.registry.recordIndexed(graphName, checkouts.map((c) => ({ name: c.repo, sha: c.sha })), { mb: mb ?? 0, version: INDEX_VERSION });
      onEvent({
        type: 'index_finished',
        graph: graphName,
        repos: report.repos.map((r) => {
          const d = report.docs.find((x) => x.repo === r.repo);
          return { repo: r.repo, sha: r.sha, files: r.files, symbols: r.symbols, sections: d?.sections ?? 0, examples: d?.examples.total ?? 0 };
        }),
        mb,
        ms: Date.now() - started,
        at: Date.now(),
      });
      return { report, skipped };
    } finally {
      await Promise.all(checkouts.map((c) => rm(c.dir, { recursive: true, force: true })));
      await this.registry.unlock(graphName, me).catch(() => undefined);
    }
  }

  /** Drop least recently used workspaces (private or hosted) until the server has room. */
  private async makeRoom(keep: string, onEvent: (e: HostedEvent) => void): Promise<void> {
    let { used } = await this.store.memoryMb();
    if (used <= this.limits.evictAboveMb) return;
    const candidates = (await this.registry.graphsByLastUse(keep)).map((c) => ({ ...c, hosted: false }));
    if (this.hosted) {
      for (const w of await this.hosted.list()) {
        if (w.curated || w.graph === keep || !w.graph.startsWith(this.hosted.prefix)) continue;
        candidates.push({ graph: w.graph, last: Math.max(0, ...w.repos.map((r) => r.lastUsed ?? 0)), hosted: true });
      }
    }
    candidates.sort((a, b) => a.last - b.last);
    for (const c of candidates) {
      if (used <= this.limits.evictToMb) break;
      onEvent({ type: 'index_progress', phase: 'evict', message: 'making room: dropping the least recently used workspace', at: Date.now() });
      if (c.hosted) await this.hosted!.evict(c.graph);
      else await this.evict(c.graph);
      used = (await this.store.memoryMb()).used;
    }
    if (used > this.limits.evictAboveMb) throw new HostedLimitError('the server is full right now; the next push or re-run will try again');
  }

  /** Drop a private graph and forget what it held (re-indexed on the next check). */
  async evict(graphName: string): Promise<void> {
    if (!isPrivateGraph(graphName)) throw new Error(`refusing to drop ${graphName}: not an App graph`);
    await this.store.org(graphName).drop();
    await this.registry.dropIndexed(graphName);
  }

  async evictInstallation(installationId: number): Promise<void> {
    await this.evict(privateGraphName(installationId));
  }
}
