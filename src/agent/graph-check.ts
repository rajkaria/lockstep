import { join } from 'node:path';
import { z } from 'zod';
import type { OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import type { TarballLimits } from '../indexer/tarball.js';
import { lintCommits } from '../lint/diff.js';
import { SURFACE_TITLE } from '../lint/format.js';
import type { Finding, LintSummary } from '../lint/types.js';
import { parsePrUrl } from '../pr/github.js';
import { ingestPullRequest } from '../pr/ingest.js';
import { clearanceTool, impactTool, rankSectionsTool, type ImpactData } from '../tools/graph-tools.js';
import { runExampleTool } from '../tools/run-example.js';
import { result, Tracer, type ToolContext, type ToolDef, type ToolResult } from '../tools/types.js';
import { checkId, type CheckResult } from './loop.js';
import { storedTrace, type CheckStatus, type TraceEvent } from './trace.js';

export const GRAPH_MODE_MODEL = 'graph-only (no model)';

/**
 * "Docs this pull request makes wrong": lint findings (stale paths, links, anchors,
 * commands, CLI flags, env vars in the docs and AI agent files) the pull request's head
 * commit has and its base did not. Graph-free; listed above the graph's impact.
 */
export interface PrFindings {
  repo: string;
  /** The commits compared (the pull request's before and after). */
  base: string;
  head: string;
  /** New findings, AI agent instruction files first (capped in stored traces; `total` counts all). */
  findings: Finding[];
  total: number;
  /** Findings at the base that the pull request removes. */
  fixed: number;
  /** Of the new findings. */
  summary: LintSummary;
  /** Docs and agent files checked at the head. */
  files: number;
  ms: number;
}

export interface PrLintOptions {
  /** Token for private repositories that have no local clone (default `config.githubToken`); `null` never sends one (the hosted service). */
  token?: string | null;
  fetchImpl?: typeof fetch;
  limits?: TarballLimits;
  /** Give up after this long (default 120 s): the graph check goes on without it. */
  timeoutMs?: number;
}

const COMMIT = /^[0-9a-f]{40}$/;
const prMemo = new Map<string, { at: number; failed?: boolean; result: Promise<PrFindings> }>();
/** A failed run (network, timeout) is not retried for this long: the comment and the check share the answer. */
const RETRY_FAILED_MS = 5 * 60_000;

/** The commits a pull request was compared between, when the graph recorded real ones. */
export async function prCommitsOf(graph: OrgGraph | Tracer, prUrl: string): Promise<{ repo: string; before: string; after: string } | undefined> {
  const row = (await graph.run<{ repo: string; before: string | null; after: string | null }>(Q.prCommits, { url: prUrl })).rows[0];
  if (!row || !COMMIT.test(row.before ?? '') || !COMMIT.test(row.after ?? '')) return undefined;
  return { repo: row.repo, before: row.before!, after: row.after! };
}

/**
 * New lint findings of a pull request: its docs linted at both commits (a local clone when
 * there is one, else the GitHub tarballs), compared by fingerprint. Remembered per commit
 * pair, so the check, its comment and its annotations share one run. Undefined when the
 * graph has no real commits for it.
 */
export async function prNewFindings(ctx: ToolContext, prUrl: string, opts: PrLintOptions = {}, tracer?: Tracer): Promise<PrFindings | undefined> {
  const commits = await prCommitsOf(tracer ?? ctx.graph, prUrl);
  if (!commits) return undefined;
  const key = `${prUrl}|${commits.before}|${commits.after}`;
  const cached = prMemo.get(key);
  if (cached && !(cached.failed && Date.now() - cached.at > RETRY_FAILED_MS)) return cached.result;
  {
    const hit = (async () => {
      const started = Date.now();
      const ms = opts.timeoutMs ?? 120_000;
      const ctl = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new Error(`linting both commits took longer than ${Math.round(ms / 1000)} s`));
        }, ms);
      });
      try {
        const d = await Promise.race([
          lintCommits(commits.repo, commits.before, commits.after, {
            home: ctx.config.home,
            clone: ctx.checkouts?.[commits.repo] ?? join(ctx.config.home, 'repos', ...commits.repo.split('/')),
            token: opts.token === null ? undefined : (opts.token ?? ctx.config.githubToken),
            fetchImpl: opts.fetchImpl,
            limits: opts.limits,
            signal: ctl.signal,
            // Examples are the graph's part (predicted breaks); lint adds every other reference.
            lint: { examples: false },
          }),
          timeout,
        ]);
        return { repo: commits.repo, base: commits.before, head: commits.after, findings: d.findings, total: d.findings.length, fixed: d.fixed, summary: d.summary, files: d.summary.files, ms: Date.now() - started };
      } finally {
        clearTimeout(timer);
      }
    })();
    const entry: { at: number; failed?: boolean; result: Promise<PrFindings> } = { at: Date.now(), result: hit };
    prMemo.delete(key);
    prMemo.set(key, entry);
    hit.catch(() => {
      entry.failed = true;
      entry.at = Date.now();
    });
    while (prMemo.size > 64) prMemo.delete(prMemo.keys().next().value!);
    return hit;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One or two sentences: how many references the pull request makes wrong, where, and the first few. */
