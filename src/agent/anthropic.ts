import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelMessage, TurnCallbacks, TurnRequest } from './model.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicModelOptions {
  model: string;
  effort?: Effort;
  /** Server-side refusal fallback (Claude API only). On by default. */
  fallbacks?: boolean;
  apiKey?: string;
  maxTokens?: number;
  /** API base URL override (proxies, tests). */
  baseURL?: string;
}

export class MissingCredentialsError extends Error {}

const NO_CREDENTIALS =
  'the agent needs Claude API credentials: set ANTHROPIC_API_KEY (or run `ant auth login`). ' +
  'Use `check --no-agent` to run the graph tools without a model.';

/**
 * Whether the SDK will find credentials: an API key or auth token in the
 * environment, a selected profile, or an `ant auth login` profile on disk.
 */
export function claudeCredentialsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) return true;
  if (env.ANTHROPIC_FEDERATION_RULE_ID && (env.ANTHROPIC_IDENTITY_TOKEN || env.ANTHROPIC_IDENTITY_TOKEN_FILE)) return true;
  const config = env.ANTHROPIC_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'anthropic');
  return existsSync(config);
}

/**
 * Claude through the Anthropic SDK: streamed turns, adaptive thinking with
 * summarized display (the trace shows why each tool was chosen), effort set
 * explicitly, the stable system prompt cached, and server-side refusal fallback.
 */
export class AnthropicModel implements ModelClient {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;
  private readonly fallbacks: boolean;
  private readonly maxTokens: number;

  constructor(opts: AnthropicModelOptions) {
    this.name = opts.model;
    this.effort = opts.effort ?? 'medium';
    this.fallbacks = opts.fallbacks ?? true;
    this.maxTokens = opts.maxTokens ?? 32_000;
    if (!opts.apiKey && !claudeCredentialsAvailable()) throw new MissingCredentialsError(NO_CREDENTIALS);
    // Without an explicit key the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  }

  async turn(req: TurnRequest, cb?: TurnCallbacks): Promise<ModelMessage> {
    const stream = this.client.beta.messages.stream({
      model: this.name,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      // Inputs stream as generated; the loop validates every input against the tool's schema.
      tools: req.tools.map((t) => ({ ...t, eager_input_streaming: true })),
      messages: req.messages,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: this.effort },
      ...(this.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    if (cb?.onText) stream.on('text', (d) => cb.onText!(d));
    if (cb?.onThinking) stream.on('thinking', (d) => cb.onThinking!(d));
    try {
      return await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || /resolve authentication/i.test((err as Error).message)) {
        throw new MissingCredentialsError(`${NO_CREDENTIALS} (${(err as Error).message})`);
      }
      throw err;
    }
  }
}
