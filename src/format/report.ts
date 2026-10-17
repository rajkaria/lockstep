import { prNewFindings, type PrFindings, type PrLintOptions } from '../agent/graph-check.js';
import { loadVerdicts } from '../patch.js';
import type { RunRecord } from '../runner/index.js';
import { clearanceTool, impactTool, rankSectionsTool } from '../tools/graph-tools.js';
import { verdictOf, type RunVerdict } from '../tools/run-example.js';
import type { ToolContext } from '../tools/types.js';
import { checkMarkdown } from './markdown.js';

/** One example's latest runs at the commits before and after a pull request. */
export interface ExampleRunRow {
  example: string;
  url: string;
  verdict: RunVerdict;
  before?: { status: string; error: string; reason: string };
  after?: { status: string; error: string; reason: string };
}

/** The latest run on each side of `prUrl` for every example run against it. */
export async function loadRuns(ctx: ToolContext, prUrl: string): Promise<ExampleRunRow[]> {
  const rows = (
    await ctx.graph.run<{ example: string; url: string; side: 'before' | 'after'; status: string; error: string; reason: string; at: number }>(
      `MATCH (r:Run)-[:AT]->(:PullRequest {url: $url})
       MATCH (r)-[:OF]->(e:CodeExample)
       RETURN e.id AS example, e.url AS url, r.side AS side, r.status AS status, r.error AS error, r.reason AS reason, r.created_at AS at
       ORDER BY at ASC`,
      { url: prUrl },
    )
  ).rows;
  const byExample = new Map<string, ExampleRunRow>();
  for (const r of rows) {
    const row = byExample.get(r.example) ?? { example: r.example, url: r.url, verdict: 'passes' as RunVerdict };
    // Ascending order: the latest attempt on each side wins.
    row[r.side] = { status: r.status, error: r.error ?? '', reason: r.reason ?? '' };
    byExample.set(r.example, row);
  }
  for (const row of byExample.values()) {
    const records = (['before', 'after'] as const)
      .filter((side) => row[side])
      .map((side) => ({ side, status: row[side]!.status, error: row[side]!.error }) as unknown as RunRecord);
    row.verdict = verdictOf(records);
  }
  return [...byExample.values()];
}

/**
 * The Markdown report of a checked pull request: impacted sections with evidence paths,
 * clearance, example runs before and after, and (agent mode) verdicts. This is the PR
 * comment the GitHub Action posts and what the MCP `check_pull_request` tool returns.
 */
export async function checkReport(ctx: ToolContext, org: string, prUrl: string, agentSummary?: string, opts: { lint?: PrLintOptions | false } = {}): Promise<string> {
  const impact = await impactTool.run(ctx, { pr_url: prUrl });
  // Docs this pull request makes wrong: shared with the check that just ran (one lint per commit pair).
  let newFindings: PrFindings | undefined;
  let newFindingsError: string | undefined;
  if (opts.lint !== false) {
    try {
      newFindings = await prNewFindings(ctx, impact.data.pr.url, opts.lint ?? {});
    } catch (err) {
      newFindingsError = (err as Error).message;
    }
  }
  const clearance = await clearanceTool.run(ctx, { pr_url: prUrl });
  const ids = [...new Set(impact.data.sections.map((s) => s.section).filter((id) => id.includes('#')))];
  const ranked = ids.length ? (await rankSectionsTool.run(ctx, { section_ids: ids })).data.ranked : undefined;
  const verdicts = await loadVerdicts(ctx, impact.data.pr.url);
  const runs = await loadRuns(ctx, impact.data.pr.url);
  return checkMarkdown({ impact: impact.data, summary: impact.summary, cleared: clearance.data.cleared, ranked, verdicts, runs, agentSummary, org, newFindings, newFindingsError });
}
