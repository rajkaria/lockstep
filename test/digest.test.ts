import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditData, AuditFinding } from '../src/audit.js';
import {
  buildDigest,
  digestMarkdown,
  digestState,
  digestText,
  discordPayload,
  jsonPayload,
  loadGraphState,
  postDigest,
  readState,
  runDigestCommand,
  slackPayload,
  stateComment,
  webhookKind,
} from '../src/digest.js';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import { FIXTURE_REPOS, FIXTURES, STALE_DOCS, testConfig, testGraph } from './helpers.js';

const GOLDEN = join(FIXTURES, 'digest');
const LAST_WEEK = Date.UTC(2026, 9, 10, 9);
const NOW = Date.UTC(2026, 9, 17, 9);
const BLOB = 'https://github.com/acme/app/blob/abc1234def5678';

/** Compare with a golden file; UPDATE_GOLDEN=1 writes it instead. */
function golden(name: string, value: unknown): void {
  const file = join(GOLDEN, name);
  const text = typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, text);
  }
  expect(text).toBe(readFileSync(file, 'utf8'));
}

function finding(path: string, line: number, subject: string, message: string, extra: Partial<AuditFinding> = {}): AuditFinding {
  return {
    rule: 'command-missing',
    severity: 'error',
    message,
    repo: 'acme/app',
    path,
    line,
    column: 1,
    endLine: line,
    endColumn: 2,
    surface: path === 'AGENTS.md' ? 'agent' : path === 'README.md' ? 'readme' : 'docs',
    subject,
    fingerprint: `${subject.replace(/\W/g, '').padEnd(10, '0').slice(0, 10)}abcdef`,
    evidence: { looked: 'package.json scripts', url: `${BLOB}/${path}#L${line}` },
    ...extra,
  };
}

const kept = finding('docs/install.md', 12, 'npm run setup', '`npm run setup` is not a script in package.json.');
const gone = finding('docs/install.md', 30, 'npm run seed', '`npm run seed` is not a script in package.json.');

function audit(over: Partial<AuditData>): AuditData {
  return {
    org: 'gh-acme',
    repos: [{ name: 'acme/app', sha: 'abc1234def5678', symbols: 10, sections: 8, indexVersion: 4, findingsChecked: true }],
    score: 88,
    grade: 'B',
    deductions: [],
    examples: { total: 5, python: 5, linked: 5, mismatched: 0 },
    mismatches: [],
    coverage: { api: 10, documented: 10, percent: 100 },
    undocumented: [],
    runs: [],
    runCounts: { pass: 0, fail: 0, skipped: 0, error: 0 },
    findings: [],
    generatedAt: NOW,
    ...over,
  } as AuditData;
}

const before = audit({ score: 88, grade: 'B', findings: [kept, gone] });
const after = audit({
  score: 81,
  grade: 'B',
  findings: [
    finding('AGENTS.md', 4, 'npm run lint:docs', '`npm run lint:docs` is not a script in package.json.', {
      fix: { description: 'Rename to `npm run lint-docs` (script renamed in package.json)', edits: [], verified: true },
    }),
    finding('README.md', 21, 'STALE_URL', '`STALE_URL` is not read anywhere in the code.', { rule: 'env-unused', severity: 'warning' }),
    kept,
    finding('docs/guide.md', 2, 'X_INFO', 'an info finding', { severity: 'info' }),
  ],
  mismatches: [
    {
      example: 'acme/app:docs/api.md:1',
      url: `${BLOB}/docs/api.md#L44`,
      repo: 'acme/app',
      path: 'docs/api.md',
      heading: 'API > Connect',
      line: 44,
      kind: 'unknown-keyword',
      detail: '`connect` has no parameter `tls`',
      call: 'app.connect',
      symbol: 'app.connect',
    },
  ],
  runs: [{ example: 'acme/app:docs/run.md:0', url: `${BLOB}/docs/run.md#L5`, status: 'fail', error: "TypeError: connect() got an unexpected keyword argument 'tls'\n  at line 3", reason: '' }],
  runCounts: { pass: 0, fail: 1, skipped: 0, error: 0 },
});

const LINK = 'https://github.com/acme/app/issues/7';

