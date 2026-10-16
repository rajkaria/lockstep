import type { ClearedSymbol, DecisionHit, ImpactData, QueryTrace, RankedSection, RunExampleData, TraceEvent } from './types.js';

export type TraceItem =
  | { kind: 'thinking'; text: string; step: number }
  | { kind: 'text'; text: string; step: number }
  | { kind: 'nudge'; missing: string[]; step: number }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      step: number;
      result?: { summary: string; isError: boolean; queries: QueryTrace[]; ms: number };
    };

export interface Verdict {
  verdict: 'stale' | 'ok' | 'governed' | 'skipped';
  reason: string;
  newText?: string;
}

export interface IndexingView {
  repos: string[];
  graph: string;
  reason: string;
  startedAt: number;
  steps: { message: string; at: number }[];
  finished?: Extract<TraceEvent, { type: 'index_finished' }>;
}

export interface CheckView {
  /** Hosted: the repository was indexed first, as part of this check. */
  indexing?: IndexingView;
  checkId?: string;
  pr?: string;
  model?: string;
  since?: string;
  startedAt?: number;
  items: TraceItem[];
  live: { text: string; thinking: string };
  impact?: ImpactData;
  cleared?: ClearedSymbol[];
  ranked?: RankedSection[];
  runs: Record<string, RunExampleData>;
  verdicts: Record<string, Verdict>;
  decisions: Record<string, DecisionHit[]>;
  bodies: Record<string, string>;
  finished?: Extract<TraceEvent, { type: 'check_finished' }>;
  queued: boolean;
  error?: string;
}

export const emptyView = (): CheckView => ({
  items: [],
  live: { text: '', thinking: '' },
  runs: {},
  verdicts: {},
  decisions: {},
  bodies: {},
  queued: false,
});

/** Fold one trace event into the view. Pure: the same events always give the same view (live or replayed). */
export function reduce(view: CheckView, e: TraceEvent): CheckView {
  switch (e.type) {
    case 'queued':
      return { ...view, queued: true };
    case 'error':
      return { ...view, error: e.message, queued: false };
    case 'check_started':
      return { ...view, checkId: e.checkId, pr: e.pr, model: e.model, since: e.since, startedAt: e.at, queued: false };
    case 'delta':
      return { ...view, live: { ...view.live, [e.kind]: view.live[e.kind] + e.text } };
    case 'thinking':
      return { ...view, live: { ...view.live, thinking: '' }, items: [...view.items, { kind: 'thinking', text: e.text, step: e.step }] };
    case 'text':
      return { ...view, live: { ...view.live, text: '' }, items: [...view.items, { kind: 'text', text: e.text, step: e.step }] };
    case 'nudge':
      return { ...view, items: [...view.items, { kind: 'nudge', missing: e.missing, step: e.step }] };
    case 'tool_call':
      return { ...view, items: [...view.items, { kind: 'tool', id: e.id, name: e.name, input: e.input, step: e.step }] };
    case 'tool_result': {
      const items = view.items.map((it) =>
        it.kind === 'tool' && it.id === e.id ? { ...it, result: { summary: e.summary, isError: e.isError, queries: e.queries, ms: e.ms } } : it,
      );
      const call = view.items.find((it): it is Extract<TraceItem, { kind: 'tool' }> => it.kind === 'tool' && it.id === e.id);
      const next: CheckView = { ...view, items };
      if (e.isError || !e.data || (e.data as { __trimmed?: boolean }).__trimmed) return next;
      const input = call?.input ?? {};
      switch (e.name) {
        case 'impact':
          next.impact = e.data as ImpactData;
          break;
        case 'clearance':
          next.cleared = (e.data as { cleared: ClearedSymbol[] }).cleared;
          break;
        case 'rank_sections':
          next.ranked = (e.data as { ranked: RankedSection[] }).ranked;
          break;
        case 'run_example': {
          const d = e.data as RunExampleData;
          next.runs = { ...view.runs, [d.example]: d };
          break;
        }
        case 'read_section': {
          const d = e.data as { id: string; body: string } | null;
          if (d) next.bodies = { ...view.bodies, [d.id]: d.body };
          break;
        }
        case 'decisions_for': {
          const target = String(input.target_id ?? '');
          next.decisions = { ...view.decisions, [target]: (e.data as { decisions: DecisionHit[] }).decisions };
          break;
        }
        case 'propose_edit':
          next.verdicts = { ...view.verdicts, [String(input.section_id)]: { verdict: 'stale', reason: String(input.reason ?? ''), newText: String(input.new_text ?? '') } };
          break;
        case 'record_verdict': {
          const ids = [...(input.section_id ? [String(input.section_id)] : []), ...((input.section_ids as string[] | undefined) ?? [])];
          const verdicts = { ...view.verdicts };
          for (const id of ids) verdicts[id] = { verdict: input.verdict as Verdict['verdict'], reason: String(input.reason ?? '') };
          next.verdicts = verdicts;
          break;
        }
      }
      return next;
    }
    case 'check_finished':
      return { ...view, finished: e, live: { text: '', thinking: '' } };
    case 'index_started':
      return { ...view, queued: false, indexing: { repos: e.repos, graph: e.graph, reason: e.reason, startedAt: e.at, steps: [] } };
    case 'index_progress':
      return view.indexing ? { ...view, indexing: { ...view.indexing, steps: [...view.indexing.steps, { message: e.message, at: e.at }] } } : view;
    case 'index_finished':
      return view.indexing ? { ...view, indexing: { ...view.indexing, finished: e } } : view;
    case 'indexed':
      return view;
  }
}

export function replay(events: TraceEvent[]): CheckView {
  return events.reduce(reduce, emptyView());
}
