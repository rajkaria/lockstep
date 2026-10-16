import { createHash } from 'node:crypto';
import { z } from 'zod';
import * as Q from '../graph/queries.js';
import { parsePrUrl } from '../pr/github.js';
import { result, Tracer, type ToolContext, type ToolDef } from './types.js';

export interface DecisionHit {
  id: string;
  text: string;
  source: string;
  author: string;
  createdAt: number;
  /** The decision the graph matched (differs from `id` when it was superseded). */
  matched: string;
  /** The section or symbol through which it governs the target. */
  via: string;
}

export interface PriorVerdict {
  id: string;
  verdict: string;
  status: string;
  reason: string;
  pr: string;
  title: string;
  createdAt: number;
}

export const decisionsForTool: ToolDef<{ target_id: string }, { decisions: DecisionHit[]; history: PriorVerdict[] }> = {
  name: 'decisions_for',
  description:
    'Before judging a doc section, read the maintainers\' decisions that govern it (directly, or through any symbol it mentions or its examples use, within 2 call hops; superseded decisions resolve to the current one) ' +
    'and the verdicts Lockstep gave this section on earlier pull requests (with whether maintainers accepted them). ' +
    'A governing decision can mean the section is intentionally as it is: cite it instead of editing.',
  input: z.object({ target_id: z.string().describe('DocSection id (repo:path#anchor) or Symbol id (repo:qualname)') }),
  queries: [Q.decisionsForSection, Q.decisionsForSymbol, Q.priorVerdicts],
  async run(ctx, input) {
    const tracer = new Tracer(ctx.graph);
    const isSection = input.target_id.includes('#');
    const hits = (await tracer.run<DecisionHit>(isSection ? Q.decisionsForSection : Q.decisionsForSymbol, { id: input.target_id })).rows;
    // One entry per current decision; prefer the row where it matched directly over one reached through a superseded decision.
    const byId = new Map<string, DecisionHit>();
    for (const h of hits) {
      const prev = byId.get(h.id);
      if (!prev || (prev.matched !== prev.id && h.matched === h.id)) byId.set(h.id, h);
    }
    const decisions = [...byId.values()];
    const history = isSection ? (await tracer.run<PriorVerdict>(Q.priorVerdicts, { id: input.target_id })).rows : [];
    const parts: string[] = [];
    parts.push(
      decisions.length
        ? `${decisions.length} active decision${decisions.length > 1 ? 's' : ''} govern${decisions.length > 1 ? '' : 's'} this: ${decisions.map((d) => `"${truncate(d.text, 80)}" (${d.id}${d.matched !== d.id ? `, supersedes ${d.matched}` : ''}, via ${d.via})`).join('; ')}.`
        : 'No decision governs this.',
    );
    if (history.length) {
      parts.push(`Earlier: ${history.map((h) => `${h.verdict}${h.status !== 'proposed' ? ` (${h.status})` : ''} on ${h.pr.replace('https://github.com/', '')}`).join(', ')}.`);
    }
    return result('decisions_for', tracer, parts.join(' '), { decisions, history });
  },
};

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function decisionId(text: string, at: number): string {
  return `dec-${createHash('sha1').update(`${text}|${at}`).digest('hex').slice(0, 10)}`;
}

export const writeDecisionTool: ToolDef<
  { text: string; governs: string[]; source_url?: string; author?: string; supersedes?: string },
  { id: string; governed: number }