describe('digest', () => {
  const prev = digestState(before, LAST_WEEK);
  const d = buildDigest(after, prev, { now: NOW, link: LINK });

  it('compares with the previous digest: score change, what is new, what was fixed, fixes ready', () => {
    expect(d).toMatchObject({ scope: 'acme/app', score: 81, delta: -7, previous: { score: 88, grade: 'B', at: LAST_WEEK }, driftTotal: 4, fixed: 1, fixesTotal: 1 });
    // AI agent files first; the info finding and the unchanged reference are not new.
    expect(d.drift.map((i) => `${i.kind} ${i.path}:${i.line}`)).toEqual(['reference AGENTS.md:4', 'reference README.md:21', 'example docs/api.md:44', 'run docs/run.md:0']);
    expect(d.open).toEqual({ references: 3, examples: 1, failing: 1 });
  });

  it('golden: Slack {text, blocks}', () => golden('slack.json', slackPayload(d)));
  it('golden: Discord {content, embeds}', () => golden('discord.json', discordPayload(d)));
  it('golden: generic JSON', () => golden('generic.json', jsonPayload(d)));
  it('golden: text and Markdown', () => {
    golden('digest.txt', digestText(d));
    golden('digest.md', digestMarkdown(d));
  });
  it('golden: the first digest lists what is open', () => {
    const first = buildDigest(after, undefined, { now: NOW });
    expect(first.previous).toBeUndefined();
    expect(first.driftTotal).toBe(5);
    golden('slack-first.json', slackPayload(first));
  });

  it('payloads stay inside Slack and Discord limits', () => {
    const many = audit({ findings: Array.from({ length: 300 }, (_, i) => finding(`docs/p${i}.md`, i + 1, `npm run x${i}`, `\`npm run x${i}\` is not a script in package.json. ${'word '.repeat(30)}`)) });
    const big = buildDigest(many, undefined, { now: NOW, maxDrift: 300 });
    const slack = slackPayload(big);
    for (const b of slack.blocks) {
      const text = (b as { text?: { text: string } }).text?.text;
      if (text) expect(text.length).toBeLessThanOrEqual(3000);
    }
    const discord = discordPayload(big);
    expect((discord.embeds[0]!.description as string).length).toBeLessThanOrEqual(4096);
    expect(discord.content.length).toBeLessThanOrEqual(2000);
    expect(discord.allowed_mentions).toEqual({ parse: [] });
  });

  it('a digest of another scope, or none, is a first digest', () => {
    const other = { ...prev, scope: 'acme/other' };
    expect(buildDigest(after, other, { now: NOW }).previous).toBeUndefined();
  });

  it('a state too large to keep counts what is new instead of listing it', () => {
    const many = audit({ findings: Array.from({ length: 1001 }, (_, i) => finding('docs/a.md', i + 1, `s${i}`, 'm', { fingerprint: `${i.toString(16).padStart(10, '0')}abcdef` })) });
    const s = digestState(many, LAST_WEEK);
    expect(s.partial).toBe(true);
    expect(s.findings).toHaveLength(1000);
    const next = buildDigest(audit({ findings: [...many.findings!, finding('docs/b.md', 1, 'new', 'new one')] }), s, { now: NOW });
    expect(next).toMatchObject({ partialPrevious: true, drift: [], driftTotal: 2 });
    expect(digestText(next)).toContain('About 2 new since then');
  });
});

describe('digest state', () => {
  it('round-trips through a hidden issue-body line that cannot close the comment early', () => {
    const s = { ...digestState(after, NOW), scope: 'acme/odd-->name' };
    const line = stateComment(s);
    expect(line.startsWith('<!-- staleproof:state {')).toBe(true);
    expect(line.endsWith('} -->')).toBe(true);
    expect(line.slice(4, -3)).not.toContain('--');
    const body = `<!-- staleproof-audit -->\n### audit\n${stateComment({ ...s, score: 1 })}\nmore\n${line}\n`;
    expect(readState(body)).toEqual(s);
    expect(readState(JSON.stringify(s))).toEqual(s);
    expect(readState('no state here')).toBeUndefined();
    expect(readState('<!-- staleproof:state {"v":2} -->')).toBeUndefined();
  });
});

