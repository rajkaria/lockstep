import type { QueryTrace } from '../tools/types.js';

export type TraceEvent =
  | { type: 'check_started'; checkId: string; pr: string; model: string; at: number; since?: string }
  | { type: 'delta'; kind: 'text' | 'thinking'; text: string; step: number }
  | { type: 'thinking'; text: string; step: number }
  | { type: 'text'; text: string; step: number }
  | { type: 'tool_call'; id: string; name: string; input: unknown; step: number }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      summary: string;
      isError: boolean;
      queries: QueryTrace[];
      data?: unknown;
      ms: number;
      step: number;
    }
  | { type: 'nudge'; missing: string[]; step: number }
  | {
      type: 'check_finished';
      checkId: string;
      status: CheckStatus;
      summary: string;
      steps: number;
      toolCalls: number;
      toolOrder: string[];
      verdicts: number;
      missing: string[];
      usage: { input: number; output: number; cacheRead: number };
      at: number;
    };

export type CheckStatus = 'done' | 'incomplete' | 'refused' | 'error';

/** Events stored on the Check node (live-only deltas dropped, big payloads trimmed). */
export function storedTrace(events: TraceEvent[]): TraceEvent[] {
  return events
    .filter((e) => e.type !== 'delta')
    .map((e) => (e.type === 'tool_result' ? { ...e, data: trimData(e.data) } : e));
}

/** Keep tool data readable in a stored trace without storing whole sections twice. */
export function trimData(data: unknown, max = 6000): unknown {
  const json = JSON.stringify(data ?? null);
  if (json.length <= max) return data;
  return { truncated: true, preview: `${json.slice(0, max)}…` };
}
