import type { GraphStore, OrgGraph } from '../graph/client.js';

/**
 * What the GitHub App remembers, in its own registry graph (`staleproof-app`, apart from
 * the hosted service's `staleproof-hosted`, so nothing public can list it):
 *
 * - `Delivery {id, at}`: webhook deliveries seen in the last 24 hours (a redelivery is ignored).
 * - `Installation {id, account, ...}` and `AppRepo {name, installation, private, ...}`: who
 *   installed the App and on which repositories (from the installation events).
 * - `IndexedRepo {graph, name, sha, ...}`: what each private graph (`ghp-<installation>`) holds.
 * - `AppCheckRun {id, fixes, ...}`: the verified fixes behind a check run's Apply fixes button.
 * - `Lock {graph}` and `Counter {day, kind}`: indexing one private graph at a time, and a daily budget.
 */

export const APP_REGISTRY = 'staleproof-app';
export const DELIVERY_TTL_MS = 24 * 3600_000;
/** Pushes to the default branch closer together than this refresh the index once (the rest mark it dirty). */
export const PUSH_DEBOUNCE_MS = 5 * 60_000;
/** Apply-fixes data is kept this long; an older check run is re-run first. */
export const CHECK_RUN_TTL_MS = 7 * 24 * 3600_000;

export interface InstallationRow {
  id: number;
  account: string;
  accountType: string;
  selection: string;
  suspended: boolean;
}

export interface AppRepoRow {
  name: string;
  fullName: string;
  installation: number;
  private: boolean;
  dirty: boolean;
  refreshedAt: number | null;
  cronAt: number | null;
}

export interface IndexedRepoRow {
  graph: string;
  name: string;
  sha: string;
  indexedAt: number;
  lastUsed: number;
  indexVersion: number | null;
}

export interface StoredCheckRun {
  id: number;
  repo: string;
  pr: number;
  head: string;
  fixes: unknown[];
  at: number;
}

export interface RepoRef {
  fullName: string;
  private: boolean;
}

export class AppRegistry {
  readonly graph: OrgGraph;

  constructor(store: GraphStore, name = APP_REGISTRY) {
    this.graph = store.org(name);
  }

  /** Whether this delivery was already seen in the last 24 hours (and remember it when not). */
  async seenDelivery(id: string, now = Date.now()): Promise<boolean> {
    await this.graph.run(`MATCH (d:Delivery) WHERE d.at < $cutoff DELETE d`, { cutoff: now - DELIVERY_TTL_MS });
    const claim = `${now}-${Math.random().toString(36).slice(2)}`;
    const r = await this.graph.run<{ fresh: boolean }>(`MERGE (d:Delivery {id: $id}) ON CREATE SET d.at = $now, d.claim = $claim RETURN d.claim = $claim AS fresh`, { id, now, claim });
    return !r.rows[0]?.fresh;
  }

  async recordInstallation(inst: Omit<InstallationRow, 'suspended'> & { suspended?: boolean }, repos: RepoRef[] = [], now = Date.now()): Promise<void> {
    await this.graph.run(
      `MERGE (i:Installation {id: $id})
       SET i.account = $account, i.account_type = $type, i.selection = $selection, i.suspended = $suspended, i.updated_at = $now, i.created_at = coalesce(i.created_at, $now)`,
      { id: inst.id, account: inst.account, type: inst.accountType, selection: inst.selection, suspended: inst.suspended ?? false, now },
    );
    if (repos.length) await this.addRepos(inst.id, repos, now);
  }

  async setSuspended(id: number, suspended: boolean): Promise<void> {
    await this.graph.run(`MATCH (i:Installation {id: $id}) SET i.suspended = $suspended`, { id, suspended });
  }

  async addRepos(installation: number, repos: RepoRef[], now = Date.now()): Promise<void> {
    await this.graph.run(
      `UNWIND $rows AS row
       MERGE (r:AppRepo {name: row.name})
       SET r.full_name = row.fullName, r.installation = $installation, r.private = row.private, r.added_at = coalesce(r.added_at, $now)`,
      { rows: repos.map((r) => ({ name: r.fullName.toLowerCase(), fullName: r.fullName, private: r.private })), installation, now },
    );
  }