export function prFindingsSummary(pf: PrFindings, subject = 'This pull request'): string {
  if (!pf.total) {
    return `No docs reference that was true at ${pf.base.slice(0, 7)} is wrong at ${pf.head.slice(0, 7)} (${plural(pf.files, 'file')} checked${pf.fixed ? `; ${pf.fixed} fixed` : ''}).`;
  }
  const s = pf.summary;
  const levels = [s.errors && plural(s.errors, 'error'), s.warnings && plural(s.warnings, 'warning'), s.infos && `${s.infos} info`].filter(Boolean).join(', ');
  const agent = s.bySurface.agent ? `, ${s.bySurface.agent} in ${SURFACE_TITLE.agent}` : '';
  const first = pf.findings.slice(0, 3).map((f) => `${f.path}:${f.line} \`${f.subject}\``);
  return (
    `${subject} make${/^these\b/i.test(subject) ? '' : 's'} ${plural(pf.total, 'docs reference')} wrong (${levels}${agent}): ${first.join(', ')}${pf.total > first.length ? `, and ${pf.total - first.length} more` : ''}.` +
    (pf.fixed ? ` It fixes ${pf.fixed}.` : '')
  );
}

/** At most this many findings ride along in a check's trace (the comment lists them all). */
const TRACE_FINDINGS = 50;

/** The pipeline step for `new_findings`: a tool so the trace shows it like the graph steps. */
export function newFindingsTool(opts: PrLintOptions = {}): ToolDef<{ pr_url: string }, PrFindings> {
  return {
    name: 'new_findings',
    description:
      'Docs this pull request makes wrong: the docs and AI agent files linted at its base and head commits (paths, links, anchors, commands, CLI flags, env vars), ' +
      'keeping what only the head has. No traversal: each finding names its line and where Staleproof looked.',
    input: z.object({ pr_url: z.string() }),
    queries: [Q.prCommits],
    async run(ctx, input) {
      const tracer = new Tracer(ctx.graph);
      const pf = await prNewFindings(ctx, parsePrUrl(input.pr_url).url, opts, tracer);
      if (!pf) throw new Error('the graph has no commits recorded for this pull request');
      return result('new_findings', tracer, prFindingsSummary(pf), { ...pf, findings: pf.findings.slice(0, TRACE_FINDINGS) });
    },
  };
}

/**
 * The same tools in a fixed order, with no model: impact, clearance, PageRank,
 * then up to `maxRuns` differential example runs. What runs when the server has
 * no Claude credentials — labelled as such everywhere it is shown.
 */
