import type { Hono } from 'hono';
import type { AuditData } from '../audit.js';
import type { OrgGraph } from '../graph/client.js';
import { isPrivateGraph } from '../app/guard.js';
import { parseRepoName } from '../indexer/repo.js';
import { stampScript } from './stamp.js';

/**
 * The "checked" stamp's data: which docs pages of a repository Staleproof checked, against
 * which commit and when, and how many references on each are out of date. Read from the
 * hosted audit (the badge's cached audit); never indexes on its own.
 *
 *   GET /api/verified/<owner>/<repo>.json      per-page status, CORS *, cached 10 minutes at the CDN
 *   GET /api/verified/<owner>/<repo>/stamp.js  the embeddable script (src/server/stamp.ts)
 *
 * Private repositories (GitHub App installations, graphs `ghp-<installation id>`) are never
 * served: a source in such a graph answers exactly as a repository nobody indexed.
 */

/** Graphs of private repositories (spec R6.4): no public endpoint may read them. One rule, in src/app/guard.ts. */
export { isPrivateGraph, PRIVATE_PREFIX as PRIVATE_GRAPH_PREFIX } from '../app/guard.js';

export interface VerifiedPage {
  /** Repository-relative path of the docs page's source. */
  path: string;
  /** `drift`: an error or warning finding, an example line that no longer fits, or a failing run. */
  status: 'checked' | 'drift';
  /** Docs references (paths, links, commands, env vars, ...) out of date: errors and warnings. */
  findings: number;
  /** Example lines that no longer fit the code they call. */
  mismatches: number;
  /** Recorded runs of the page's examples at the indexed commit, when any ran. */
  runs?: { pass: number; fail: number };
  /** Code examples on the page. */
  examples: number;
  sha: string;
  /** When the repository was indexed and checked (ms since the epoch). */
  checkedAt: number;
}

export interface VerifiedData {
  version: 1;
  repo: string;
  sha: string;
  checkedAt: number;
  score: number;
  grade: AuditData['grade'];
  /** What was checked: references are linted from index version 4; examples statically checked from 3. */
  checks: { references: boolean; examples: boolean };
  pages: VerifiedPage[];
}

/** Everything the route needs about one repository, from wherever it is indexed. */
export interface VerifiedSource {
  /** The graph holding it (a `ghp-` graph is refused). */
  graph: string;
  repo: { name: string; sha: string; indexedAt: number };
  /** Docs pages the index holds, with their code examples. */
  pages: { path: string; examples: number }[];
  audit: AuditData;
}

const RUN_FAIL = new Set(['fail', 'timeout']);

/** The page path of an example id (`owner/name:docs/x.md:3`). */
function examplePath(id: string, repo: string): string | undefined {
  if (!id.toLowerCase().startsWith(`${repo.toLowerCase()}:`)) return undefined;
  const rest = id.slice(repo.length + 1);
  const at = rest.lastIndexOf(':');
  return at > 0 ? rest.slice(0, at) : undefined;
}

/** Per-page status from an audit (pure). Pages where nothing was checked are left out. */
export function verifiedData(src: VerifiedSource): VerifiedData {
  const { audit, repo } = src;
  const name = repo.name;
  const same = (r: string | undefined) => (r ?? name).toLowerCase() === name.toLowerCase();
  const info = audit.repos.find((r) => same(r.name));
  const checks = { references: info?.findingsChecked === true, examples: (info?.indexVersion ?? 0) >= 3 };
  const pages = new Map<string, VerifiedPage>();
  const page = (path: string): VerifiedPage => {
    let p = pages.get(path);
    if (!p) {
      p = { path, status: 'checked', findings: 0, mismatches: 0, examples: 0, sha: repo.sha, checkedAt: repo.indexedAt };
      pages.set(path, p);
    }
    return p;
  };
  for (const p of src.pages) page(p.path).examples = p.examples;
  for (const f of audit.findings ?? []) {
    if (!same(f.repo) || f.severity === 'info') continue;
    page(f.path).findings++;
  }
  for (const m of audit.mismatches) if (same(m.repo)) page(m.path).mismatches++;
  for (const r of audit.runs) {
    const path = examplePath(r.example, name);
    if (!path || (r.status !== 'pass' && !RUN_FAIL.has(r.status))) continue;
    const p = page(path);
    p.runs ??= { pass: 0, fail: 0 };
    if (r.status === 'pass') p.runs.pass++;
    else p.runs.fail++;
  }
  const out: VerifiedPage[] = [];
  for (const p of pages.values()) {
    if (p.findings || p.mismatches || p.runs?.fail) p.status = 'drift';
    // Nothing was checked on a page with no examples when references were not linted.
    else if (!checks.references && !(checks.examples && p.examples) && !p.runs?.pass) continue;
    out.push(p);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, repo: name, sha: repo.sha, checkedAt: repo.indexedAt, score: audit.score, grade: audit.grade, checks, pages: out };
}