  /** Forget repositories the installation no longer covers; returns the private ones. */
  async removeRepos(installation: number, names: string[]): Promise<string[]> {
    const rows = await this.graph.run<{ name: string; private: boolean }>(
      `MATCH (r:AppRepo) WHERE r.name IN $names AND r.installation = $installation
       WITH r, r.name AS name, coalesce(r.private, false) AS private
       DELETE r
       RETURN name, private`,
      { names: names.map((n) => n.toLowerCase()), installation },
    );
    return rows.rows.filter((r) => r.private).map((r) => r.name);
  }

  /** Forget an installation and its repositories. */
  async removeInstallation(id: number): Promise<void> {
    await this.graph.run(`MATCH (r:AppRepo {installation: $id}) DELETE r`, { id });
    await this.graph.run(`MATCH (i:Installation {id: $id}) DELETE i`, { id });
  }

  async installations(): Promise<InstallationRow[]> {
    return (
      await this.graph.run<InstallationRow>(
        `MATCH (i:Installation) RETURN i.id AS id, i.account AS account, i.account_type AS accountType, i.selection AS selection, coalesce(i.suspended, false) AS suspended ORDER BY id`,
      )
    ).rows;
  }

  async installation(id: number): Promise<InstallationRow | undefined> {
    return (await this.installations()).find((i) => i.id === id);
  }

  private static readonly REPO_FIELDS = `r.name AS name, r.full_name AS fullName, r.installation AS installation, coalesce(r.private, false) AS private,
    coalesce(r.dirty, false) AS dirty, r.refreshed_at AS refreshedAt, r.cron_at AS cronAt`;

  async repos(installation?: number): Promise<AppRepoRow[]> {
    return (
      await this.graph.run<AppRepoRow>(
        `MATCH (r:AppRepo) WHERE $installation IS NULL OR r.installation = $installation RETURN ${AppRegistry.REPO_FIELDS} ORDER BY name`,
        { installation: installation ?? null },
      )
    ).rows;
  }

  async repo(name: string): Promise<AppRepoRow | undefined> {
    return (await this.graph.run<AppRepoRow>(`MATCH (r:AppRepo {name: $name}) RETURN ${AppRegistry.REPO_FIELDS}`, { name: name.toLowerCase() })).rows[0];
  }

  /**
   * A push to the default branch: `true` when the index should be refreshed now (none in
   * the last 5 minutes), else the repository is marked dirty and refreshed later (the
   * next pull request check or the daily cron).
   */
  async pushRefresh(repo: RepoRef & { installation: number }, now = Date.now(), windowMs = PUSH_DEBOUNCE_MS): Promise<boolean> {
    const r = await this.graph.run<{ due: boolean }>(
      `MERGE (r:AppRepo {name: $name})
       ON CREATE SET r.full_name = $fullName, r.installation = $installation, r.private = $private, r.added_at = $now
       WITH r, coalesce(r.refreshed_at, 0) <= $cutoff AS due
       SET r.refreshed_at = CASE WHEN due THEN $now ELSE r.refreshed_at END, r.dirty = NOT due
       RETURN due`,
      { name: repo.fullName.toLowerCase(), fullName: repo.fullName, installation: repo.installation, private: repo.private, now, cutoff: now - windowMs },
    );
    return !!r.rows[0]?.due;
  }

  async markRefreshed(name: string, now = Date.now()): Promise<void> {
    await this.graph.run(`MATCH (r:AppRepo {name: $name}) SET r.refreshed_at = $now, r.dirty = false`, { name: name.toLowerCase(), now });
  }

  async markDirty(name: string): Promise<void> {
    await this.graph.run(`MATCH (r:AppRepo {name: $name}) SET r.dirty = true`, { name: name.toLowerCase() });
  }

  async markCron(name: string, now = Date.now()): Promise<void> {
    await this.graph.run(`MATCH (r:AppRepo {name: $name}) SET r.cron_at = $now`, { name: name.toLowerCase(), now });
  }

  async saveCheckRun(run: Omit<StoredCheckRun, 'at'>, now = Date.now()): Promise<void> {
    await this.graph.run(`MATCH (c:AppCheckRun) WHERE c.at < $cutoff DELETE c`, { cutoff: now - CHECK_RUN_TTL_MS });
    await this.graph.run(`MERGE (c:AppCheckRun {id: $id}) SET c.repo = $repo, c.pr = $pr, c.head = $head, c.fixes = $fixes, c.at = $now`, {
      id: run.id,
      repo: run.repo.toLowerCase(),
      pr: run.pr,
      head: run.head,
      fixes: JSON.stringify(run.fixes),
      now,
    });
  }