> = {
  name: 'write_decision',
  description:
    'Record a maintainer decision ("the async client keeps the old kwargs until 2.0") and the doc sections or symbols it governs. ' +
    'Future checks cite it instead of re-flagging. Decisions come from people: call this only when a human asked for it.',
  input: z.object({
    text: z.string().min(5),
    governs: z.array(z.string()).min(1).describe('DocSection and/or Symbol ids'),
    source_url: z.string().optional().describe('Where the decision was made (issue, PR comment, ADR)'),
    author: z.string().optional(),
    supersedes: z.string().optional().describe('Id of the decision this replaces'),
  }),
  queries: [Q.createDecision, Q.governSections, Q.governSymbols, Q.supersedeDecision],
  async run(ctx, input) {
    const tracer = new Tracer(ctx.graph);
    const at = Date.now();
    const id = decisionId(input.text, at);
    const known = await tracer.run<{ n: number }>(
      `MATCH (n) WHERE (n:DocSection OR n:Symbol) AND n.id IN $governs RETURN count(n) AS n`,
      { governs: input.governs },
    );
    if ((known.rows[0]?.n ?? 0) === 0) throw new Error(`none of ${input.governs.join(', ')} is a DocSection or Symbol id; decision not recorded`);
    await tracer.run(Q.createDecision, {
      id,
      props: { text: input.text, source_url: input.source_url ?? '', author: input.author ?? 'unknown', status: 'active', created_at: at },
    });
    const sections = (await tracer.run<{ n: number }>(Q.governSections, { id, governs: input.governs })).rows[0]?.n ?? 0;
    const symbols = (await tracer.run<{ n: number }>(Q.governSymbols, { id, governs: input.governs })).rows[0]?.n ?? 0;
    const governed = sections + symbols;
    if (input.supersedes) await tracer.run(Q.supersedeDecision, { newer: id, older: input.supersedes });
    return result('write_decision', tracer, `Recorded decision ${id} governing ${governed} node(s)${input.supersedes ? `, superseding ${input.supersedes}` : ''}.`, {
      id,
      governed,
    });
  },
};

interface VerdictInput {
  section_id: string;
  reason: string;
  cites?: string[];
  runs?: string[];
}

async function sectionPath(tracer: Tracer, pr: string, section: string): Promise<string[] | undefined> {
  return (await tracer.run<{ path: string[] }>(Q.sectionReachedByPr, { pr, section })).rows[0]?.path;
}

function verdictId(pr: string, section: string, at: number): string {
  return `ver-${createHash('sha1').update(`${pr}|${section}|${at}`).digest('hex').slice(0, 12)}`;
}

async function writeVerdict(
  ctx: ToolContext,
  tracer: Tracer,
  pr: string,
  input: VerdictInput,
  props: Record<string, unknown>,
): Promise<string> {
  const at = Date.now();
  const id = verdictId(pr, input.section_id, at);
  const r = await tracer.run<{ id: string }>(Q.createVerdict, {
    id,
    section: input.section_id,
    pr,
    cites: input.cites ?? [],
    runs: input.runs ?? [],
    props: { ...props, reason: input.reason, created_at: at, check: ctx.checkId ?? '' },
  });
  if (!r.rows[0]) throw new Error(`no doc section ${input.section_id} or pull request ${pr} in the graph`);
  return id;
}

export const recordVerdictTool: ToolDef<
  Omit<VerdictInput, 'section_id'> & { pr_url?: string; section_id?: string; section_ids?: string[]; verdict: 'ok' | 'governed' | 'skipped' },
  { ids: string[]; evidence: Record<string, string[]> }
> = {
  name: 'record_verdict',
  description:
    'Close impacted sections without editing them: ok (the change does not falsify it — say why, e.g. the example passed before and after), ' +
    'governed (a decision says it stays as is — cite the decision id), or skipped (cannot be judged — say why). ' +
    'Pass several section_ids when one reason covers them all. Every impacted section needs a verdict or an edit before you finish.',
  input: z
    .object({
      pr_url: z.string().optional(),
      section_id: z.string().optional(),
      section_ids: z.array(z.string()).optional().describe('Several sections sharing one verdict and reason'),
      verdict: z.enum(['ok', 'governed', 'skipped']),
      reason: z.string().min(3),
      cites: z.array(z.string()).optional().describe('Decision ids'),
      runs: z.array(z.string()).optional().describe('Run ids that support the verdict'),
    })
    .refine((x) => x.section_id || x.section_ids?.length, { message: 'give section_id or section_ids' }),
  queries: [Q.sectionReachedByPr, Q.createVerdict],
  async run(ctx, input) {
    const tracer = new Tracer(ctx.graph);
    const pr = prOf(ctx, input.pr_url);
    if (input.verdict === 'governed' && !input.cites?.length) throw new Error('a governed verdict must cite the decision id(s)');
    const sections = [...new Set([...(input.section_id ? [input.section_id] : []), ...(input.section_ids ?? [])])];
    const ids: string[] = [];
    const evidence: Record<string, string[]> = {};
    for (const section of sections) {
      const path = (await sectionPath(tracer, pr, section)) ?? [];
      evidence[section] = path;
      ids.push(
        await writeVerdict(ctx, tracer, pr, { ...input, section_id: section }, { verdict: input.verdict, status: 'proposed', evidence: path, confidence: path.length ? 'path' : 'none' }),
      );
    }
    return result('record_verdict', tracer, `Verdict ${input.verdict} recorded for ${sections.length} section${sections.length > 1 ? 's' : ''}.`, { ids, evidence });
  },
};