export async function runGraphCheck(
  ctx: ToolContext,
  prUrl: string,
  opts: { maxRuns?: number; maxHops?: number; onEvent?: (e: TraceEvent) => void; /** `false` skips "Docs this pull request makes wrong". */ lint?: PrLintOptions | false } = {},
): Promise<CheckResult & { newFindings?: PrFindings }> {
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

  /** `shape` changes what the trace carries (not what the step returns). */
  const call = async <I, O>(tool: ToolDef<I, O>, input: I, shape?: (data: O) => unknown): Promise<ToolResult<O> | undefined> => {
    step++;
    const callId = `graph_${step}`;
    toolOrder.push(tool.name);
    emit({ type: 'tool_call', id: callId, name: tool.name, input, step });
    const t0 = Date.now();
    try {
      const r = await tool.run(tctx, input);
      emit({ type: 'tool_result', id: callId, name: tool.name, summary: r.summary, isError: false, queries: r.queries, data: shape ? shape(r.data) : r.data, ms: Date.now() - t0, step });
      return r;
    } catch (err) {
      emit({ type: 'tool_result', id: callId, name: tool.name, summary: (err as Error).message, isError: true, queries: [], ms: Date.now() - t0, step });
      return undefined;
    }
  };

  let newFindings: PrFindings | undefined;
  try {
    // Docs this pull request makes wrong (lint at both commits), first: the comment lists it above the impact.
    if (opts.lint !== false && (await prCommitsOf(ctx.graph, pr))) newFindings = (await call(newFindingsTool(opts.lint ?? {}), { pr_url: pr }))?.data;
    // The web view reads the new findings from the impact step (it keeps that step's data).
    const withFindings = (d: ImpactData) => (newFindings ? { ...d, newFindings: { ...newFindings, findings: newFindings.findings.slice(0, TRACE_FINDINGS) } } : d);
    const impact = await call(impactTool, { pr_url: pr, ...(opts.maxHops !== undefined && opts.maxHops !== 3 ? { max_hops: opts.maxHops } : {}) }, withFindings);
    if (!impact) throw new Error('impact failed');
    const data: ImpactData = impact.data;
    const clearance = await call(clearanceTool, { pr_url: pr });
    const sectionIds = [...new Set(data.sections.map((s) => s.section).filter((s) => s.includes('#')))];
    if (sectionIds.length) await call(rankSectionsTool, { section_ids: sectionIds });
    // Examples predicted to break run first: a run turns the prediction into proof.
    const candidates = [
      ...new Set([
        ...data.predicted.filter((p) => p.confidence === 'exact').map((p) => p.example),
        ...data.sections.filter((s) => s.confidence === 'exact').flatMap((s) => s.examples),
      ]),
    ];
    // Examples the docs mark skip or expect-error never run: don't spend a run slot on them.
    const marked = new Set(
      candidates.length
        ? (await ctx.graph.run<{ id: string }>(`MATCH (e:CodeExample) WHERE e.id IN $ids AND coalesce(e.directive, '') <> '' RETURN e.id AS id`, { ids: candidates })).rows.map((r) => r.id)
        : [],
    );
    const examples = candidates.filter((e) => !marked.has(e)).slice(0, opts.maxRuns ?? 3);
    const verdicts: string[] = [];
    for (const ex of examples) {
      const r = await call(runExampleTool, { example_id: ex, pr_url: pr });
      if (r) verdicts.push(`${ex}: ${r.data.verdict}`);
    }
    summary =
      (newFindings?.total ? `${prFindingsSummary(newFindings)} ` : '') +
      `${impact.summary} ${clearance?.summary ?? ''}`.trim() +
      (examples.length
        ? ` Ran ${examples.length} example(s) before and after the PR: ${verdicts.join('; ')}.`
        : opts.maxRuns === 0
          ? ' Example runs not requested.'
          : ' No exactly-linked Python example to run.') +
      ' Graph mode: fixed tool order and no verdicts; agent mode (a model) judges each section and proposes the edits.';
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
  return { checkId: id, pr, status, summary, events, impacted: [], missing: [], toolOrder, ...(newFindings ? { newFindings } : {}) };
}
