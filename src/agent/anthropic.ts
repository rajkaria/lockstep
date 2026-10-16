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
  /** API base URL override (an Anthropic-compatible provider, proxies, tests). Without it the SDK reads ANTHROPIC_BASE_URL. */
  baseURL?: string;
  /**
   * The endpoint is an Anthropic-compatible provider (e.g. DeepSeek), not the Claude API: send only the portable
   * Messages fields (no betas, refusal fallback or eager input streaming) and refuse a `claude-*` model name, which
   * such providers silently remap, so every trace records the model that actually ran.
   */
  compatible?: boolean;
}

export class MissingCredentialsError extends Error {}

const NO_CREDENTIALS =
  'the agent needs model API credentials: set ANTHROPIC_API_KEY (or run `ant auth login`) for the Claude API, or ' +
  'ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY and STALEPROOF_MODEL for an Anthropic-compatible provider such as DeepSeek. ' +
  'Use `check --no-agent` to run the graph tools without a model.';

/** True when a base URL names another provider rather than the Claude API (`api.anthropic.com`). */
export function isCompatibleProvider(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    return new URL(baseURL).hostname !== 'api.anthropic.com';
  } catch {
    return true;
  }
}

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
 * With `compatible`, the same loop runs on an Anthropic-compatible provider using
 * the portable subset: thinking (so traces keep their reasoning), effort, tools.
 */
export class AnthropicModel implements ModelClient {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;
  private readonly fallbacks: boolean;
  private readonly maxTokens: number;
  private readonly compatible: boolean;

  constructor(opts: AnthropicModelOptions) {
    this.name = opts.model;
    this.effort = opts.effort ?? 'medium';
    this.fallbacks = opts.fallbacks ?? true;
    this.maxTokens = opts.maxTokens ?? 32_000;
    this.compatible = opts.compatible ?? false;
    if (this.compatible && /^claude-/i.test(opts.model)) {
      throw new Error(
        `"${opts.model}" is a Claude model name, but the model endpoint is an Anthropic-compatible provider, which would ` +
          `answer with its own model under that name; set STALEPROOF_MODEL to the provider's model (e.g. deepseek-v4-pro)`,
      );
    }
    if (!opts.apiKey && !claudeCredentialsAvailable()) throw new MissingCredentialsError(NO_CREDENTIALS);
    // Without an explicit key the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  }

  async turn(req: TurnRequest, cb?: TurnCallbacks): Promise<ModelMessage> {
    const stream: ReturnType<Anthropic['beta']['messages']['stream']> = this.compatible ? this.compatibleStream(req) : this.client.beta.messages.stream({
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
    if (cb?.onText) stream.on('text', (d: string) => cb.onText!(d));
    if (cb?.onThinking) stream.on('thinking', (d: string) => cb.onThinking!(d));
    try {
      return await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || /resolve authentication/i.test((err as Error).message)) {
        throw new MissingCredentialsError(`${NO_CREDENTIALS} (${(err as Error).message})`);
      }
      throw err;
    }
  }

  /** The portable Messages request (plain endpoint, no betas): what Anthropic-compatible providers accept. */
  private compatibleStream(req: TurnRequest): ReturnType<Anthropic['beta']['messages']['stream']> {
    const params = {
      model: this.name,
      max_tokens: this.maxTokens,
      system: req.system,
      tools: req.tools,
      messages: req.messages,
      thinking: { type: 'enabled', budget_tokens: Math.min(16_000, this.maxTokens - 1_000) },
      output_config: { effort: this.effort },
    };
    // Same events and final message shape as the beta stream the loop consumes.
    return this.client.messages.stream(params as unknown as Anthropic.MessageStreamParams) as unknown as ReturnType<Anthropic['beta']['messages']['stream']>;
  }
}
