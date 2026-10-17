import { prNewFindings, runGraphCheck, type PrFindings, type PrLintOptions } from '../agent/graph-check.js';
import type { Config } from '../config.js';
import { checkMarkdown } from '../format/markdown.js';
import { loadRuns } from '../format/report.js';
import type { OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import type { Workspaces } from '../hosted/workspaces.js';
import { addFixes } from '../lint/fixes.js';
import { commitTree } from '../lint/sources.js';
import { loadVerdicts } from '../patch.js';
import { diffWith } from '../pr/changes.js';
import { githubSource, prRangeGitHub } from '../pr/github-diff.js';
import type { PullRequestInfo } from '../pr/github.js';
import { canonicalPrUrl, recordPullRequest } from '../pr/ingest.js';
import { clearanceTool, impactTool, rankSectionsTool } from '../tools/graph-tools.js';
import type { ToolContext } from '../tools/types.js';
import type { CheckOutcome } from './checks.js';
import type { PrivateWorkspaces } from './private-workspaces.js';

/**
 * The check behind the App's check run: the hosted graph check (no example runs) of the
 * pull request in its workspace graph, plus the docs references it makes wrong (F2) with
 * their verified fixes (F3). Public repositories use the hosted workspaces (`gh-<owner>`,
 * downloaded without a token, as anyone could); private ones the installation's
 * `ghp-<id>` graph, read with the installation token.
 */

export interface PrCheckRequest {
  installationId: number;
  /** The installation token (private archives, the compare API). Never logged. */
  token: string;
  repo: { fullName: string; private: boolean; defaultBranch: string };
  pr: PullRequestInfo;
  alsoIndex: string[];
  /** Re-index first (a push to the default branch left the index behind). */
  refresh: boolean;
  /** Attach verified fixes to the new findings (suggestions, Apply fixes). */
  fixes: boolean;
}

export interface PrCheckResult extends CheckOutcome {
  /** The graph that answered (`gh-<owner>`, `ghp-<installation>`, or the curated one). */
  graph: string;
  checkId?: string;
}

export type PrChecker = (req: PrCheckRequest) => Promise<PrCheckResult>;

export interface GraphCheckerDeps {
  config: Config;
  workspaces: Workspaces;
  privateWorkspaces: PrivateWorkspaces;
  fetchImpl?: typeof fetch;
  /** Give up linting both commits after this long (default 120 s). */
  lintTimeoutMs?: number;
}

/** Index (if needed) and return the graph that answers for the pull request's repository. */
async function targetGraph(deps: GraphCheckerDeps, req: PrCheckRequest): Promise<{ graph: OrgGraph; curated: boolean }> {
  const repo = req.repo.fullName;
  if (req.repo.private) {
    // A repository that was public once may still sit in a hosted workspace: drop that copy.
    const hostedCopy = await deps.workspaces.locate(repo).catch(() => undefined);
    if (hostedCopy && !hostedCopy.curated) await deps.workspaces.evict(hostedCopy.graph.name);
    const r = await deps.privateWorkspaces.ensure(req.installationId, repo, req.token, { with: req.alsoIndex, refresh: req.refresh });
    return { graph: r.graph, curated: false };
  }
  const found = await deps.workspaces.locate(repo);
  // The curated graph is never re-indexed from here, and takes no extra repositories.
  if (found?.curated) return { graph: found.graph, curated: true };
  const r = await deps.workspaces.ensure(repo, { with: req.alsoIndex, refresh: req.refresh });
  return { graph: r.graph, curated: r.curated };
}

/** Record the pull request's symbol diff (through the API, with the installation token) unless the graph has this head already. */
async function ingest(graph: OrgGraph, pr: PullRequestInfo, opts: { token: string; fetchImpl?: typeof fetch }): Promise<void> {
  const row = (await graph.run<{ head: string | null; ingested: number | null }>(`MATCH (p:PullRequest {url: $url}) RETURN p.head_sha AS head, p.ingested_at AS ingested`, { url: pr.url })).rows[0];
  if (row?.ingested && row.head === pr.headSha) return;
  if (row) await graph.run(Q.resetPullRequest, { url: pr.url });
  const range = await prRangeGitHub(pr, opts);
  const diff = await diffWith(githubSource(pr.fullName, opts), pr.fullName, range.before, range.after);
  await recordPullRequest(graph, pr, diff);
}

/** The new findings with their verified fixes (rename detection reads the base commit). */
export async function withFixes(pf: PrFindings, opts: { home: string; token?: string; fetchImpl?: typeof fetch; limits?: PrLintOptions['limits'] }): Promise<PrFindings> {
  if (!pf.total) return pf;
  const trees = await Promise.all([commitTree(pf.repo, pf.base, opts), commitTree(pf.repo, pf.head, opts)]);
  try {
    const r = await addFixes({ version: 1, repo: pf.repo, sha: pf.head, findings: pf.findings, summary: pf.summary, warnings: [] }, trees[1], { baseTree: trees[0] });
    return { ...pf, findings: r.findings };
  } finally {
    await Promise.all(trees.map((t) => t.dispose()));
  }
}

export function graphChecker(deps: GraphCheckerDeps): PrChecker {
  return async (req) => {
    const target = await targetGraph(deps, req);
    const graph = target.graph;
    const gh = { token: req.token, fetchImpl: deps.fetchImpl };
    // Hosted workspaces name repositories in lower case: key the pull request the way the graph does.
    const url = await canonicalPrUrl(graph, req.pr.url);
    const fullName = url.replace(/^https:\/\/github\.com\//, '').replace(/\/pull\/\d+$/, '');
    const pr: PullRequestInfo = { ...req.pr, url, fullName, owner: fullName.split('/')[0]!, repo: fullName.split('/')[1]! };
    await ingest(graph, pr, gh);

    // Any call the graph tools make to GitHub reads with the installation token.
    const ctx: ToolContext = { graph, config: { ...deps.config, githubToken: req.token } };
    const lint: PrLintOptions = { token: req.token, fetchImpl: deps.fetchImpl, limits: deps.workspaces.limits.tarball, timeoutMs: deps.lintTimeoutMs ?? 120_000 };
    const check = await runGraphCheck(ctx, url, { maxRuns: 0, lint });

    let newFindings: PrFindings | undefined;
    let newFindingsError: string | undefined;
    try {
      newFindings = await prNewFindings(ctx, url, lint);
    } catch (err) {
      newFindingsError = (err as Error).message;
    }
    if (newFindings && req.fixes) {
      try {
        newFindings = await withFixes(newFindings, { home: deps.config.home, token: req.token, fetchImpl: deps.fetchImpl, limits: lint.limits });
      } catch {
        // Fixes are a convenience: the findings stand without them.
      }
    }

    const impact = await impactTool.run(ctx, { pr_url: url });
    const clearance = await clearanceTool.run(ctx, { pr_url: url });
    const ids = [...new Set(impact.data.sections.map((s) => s.section).filter((id) => id.includes('#')))];
    const ranked = ids.length ? (await rankSectionsTool.run(ctx, { section_ids: ids })).data.ranked : undefined;
    const verdicts = await loadVerdicts(ctx, url);
    const runs = await loadRuns(ctx, url);
    const report = checkMarkdown({
      impact: impact.data,
      summary: impact.summary,
      cleared: clearance.data.cleared,
      ranked,
      verdicts,
      runs,
      org: graph.name,
      ...(newFindings ? { newFindings } : {}),
      ...(newFindingsError ? { newFindingsError } : {}),
    });
    return {
      report,
      ...(newFindings ? { newFindings } : {}),
      ...(newFindingsError ? { newFindingsError } : {}),
      predicted: new Set((impact.data.predicted ?? []).map((p) => p.example)).size,
      sections: impact.data.totalSections,
      stale: verdicts.filter((v) => v.verdict === 'stale').length,
      graph: graph.name,
      checkId: check.checkId,
    };
  };
}