/** The pages and commit of a repository in a graph, around its (cached) audit. Undefined when the graph does not hold it. */
export async function graphVerifiedSource(graph: OrgGraph, repo: string, audit: (name: string) => Promise<AuditData>): Promise<VerifiedSource | undefined> {
  if (isPrivateGraph(graph.name)) return undefined;
  const row = (
    await graph.run<{ name: string; sha: string; indexedAt: number | null }>(
      `MATCH (r:Repo) WHERE toLower(r.name) = toLower($name) RETURN r.name AS name, r.sha AS sha, r.indexed_at AS indexedAt LIMIT 1`,
      { name: repo },
    )
  ).rows[0];
  if (!row) return undefined;
  const sections = (await graph.run<{ path: string }>(`MATCH (d:DocSection {repo: $repo}) WHERE d.status = 'live' RETURN DISTINCT d.path AS path`, { repo: row.name })).rows;
  const examples = (
    await graph.run<{ path: string; n: number }>(`MATCH (e:CodeExample {repo: $repo}) WHERE e.status = 'live' AND e.kind = 'fenced' RETURN e.path AS path, count(e) AS n`, { repo: row.name })
  ).rows;
  const byPath = new Map<string, number>(sections.map((s) => [s.path, 0]));
  for (const e of examples) byPath.set(e.path, e.n);
  return {
    graph: graph.name,
    repo: { name: row.name, sha: row.sha, indexedAt: row.indexedAt ?? 0 },
    pages: [...byPath].map(([path, n]) => ({ path, examples: n })),
    audit: await audit(row.name),
  };
}

export interface VerifiedDeps {
  /** The repository's source (graph, pages, audit), or undefined when no public graph holds it. */
  load(repo: string): Promise<VerifiedSource | undefined>;
}

const CORS = { 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' };

/** Mount `GET /api/verified/<owner>/<repo>.json` and `GET /api/verified/<owner>/<repo>/stamp.js`. */
export function registerVerifiedRoutes(app: Hono, deps: VerifiedDeps): void {
  const json = (body: unknown, status: 200 | 400 | 404 | 503, cache: string) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': cache } });

  app.get('/api/verified/:owner/:file{[^/]+\\.json}', async (c) => {
    let repo: string;
    try {
      repo = parseRepoName(`${c.req.param('owner')}/${c.req.param('file').replace(/\.json$/i, '')}`);
    } catch (err) {
      return json({ error: (err as Error).message }, 400, 'public, max-age=300');
    }
    let src: VerifiedSource | undefined;
    try {
      src = await deps.load(repo);
    } catch (err) {
      return json({ error: `could not read ${repo}: ${(err as Error).message}` }, 503, 'no-store');
    }
    if (!src || isPrivateGraph(src.graph)) {
      return json(
        { error: `${repo} has no audit on this server yet: audit it once (https://staleproof.dev/#/audit?repo=${repo}) and the stamp appears.`, indexed: false },
        404,
        'public, max-age=60, s-maxage=300',
      );
    }
    return json(verifiedData(src), 200, 'public, max-age=300, s-maxage=600');
  });

  app.get('/api/verified/:owner/:name/stamp.js', (c) => {
    let repo: string;
    try {
      repo = parseRepoName(`${c.req.param('owner')}/${c.req.param('name')}`);
    } catch {
      return c.body('/* not a GitHub repository name */', 400, { ...CORS, 'content-type': 'text/javascript; charset=utf-8' });
    }
    return c.body(stampScript(repo), 200, { ...CORS, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600, s-maxage=86400' });
  });
}