export const proposeEditTool: ToolDef<VerdictInput & { pr_url?: string; new_text: string }, { id: string; evidence: string[] }> = {
  name: 'propose_edit',
  description:
    'Propose replacement Markdown for a stale doc section (the whole section, heading line included, as read_section returned it). ' +
    'Refused unless the graph has a path from this pull request\'s changes to the section: Lockstep never edits a paragraph without one. ' +
    'Keep everything that is still true; change only what the PR falsified, or what makes an already-broken example fail (fails before and after: say so). Cite the runs that prove it.',
  input: z.object({
    pr_url: z.string().optional(),
    section_id: z.string(),
    new_text: z.string().min(1),
    reason: z.string().min(3),
    cites: z.array(z.string()).optional(),
    runs: z.array(z.string()).optional(),
  }),
  queries: [Q.sectionReachedByPr, Q.readSection, Q.createVerdict],
  async run(ctx, input) {
    const tracer = new Tracer(ctx.graph);
    const pr = prOf(ctx, input.pr_url);
    const evidence = await sectionPath(tracer, pr, input.section_id);
    if (!evidence) {
      throw new Error(
        `refused: no path in the graph from ${pr}'s changes to ${input.section_id}. Lockstep never edits a paragraph without a path; record_verdict instead if it needs no change.`,
      );
    }
    const old = (await tracer.run<{ body: string }>(Q.readSection, { id: input.section_id })).rows[0]?.body ?? '';
    if (old.trim() === input.new_text.trim()) throw new Error('new_text is identical to the current section; use record_verdict with ok');
    const id = await writeVerdict(ctx, tracer, pr, input, {
      verdict: 'stale',
      status: 'proposed',
      new_text: input.new_text,
      old_text: old,
      evidence,
      confidence: 'path',
    });
    return result('propose_edit', tracer, `Edit proposed for ${input.section_id} (evidence: ${evidence.join(' ← ')}).`, { id, evidence });
  },
};

function prOf(ctx: ToolContext, url: string | undefined): string {
  const raw = url ?? ctx.prUrl;
  if (!raw) throw new Error('pr_url is required');
  return parsePrUrl(raw).url;
}

export async function reviewVerdict(ctx: ToolContext, id: string, status: 'accepted' | 'rejected', by: string): Promise<boolean> {
  const r = await ctx.graph.run<{ id: string }>(Q.reviewVerdict, { id, status, by, at: Date.now() });
  return r.rows.length > 0;
}

export interface SinceLastCheck {
  since: number;
  prs: { url: string; title: string }[];
  verdicts: number;
  stale: number;
  decisions: { id: string; text: string }[];
  runs: number;
  failedRuns: number;
}

/** "Since your last run": what the graph learned after `since` (ms epoch). */
export async function sinceLastCheck(ctx: ToolContext, since: number): Promise<SinceLastCheck> {
  const row = (await ctx.graph.run<Omit<SinceLastCheck, 'since'>>(Q.sinceLastCheck, { since })).rows[0];
  return {
    since,
    prs: (row?.prs ?? []).filter((p) => p.url),
    verdicts: row?.verdicts ?? 0,
    stale: row?.stale ?? 0,
    decisions: (row?.decisions ?? []).filter((d) => d.id),
    runs: row?.runs ?? 0,
    failedRuns: row?.failedRuns ?? 0,
  };
}
