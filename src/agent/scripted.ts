import type { ModelClient, ModelMessage, ModelMessageParam, TurnCallbacks, TurnRequest } from './model.js';

export interface ScriptedCall {
  name: string;
  input: Record<string, unknown>;
}

/** One scripted turn: tool calls (run in parallel), a note shown as a thinking summary, or final text. */
export interface ScriptedTurn {
  thinking?: string;
  calls?: ScriptedCall[];
  text?: string;
}

/**
 * A deterministic stand-in for Claude in tests: each turn is computed from the
 * conversation so far (so a script can react to what tools returned).
 */
export class ScriptedModel implements ModelClient {
  readonly name = 'scripted';
  readonly requests: TurnRequest[] = [];
  private n = 0;

  constructor(private readonly script: (history: ModelMessageParam[], turn: number) => ScriptedTurn) {}

  async turn(req: TurnRequest, cb?: TurnCallbacks): Promise<ModelMessage> {
    this.requests.push(structuredClone(req));
    const t = this.script(req.messages, this.n++);
    const content: unknown[] = [];
    if (t.thinking) {
      cb?.onThinking?.(t.thinking);
      content.push({ type: 'thinking', thinking: t.thinking, signature: 'scripted' });
    }
    if (t.text) {
      cb?.onText?.(t.text);
      content.push({ type: 'text', text: t.text, citations: null });
    }
    for (const [i, c] of (t.calls ?? []).entries()) {
      content.push({ type: 'tool_use', id: `toolu_${this.n}_${i}`, name: c.name, input: c.input, caller: { type: 'direct' } });
    }
    return {
      id: `msg_scripted_${this.n}`,
      type: 'message',
      role: 'assistant',
      model: this.name,
      content,
      stop_reason: t.calls?.length ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      stop_details: null,
      container: null,
      context_management: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as ModelMessage;
  }
}

/** The tool results the model received in the most recent user turn, parsed. */
export function lastToolResults(history: ModelMessageParam[]): { name?: string; content: Record<string, unknown> }[] {
  const last = history[history.length - 1];
  if (!last || last.role !== 'user' || typeof last.content === 'string') return [];
  return last.content
    .filter((b) => b.type === 'tool_result')
    .map((b) => {
      const raw = (b as { content?: unknown }).content;
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((x: { text?: string }) => x.text ?? '').join('') : '';
      try {
        return { content: JSON.parse(text) as Record<string, unknown> };
      } catch {
        return { content: { text } };
      }
    });
}
