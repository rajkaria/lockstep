import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import * as Q from '../graph/queries.js';
import { parsePrUrl } from '../pr/github.js';
import { ingestPullRequest } from '../pr/ingest.js';
import type { ImpactData } from '../tools/graph-tools.js';
import { AGENT_TOOLS, modelTools, toolByName } from '../tools/index.js';
import { sinceLastCheck, type SinceLastCheck } from '../tools/memory-tools.js';
import type { ToolContext, ToolResult } from '../tools/types.js';
import type { ModelClient, ModelMessageParam, ModelToolResult, ModelToolUse } from './model.js';
import { SYSTEM_PROMPT, userPrompt } from './prompt.js';
import { storedTrace, type CheckStatus, type TraceEvent } from './trace.js';

export interface CheckOptions {
  /** Model turns before the loop stops (reported as incomplete, never hidden). */
  maxSteps?: number;
  /** Reminders sent when the model finishes with sections still lacking a verdict. */
  maxNudges?: number;
  onEvent?: (e: TraceEvent) => void;
}

export interface CheckResult {
  checkId: string;
  pr: string;
  status: CheckStatus;
  summary: string;
  events: TraceEvent[];
  impacted: string[];
  missing: string[];
  toolOrder: string[];
  since?: SinceLastCheck;
}

/** Characters of tool output handed back to the model per call. */
const MAX_TOOL_CONTENT = 24_000;

/** Tools whose `pr_url` defaults to the pull request under check. */
const PR_SCOPED = new Set(['impact', 'clearance', 'run_example', 'propose_edit', 'record_verdict']);

export function checkId(pr: string, at: number): string {
  return `chk-${createHash('sha1').update(`${pr}|${at}`).digest('hex').slice(0, 12)}`;
}

function describeSince(s: SinceLastCheck): string | undefined {
  const parts: string[] = [];
  if (s.prs.length) parts.push(`${s.prs.length} pull request(s) checked (${s.prs.map((p) => p.url.replace('https://github.com/', '')).join(', ')})`);
  if (s.verdicts) parts.push(`${s.verdicts} verdict(s), ${s.stale} of them stale`);
  if (s.decisions.length) parts.push(`${s.decisions.length} new decision(s): ${s.decisions.map((d) => `"${d.text}" (${d.id})`).join('; ')}`);
  if (s.runs) parts.push(`${s.runs} example run(s), ${s.failedRuns} failed`);
  return parts.length ? parts.join('; ') : undefined;
}

/**
 * Run the agent on one pull request. The model chooses every tool call; the loop
 * validates inputs, executes tools, streams trace events, enforces the stop
 * condition (every impacted section gets a verdict or an edit) and stores the
 * trace on a Check node.
 */