describe('webhooks', () => {
  it('chooses the payload by host', () => {
    expect(webhookKind('https://hooks.slack.com/services/T000/B000/XXXX')).toBe('slack');
    expect(webhookKind('https://discord.com/api/webhooks/123/abc')).toBe('discord');
    expect(webhookKind('https://discordapp.com/api/webhooks/123/abc')).toBe('discord');
    expect(webhookKind('https://canary.discord.com/api/webhooks/1/a')).toBe('discord');
    // Slack workflow triggers take their own variables, not blocks.
    expect(webhookKind('https://hooks.slack.com/triggers/T0/1/abc')).toBe('json');
    expect(webhookKind('https://example.com/hooks/staleproof')).toBe('json');
    expect(webhookKind('https://evil-discord.com/api/webhooks/1/a')).toBe('json');
    expect(() => webhookKind('not a url')).toThrow('not a URL');
  });

  it('posts JSON, retries once on 5xx, and never repeats the secret URL in errors', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 503;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = new Response('', { status });
      status = 200;
      return r;
    }) as unknown as typeof fetch;
    const url = 'https://hooks.slack.com/services/T000/B000/SECRET';
    expect(await postDigest(url, { text: 'hi' }, { fetchImpl, retryMs: 1 })).toEqual({ status: 200 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: '{"text":"hi"}' });
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const refuse = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    await expect(postDigest(url, {}, { fetchImpl: refuse })).rejects.toThrow('hooks.slack.com refused the digest: HTTP 404');
    const boom = (async () => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    }) as unknown as typeof fetch;
    const err = (await postDigest(url, {}, { fetchImpl: boom }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('hooks.slack.com');
    expect(err.message).not.toContain('SECRET');
  });
});

describe('staleproof digest (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let dir: string;
  beforeAll(async () => {
    ({ graph, done } = await testGraph('digest'));
    await indexOrg(graph, [...FIXTURE_REPOS, STALE_DOCS]);
    dir = await mkdtemp(join(tmpdir(), 'staleproof-digest-'));
  });
  afterAll(async () => done());

  it('audits, posts by host, and keeps the state in the report the issue is written from', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const report = join(dir, 'audit.md');
    await writeFile(report, '<!-- staleproof-audit -->\n### Staleproof docs audit\n');
    const logs: string[] = [];
    const first = await runDigestCommand({
      graph,
      config: testConfig(),
      repos: ['acme/stale-docs'],
      webhook: 'https://discord.com/api/webhooks/1/SECRET',
      previous: join(dir, 'missing-issue-body.md'),
      stateOut: report,
      fetchImpl,
      now: LAST_WEEK,
      log: (m) => logs.push(m),
    });
    expect(first.posted).toEqual({ kind: 'discord', status: 204 });
    expect(posted[0]!.body).toMatchObject({ embeds: [{ title: 'Staleproof docs digest: acme/stale-docs' }] });
    expect(first.digest.previous).toBeUndefined();
    expect(first.digest.open.examples).toBe(5);
    expect(logs.join('\n')).not.toContain('SECRET');
    const body = await readFile(report, 'utf8');
    expect(readState(body)).toEqual(first.state);

    // A week later the issue body (the report above) holds the state: nothing changed.
    const second = await runDigestCommand({ graph, config: testConfig(), repos: ['acme/stale-docs'], previous: report, now: NOW, format: 'json' });
    expect(second.digest).toMatchObject({ delta: 0, driftTotal: 0, fixed: 0, previous: { at: LAST_WEEK } });
    expect(JSON.parse(second.output)).toMatchObject({ type: 'staleproof.digest', newTotal: 0, delta: 0 });
    expect(second.posted).toBeUndefined();
  });

  it('keeps the state in a persistent graph', async () => {
    const one = await runDigestCommand({ graph, config: testConfig(), repos: ['acme/stale-docs'], graphState: true, now: LAST_WEEK });
    expect(await loadGraphState(graph, 'acme/stale-docs')).toEqual(one.state);
    const two = await runDigestCommand({ graph, config: testConfig(), repos: ['acme/stale-docs'], graphState: true, now: NOW });
    expect(two.digest.previous?.at).toBe(LAST_WEEK);
    expect(two.output).toMatch(/^Docs health for acme\/stale-docs: \d+\/100 \([A-F]\), unchanged since the last digest \(2026-10-10/);
  });

  it('says what to do when nothing is indexed', async () => {
    await expect(runDigestCommand({ graph, config: testConfig(), repos: ['acme/nope'] })).rejects.toThrow('not indexed');
    await expect(runDigestCommand({ graph, config: testConfig(), format: 'xml' as never })).rejects.toThrow('unknown --format xml');
  });
});
