import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicModel, claudeCredentialsAvailable, isCompatibleProvider, MissingCredentialsError } from '../src/agent/anthropic.js';
import { loadConfig } from '../src/config.js';
import { SYSTEM_PROMPT } from '../src/agent/prompt.js';
import { modelTools } from '../src/tools/index.js';

const SSE = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Start with impact.' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'impact', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pr_url": "https://github.com/a/b/pull/1"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } }],
  ['message_stop', { type: 'message_stop' }],
] as const;

describe('AnthropicModel (local fake API, no paid calls)', () => {
  let server: Server;
  let url: string;
  const seen: { url: string; headers: IncomingMessage['headers']; body: Record<string, any> }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [event, data] of SSE) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    url = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('streams one turn with the configured model, effort, adaptive summarized thinking, cached system prompt and refusal fallback', async () => {
    const model = new AnthropicModel({ model: 'claude-sonnet-5-5', apiKey: 'test-key', baseURL: url });
    const thinking: string[] = [];
    const msg = await model.turn({ system: SYSTEM_PROMPT, tools: modelTools(), messages: [{ role: 'user', content: 'Check https://github.com/a/b/pull/1.' }] }, { onThinking: (d) => thinking.push(d) });
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content.find((b) => b.type === 'tool_use')).toMatchObject({ name: 'impact', input: { pr_url: 'https://github.com/a/b/pull/1' } });
    expect(thinking.join('')).toBe('Start with impact.');
    const { body, headers } = seen[0]!;
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      stream: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
    });
    expect(body.tools.every((t: { eager_input_streaming: boolean }) => t.eager_input_streaming === true)).toBe(true);
    expect(body.tool_choice).toBeUndefined();
    expect(String(headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
  });

  it('on an Anthropic-compatible provider, sends only the portable fields: plain endpoint, thinking, effort, tools', async () => {
    const model = new AnthropicModel({ model: 'deepseek-v4-pro', apiKey: 'test-key', baseURL: url, compatible: true });
    const msg = await model.turn({ system: SYSTEM_PROMPT, tools: modelTools(), messages: [{ role: 'user', content: 'Check https://github.com/a/b/pull/1.' }] });
    expect(msg.content.find((b) => b.type === 'tool_use')).toMatchObject({ name: 'impact' });
    const { url: path, body, headers } = seen.at(-1)!;
    expect(path).toBe('/v1/messages');
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(body).toMatchObject({ model: 'deepseek-v4-pro', stream: true, system: SYSTEM_PROMPT, thinking: { type: 'enabled' }, output_config: { effort: 'medium' } });
    expect(body.fallbacks).toBeUndefined();
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(modelTools().map((t) => t.name));
    expect(body.tools.some((t: object) => 'eager_input_streaming' in t)).toBe(false);
  });

  it('refuses a Claude model name on another provider, which would remap it and mislabel every trace', () => {
    expect(() => new AnthropicModel({ model: 'claude-sonnet-5-5', apiKey: 'k', baseURL: url, compatible: true })).toThrow(/LOCKSTEP_MODEL/);
  });

  it('detects the provider from ANTHROPIC_BASE_URL', () => {
    expect(isCompatibleProvider(undefined)).toBe(false);
    expect(isCompatibleProvider('https://api.anthropic.com')).toBe(false);
    expect(isCompatibleProvider('https://api.deepseek.com/anthropic')).toBe(true);
    expect(loadConfig({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', LOCKSTEP_MODEL: 'deepseek-v4-pro' })).toMatchObject({
      modelBaseUrl: 'https://api.deepseek.com/anthropic',
      modelCompatible: true,
      model: 'deepseek-v4-pro',
    });
    expect(loadConfig({}).modelCompatible).toBe(false);
  });

  it('fails loudly without credentials instead of falling back to anything', () => {
    expect(claudeCredentialsAvailable({ HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent' })).toBe(false);
    expect(claudeCredentialsAvailable({ ANTHROPIC_API_KEY: 'x' })).toBe(true);
    const saved = { ...process.env };
    try {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_PROFILE;
      process.env.XDG_CONFIG_HOME = '/nonexistent';
      expect(() => new AnthropicModel({ model: 'claude-sonnet-5-5' })).toThrow(MissingCredentialsError);
    } finally {
      process.env = saved;
    }
  });
});
