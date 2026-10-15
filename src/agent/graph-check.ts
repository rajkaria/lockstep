import * as Q from '../graph/queries.js';
import { parsePrUrl } from '../pr/github.js';
import { ingestPullRequest } from '../pr/ingest.js';
import { clearanceTool, impactTool, rankSectionsTool, type ImpactData } from '../tools/graph-tools.js';
import { runExampleTool } from '../tools/run-example.js';
import type { ToolContext, ToolDef, ToolResult } from '../tools/types.js';
import { checkId, type CheckResult } from './loop.js';
import { storedTrace, type CheckStatus, type TraceEvent } from './trace.js';

export const GRAPH_MODE_MODEL = 'graph-only (no model)';

/**
 * The same tools in a fixed order, with no model: impact, clearance, PageRank,
 * then up to `maxRuns` differential example runs. What runs when the server has
 * no Claude credentials — labelled as such everywhere it is shown.
 */
export async function runGraphCheck(
  ctx: ToolContext,
  prUrl: string,
  opts: { maxRuns?: number; onEvent?: (e: TraceEvent) => void } = {},
): Promise<CheckResult> {
  const pr = parsePrUrl(prUrl).url;
  const events: TraceEvent[] = [];
  const emit = (e: TraceEvent) => {
    events.push(e);
    opts.onEvent?.(e);
  };
  const known = await ctx.graph.run<{ ingested: number | null }>(`MATCH (p:PullRequest {url: $url}) RETURN p.ingested_at AS ingested`, { url: pr });
  if (!known.rows[0]?.ingested) await ingestPullRequest(ctx.graph, ctx.config, pr);
  const started = Date.now();
  const id = checkId(pr, started);
  await ctx.graph.run(Q.createCheck, { id, pr, props: { pr, model: GRAPH_MODE_MODEL, status: 'running', started_at: started } });
  emit({ type: 'check_started', checkId: id, pr, model: GRAPH_MODE_MODEL, at: started });
  const tctx: ToolContext = { ...ctx, checkId: id, prUrl: pr };
  const toolOrder: string[] = [];
  let step = 0;
  let status: CheckStatus = 'done';
  let summary = '';

  const call = async <I, O>(tool: ToolDef<I, O>, input: I): Promise<ToolResult<O> | undefined> => {
    step++;
    const callId = `graph_${step}`;
    toolOrder.push(tool.name);
    emit({ type: 'tool_call', id: callId, name: tool.name, input, step });
    const t0 = Date.now();
    try {
      const r = await tool.run(tctx, input);
      emit({ type: 'tool_result', id: callId, name: tool.name, summary: r.summary, isError: false, queries: r.queries, data: r.data, ms: Date.now() - t0, step });
      return r;
    } catch (err) {
      emit({ type: 'tool_result', id: callId, name: tool.name, summary: (err as Error).message, isError: true, queries: [], ms: Date.now() - t0, step });
      return undefined;
    }
  };

  try {
    const impact = await call(impactTool, { pr_url: pr });
    if (!impact) throw new Error('impact failed');
    const data: ImpactData = impact.data;
    const clearance = await call(clearanceTool, { pr_url: pr });
    const sectionIds = [...new Set(data.sections.map((s) => s.section).filter((s) => s.includes('#')))];
    if (sectionIds.length) await call(rankSectionsTool, { section_ids: sectionIds });
    const examples = [...new Set(data.sections.filter((s) => s.confidence === 'exact').flatMap((s) => s.examples))].slice(0, opts.maxRuns ?? 3);
    const verdicts: string[] = [];
    for (const ex of examples) {
      const r = await call(runExampleTool, { example_id: ex, pr_url: pr });
      if (r) verdicts.push(`${ex}: ${r.data.verdict}`);
    }
    summary =
      `${impact.summary} ${clearance?.summary ?? ''}`.trim() +
      (examples.length ? ` Ran ${examples.length} example(s) before and after the PR: ${verdicts.join('; ')}.` : ' No exactly-linked Python example to run.') +
      ' Graph mode: fixed tool order and no verdicts — agent mode (Claude) judges each section and proposes the edits.';
  } catch (err) {
    status = 'error';
    summary = `The check failed: ${(err as Error).message}`;
  }

  const finished = Date.now();
  emit({
    type: 'check_finished',
    checkId: id,
    status,
    summary,
    steps: step,
    toolCalls: toolOrder.length,
    toolOrder,
    verdicts: 0,
    missing: [],
    usage: { input: 0, output: 0, cacheRead: 0 },
    at: finished,
  });
  await ctx.graph.run(Q.finishCheck, {
    id,
    props: {
      status,
      summary,
      finished_at: finished,
      steps: step,
      tool_calls: toolOrder.length,
      tool_order: toolOrder,
      missing: [],
      input_tokens: 0,
      output_tokens: 0,
      verdicts: 0,
      trace: JSON.stringify(storedTrace(events)),
    },
  });
  return { checkId: id, pr, status, summary, events, impacted: [], missing: [], toolOrder };
}