export async function runAgentCheck(ctx: ToolContext, model: ModelClient, prUrl: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const pr = parsePrUrl(prUrl).url;
  const maxSteps = opts.maxSteps ?? 40;
  const maxNudges = opts.maxNudges ?? 2;
  const events: TraceEvent[] = [];
  const emit = (e: TraceEvent) => {
    events.push(e);
    opts.onEvent?.(e);
  };

  const known = await ctx.graph.run<{ ingested: number | null }>(`MATCH (p:PullRequest {url: $url}) RETURN p.ingested_at AS ingested`, { url: pr });
  if (!known.rows[0]?.ingested) await ingestPullRequest(ctx.graph, ctx.config, pr);

  const prev = (await ctx.graph.run<{ startedAt: number }>(Q.lastCheck)).rows[0];
  const since = prev ? await sinceLastCheck(ctx, prev.startedAt) : undefined;
  const sinceText = since ? describeSince(since) : undefined;

  const started = Date.now();
  const id = checkId(pr, started);
  await ctx.graph.run(Q.createCheck, { id, pr, props: { pr, model: model.name, status: 'running', started_at: started } });
  emit({ type: 'check_started', checkId: id, pr, model: model.name, at: started, since: sinceText });

  const tctx: ToolContext = { ...ctx, checkId: id, prUrl: pr };
  const tools = modelTools(AGENT_TOOLS);
  const messages: ModelMessageParam[] = [{ role: 'user', content: userPrompt(pr, sinceText) }];
  const impacted = new Set<string>();
  const toolOrder: string[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let status: CheckStatus = 'incomplete';
  let summary = '';
  let nudges = 0;
  let jsonRetries = 0;
  let step = 0;
  let missing: string[] = [];

  try {
    for (step = 1; step <= maxSteps; step++) {
      let message;
      try {
        message = await model.turn(
          { system: SYSTEM_PROMPT, tools, messages },
          {
            onText: (text) => opts.onEvent?.({ type: 'delta', kind: 'text', text, step }),
            onThinking: (text) => opts.onEvent?.({ type: 'delta', kind: 'thinking', text, step }),
          },
        );
        jsonRetries = 0;
      } catch (err) {
        // With eager input streaming an unparseable tool input rejects the stream; re-issue the turn.
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        continue;
      }
      usage.input += message.usage?.input_tokens ?? 0;
      usage.output += message.usage?.output_tokens ?? 0;
      usage.cacheRead += message.usage?.cache_read_input_tokens ?? 0;

      for (const block of message.content) {
        if (block.type === 'thinking' && block.thinking) emit({ type: 'thinking', text: block.thinking, step });
        if (block.type === 'text' && block.text) emit({ type: 'text', text: block.text, step });
      }
      if (message.stop_reason === 'refusal') {
        status = 'refused';
        summary = `The model declined to continue (${message.stop_details?.category ?? 'no category'}).`;
        break;
      }
      // Append-only history: the assistant turn goes back exactly as it came.
      messages.push({ role: 'assistant', content: message.content as ModelMessageParam['content'] });
      if (message.stop_reason === 'pause_turn') continue;

      const uses = message.content.filter((b): b is ModelToolUse => b.type === 'tool_use');
      if (uses.length && message.stop_reason === 'max_tokens') {
        throw new Error('a tool call was cut off at max_tokens; raise max_tokens and re-run the check');
      }
      if (uses.length === 0) {
        const done = new Set(
          (await ctx.graph.run<{ id: string }>(Q.sectionsWithVerdict, { id })).rows.map((r) => r.id),
        );
        missing = [...impacted].filter((s) => !done.has(s));
        const finalText = message.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n')
          .trim();
        if (finalText) summary = finalText;
        if (missing.length && nudges < maxNudges) {
          nudges++;
          emit({ type: 'nudge', missing, step });
          messages.push({
            role: 'user',
            content: `These impacted sections still have no verdict or edit: ${missing.join(', ')}. Give each one a verdict (record_verdict) or an edit (propose_edit), then finish.`,
          });
          continue;
        }
        status = missing.length ? 'incomplete' : 'done';
        break;
      }

      const results: ModelToolResult[] = [];
      for (const use of uses) {
        toolOrder.push(use.name);
        emit({ type: 'tool_call', id: use.id, name: use.name, input: use.input, step });
        const t0 = Date.now();
        const out = await executeTool(tctx, use);
        if (out.ok && use.name === 'impact') {
          for (const s of (out.result.data as ImpactData).sections) if (s.section.includes('#')) impacted.add(s.section);
        }
        emit({
          type: 'tool_result',
          id: use.id,
          name: use.name,
          summary: out.ok ? out.result.summary : out.error,
          isError: !out.ok,
          queries: out.ok ? out.result.queries : [],
          data: out.ok ? out.result.data : undefined,
          ms: Date.now() - t0,
          step,
        });
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: !out.ok,
          content: out.ok ? clip(JSON.stringify({ summary: out.result.summary, data: out.result.data })) : out.error,
        });
      }
      messages.push({ role: 'user', content: results });
    }
    if (step > maxSteps) {
      const done = new Set((await ctx.graph.run<{ id: string }>(Q.sectionsWithVerdict, { id })).rows.map((r) => r.id));
      missing = [...impacted].filter((s) => !done.has(s));
      status = 'incomplete';
      summary ||= `Stopped after ${maxSteps} model turns with ${missing.length} impacted section(s) still open.`;
    }
  } catch (err) {
    status = 'error';
    summary = `The check failed: ${(err as Error).message}`;
  }

  const finished = Date.now();
  const verdicts =
    (
      await ctx.graph.run<{ verdicts: number }>(Q.finishCheck, {
        id,
        props: {
          status,
          summary,
          finished_at: finished,
          steps: Math.min(step, maxSteps),
          tool_calls: toolOrder.length,
          tool_order: toolOrder,
          missing,
          input_tokens: usage.input,
          output_tokens: usage.output,
          trace: JSON.stringify(storedTrace(events)),
        },
      })
    ).rows[0]?.verdicts ?? 0;
  emit({
    type: 'check_finished',
    checkId: id,
    status,
    summary,
    steps: Math.min(step, maxSteps),
    toolCalls: toolOrder.length,
    toolOrder,
    verdicts,
    missing,
    usage,
    at: finished,
  });
  // The final event must reach the stored trace too.
  await ctx.graph.run(`MATCH (c:Check {id: $id}) SET c.trace = $trace, c.verdicts = $verdicts`, {
    id,
    trace: JSON.stringify(storedTrace(events)),
    verdicts,
  });
  return { checkId: id, pr, status, summary, events, impacted: [...impacted], missing, toolOrder, since };
}

type ExecOutcome = { ok: true; result: ToolResult } | { ok: false; error: string };

async function executeTool(ctx: ToolContext, use: ModelToolUse): Promise<ExecOutcome> {
  const tool = toolByName(use.name, AGENT_TOOLS);
  if (!tool) return { ok: false, error: `unknown tool ${use.name}` };
  const raw = { ...(use.input as Record<string, unknown>) };
  if (PR_SCOPED.has(tool.name) && raw.pr_url === undefined && ctx.prUrl) raw.pr_url = ctx.prUrl;
  // Unknown parameters would be dropped silently and the model would get the same answer again; say so instead.
  const known = 'shape' in tool.input ? Object.keys((tool.input as unknown as { shape: object }).shape) : undefined;
  const unknown = known ? Object.keys(raw).filter((k) => !known.includes(k)) : [];
  if (unknown.length) {
    return { ok: false, error: `${tool.name} has no parameter ${unknown.join(', ')}; its parameters are ${known!.join(', ')}` };
  }
  // The SDK's tolerant parser can hand back a truncated input; validate before running.
  const parsed = tool.input.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `invalid input for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
  }
  try {
    return { ok: true, result: await tool.run(ctx, parsed.data) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function clip(s: string): string {
  return s.length > MAX_TOOL_CONTENT ? `${s.slice(0, MAX_TOOL_CONTENT)}… [truncated; ask for fewer items]` : s;
}