  async checkRun(id: number, now = Date.now()): Promise<StoredCheckRun | undefined> {
    const row = (
      await this.graph.run<Omit<StoredCheckRun, 'fixes'> & { fixes: string }>(
        `MATCH (c:AppCheckRun {id: $id}) WHERE c.at >= $cutoff RETURN c.id AS id, c.repo AS repo, c.pr AS pr, c.head AS head, c.fixes AS fixes, c.at AS at`,
        { id, cutoff: now - CHECK_RUN_TTL_MS },
      )
    ).rows[0];
    return row ? { ...row, fixes: JSON.parse(row.fixes ?? '[]') as unknown[] } : undefined;
  }

  // Private graphs: what each holds.

  private static readonly INDEXED_FIELDS = `x.graph AS graph, x.name AS name, x.sha AS sha, x.indexed_at AS indexedAt, x.last_used AS lastUsed, x.index_version AS indexVersion`;

  async indexed(graph: string): Promise<IndexedRepoRow[]> {
    return (await this.graph.run<IndexedRepoRow>(`MATCH (x:IndexedRepo {graph: $graph}) RETURN ${AppRegistry.INDEXED_FIELDS} ORDER BY name`, { graph })).rows;
  }

  async allIndexed(): Promise<IndexedRepoRow[]> {
    return (await this.graph.run<IndexedRepoRow>(`MATCH (x:IndexedRepo) RETURN ${AppRegistry.INDEXED_FIELDS} ORDER BY graph, name`)).rows;
  }

  async recordIndexed(graph: string, rows: { name: string; sha: string }[], meta: { mb: number; version: number }, now = Date.now()): Promise<void> {
    await this.graph.run(
      `UNWIND $rows AS row
       MERGE (x:IndexedRepo {graph: $graph, name: row.name})
       SET x.sha = row.sha, x.indexed_at = $now, x.last_used = $now, x.mb = $mb, x.index_version = $version`,
      { rows: rows.map((r) => ({ name: r.name.toLowerCase(), sha: r.sha })), graph, now, mb: meta.mb, version: meta.version },
    );
  }

  async touchIndexed(graph: string, name: string, now = Date.now()): Promise<void> {
    await this.graph.run(`MATCH (x:IndexedRepo {graph: $graph, name: $name}) SET x.last_used = $now`, { graph, name: name.toLowerCase(), now });
  }

  async dropIndexed(graph: string): Promise<void> {
    await this.graph.run(`MATCH (x:IndexedRepo {graph: $graph}) DELETE x`, { graph });
  }

  /** Private graphs by last use, oldest first (eviction order). */
  async graphsByLastUse(exclude?: string): Promise<{ graph: string; last: number }[]> {
    return (
      await this.graph.run<{ graph: string; last: number }>(`MATCH (x:IndexedRepo) WHERE x.graph <> $keep RETURN x.graph AS graph, max(x.last_used) AS last ORDER BY last ASC`, {
        keep: exclude ?? '',
      })
    ).rows;
  }

  /** Take the indexing lock of a graph for `ms` (or keep it, when `me` holds it); false while someone else holds it. */
  async lock(graph: string, me: string, ms: number, now = Date.now()): Promise<boolean> {
    const r = await this.graph.run<{ mine: boolean }>(
      `MERGE (l:Lock {graph: $graph})
       WITH l, (coalesce(l.until, 0) < $now OR l.owner = $me) AS free
       SET l.owner = CASE WHEN free THEN $me ELSE l.owner END, l.until = CASE WHEN free THEN $until ELSE l.until END
       RETURN l.owner = $me AS mine`,
      { graph, me, now, until: now + ms },
    );
    return !!r.rows[0]?.mine;
  }

  async unlock(graph: string, me: string): Promise<void> {
    await this.graph.run(`MATCH (l:Lock {graph: $graph, owner: $me}) DELETE l`, { graph, me });
  }

  /** Count one unit of a daily budget; true while still within `limit`. */
  async withinDailyBudget(kind: string, limit: number, now = Date.now()): Promise<boolean> {
    const day = new Date(now).toISOString().slice(0, 10);
    const n = (await this.graph.run<{ n: number }>(`MERGE (c:Counter {day: $day, kind: $kind}) SET c.n = coalesce(c.n, 0) + 1 RETURN c.n AS n`, { day, kind })).rows[0]?.n ?? 0;
    return n <= limit;
  }
}
