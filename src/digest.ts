import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { auditDocs, type AuditData } from './audit.js';
import type { Config } from './config.js';
import type { OrgGraph } from './graph/client.js';
import { scoreColor } from './server/badge.js';

/**
 * The docs digest: what changed in a repository's docs health since the last digest, for
 * a team channel. Score and its change, the drift that appeared since then (with links),
 * and the verified fixes ready to apply. Posted to Slack (`{text, blocks}`), Discord
 * (`{content, embeds}`) or any other webhook as JSON, chosen by the webhook's host.
 *
 * The previous digest is remembered as a hidden `<!-- staleproof:state {...} -->` line in
 * the audit issue's body (the Action keeps it there), or in the graph when the graph is
 * persistent (`DigestState` node).
 */

export const STATE_MARKER = 'staleproof:state';
/** Keys kept per list in the state (the audit issue body is limited to 65,536 characters). */
const MAX_KEYS = 1000;

export interface DigestState {
  v: 1;
  /** The audited repositories, sorted and comma-separated. */
  scope: string;
  at: number;
  /** `owner/name@abc1234` per repository. */
  commits: string[];
  score: number;
  grade: string;
  /** Short keys of the open docs references (fingerprints). */
  findings: string[];
  /** Short keys of the example lines that no longer fit and the examples failing when run. */
  examples: string[];
  /** More problems than the state keeps: what is new cannot be told item by item. */
  partial?: boolean;
}

export interface DriftItem {
  kind: 'reference' | 'example' | 'run';
  repo: string;
  path: string;
  line: number;
  message: string;
  url?: string;
  /** The lint rule, for docs references. */
  rule?: string;
}

export interface DigestFix {
  repo: string;
  path: string;
  line: number;
  description: string;
  url?: string;
}

export interface Digest {
  scope: string;
  commits: string[];
  score: number;
  grade: string;
  generatedAt: number;
  /** The digest this one compares with; absent the first time. */
  previous?: { score: number; grade: string; at: number };
  delta?: number;
  /** New since the previous digest (every open problem the first time), AI agent files first, capped. */
  drift: DriftItem[];
  driftTotal: number;
  /** Problems of the previous digest that are gone. */
  fixed?: number;
  /** Open problems now. */
  open: { references: number; examples: number; failing: number };
  /** Docs references with a verified mechanical fix (`staleproof fix` applies them), capped. */
  fixes: DigestFix[];
  fixesTotal: number;
  /** The previous state was partial: new problems are counted, not listed. */
  partialPrevious?: boolean;
  /** The full report (the audit issue, the workflow run, the hosted audit). */
  link?: string;
}

const short = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10);

interface Keyed {
  key: string;
  item: DriftItem;
}

function scopeOf(a: AuditData): string {
  return a.repos.map((r) => r.name).sort().join(',');
}

/** The audit's open problems with their state keys, in report order (agent files first, then examples, then runs). */
function problems(a: AuditData): { findings: Keyed[]; examples: Keyed[] } {
  const findings = (a.findings ?? [])
    .filter((f) => f.severity !== 'info')
    .map((f) => ({
      key: f.fingerprint.slice(0, 10),
      item: { kind: 'reference' as const, repo: f.repo ?? a.repos[0]?.name ?? '', path: f.path, line: f.line, message: f.message, url: f.evidence?.url, rule: f.rule },
    }));
  const examples: Keyed[] = a.mismatches.map((m) => ({
    key: short(`m|${m.example}|${m.kind}|${m.symbol}|${m.call}`),
    item: { kind: 'example', repo: m.repo, path: m.path, line: m.line, message: `Example: ${m.detail.replace(/\.?$/, '.')}`, url: m.url },
  }));
  for (const r of a.runs) {
    if (r.status !== 'fail' && r.status !== 'timeout') continue;
    const repo = a.repos.map((x) => x.name).find((n) => r.example.startsWith(`${n}:`)) ?? '';
    const rest = r.example.slice(repo.length + 1);
    examples.push({
      key: short(`r|${r.example}`),
      item: { kind: 'run', repo, path: rest.slice(0, rest.lastIndexOf(':')), line: 0, message: `Example fails when run: ${(r.error || r.reason).split('\n')[0]!.slice(0, 140)}`, url: r.url },
    });
  }
  // Keep one entry per key (an example can mismatch twice on one line).
  const uniq = (xs: Keyed[]) => [...new Map(xs.map((x) => [x.key, x])).values()];
  return { findings: uniq(findings), examples: uniq(examples) };
}

/** The state to remember for the next digest. */
export function digestState(a: AuditData, at = Date.now()): DigestState {
  const p = problems(a);
  const keys = (xs: Keyed[]) => xs.map((x) => x.key).sort();
  const findings = keys(p.findings);
  const examples = keys(p.examples);
  const partial = findings.length > MAX_KEYS || examples.length > MAX_KEYS;
  return {
    v: 1,
    scope: scopeOf(a),
    at,
    commits: a.repos.map((r) => `${r.name}@${(r.sha ?? '').slice(0, 7)}`),
    score: a.score,
    grade: a.grade,
    findings: findings.slice(0, MAX_KEYS),
    examples: examples.slice(0, MAX_KEYS),
    ...(partial ? { partial: true } : {}),
  };
}

export interface DigestOptions {
  now?: number;
  link?: string;
  maxDrift?: number;
  maxFixes?: number;
}

/** Compare an audit with the previous digest's state (none, or of another scope: a first digest). */
export function buildDigest(a: AuditData, prev: DigestState | undefined, opts: DigestOptions = {}): Digest {
  const scope = scopeOf(a);
  const before = prev && prev.scope === scope ? prev : undefined;
  const p = problems(a);
  const all = [...p.findings, ...p.examples];
  const open = {
    references: p.findings.length,
    examples: p.examples.filter((x) => x.item.kind === 'example').length,
    failing: p.examples.filter((x) => x.item.kind === 'run').length,
  };
  let fresh = all;
  let fixed: number | undefined;
  if (before && !before.partial) {
    const seen = new Set([...before.findings, ...before.examples]);
    fresh = all.filter((x) => !seen.has(x.key));
    const now = new Set(all.map((x) => x.key));
    fixed = [...seen].filter((k) => !now.has(k)).length;
  } else if (before?.partial) {
    fresh = [];
  }
  const fixes = (a.findings ?? [])
    .filter((f) => f.fix?.verified)
    .map((f) => ({ repo: f.repo ?? '', path: f.path, line: f.line, description: f.fix!.description, url: f.evidence?.url }));
  return {
    scope,
    commits: a.repos.map((r) => `${r.name}@${(r.sha ?? '').slice(0, 7)}`),
    score: a.score,
    grade: a.grade,
    generatedAt: opts.now ?? Date.now(),
    ...(before ? { previous: { score: before.score, grade: before.grade, at: before.at }, delta: a.score - before.score } : {}),
    drift: fresh.slice(0, opts.maxDrift ?? 10).map((x) => x.item),
    driftTotal: before?.partial ? Math.max(0, all.length - before.findings.length - before.examples.length) : fresh.length,
    ...(fixed !== undefined ? { fixed } : {}),
    open,
    fixes: fixes.slice(0, opts.maxFixes ?? 5),
    fixesTotal: fixes.length,
    ...(before?.partial ? { partialPrevious: true } : {}),
    ...(opts.link ? { link: opts.link } : {}),
  };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function change(d: Digest): string {
  if (!d.previous) return '';
  const delta = d.delta ?? 0;
  const how = delta > 0 ? `up ${delta}` : delta < 0 ? `down ${-delta}` : 'unchanged';
  return `${how} since the last digest (${day(d.previous.at)}, ${d.previous.score}/100)`;
}

function scopeLabel(d: Digest): string {
  const repos = d.scope.split(',');
  return repos.length === 1 ? repos[0]! : `${repos[0]} and ${repos.length - 1} more`;
}

function headline(d: Digest): string {
  return `Docs health for ${scopeLabel(d)}: ${d.score}/100 (${d.grade})${d.previous ? `, ${change(d)}` : ''}.`;
}

/** The counts after the headline: new and fixed since the last digest, open problems, fixes ready. */
function details(d: Digest): string {
  const total = d.open.references + d.open.examples + d.open.failing;
  const openLine = total
    ? `${plural(total, 'open problem')}: ${[
        d.open.references && plural(d.open.references, 'docs reference'),
        d.open.examples && plural(d.open.examples, 'example line'),
        d.open.failing && plural(d.open.failing, 'failing example'),
      ]
        .filter(Boolean)
        .join(', ')}.`
    : 'No open docs problems.';
  const since = d.previous ? `${d.partialPrevious ? `About ${d.driftTotal}` : d.driftTotal} new since then${d.fixed !== undefined ? `, ${d.fixed} fixed` : ''}. ` : '';
  const fixes = d.fixesTotal ? ` ${plural(d.fixesTotal, 'verified fix')} ready (staleproof fix).` : '';
  return `${since}${openLine}${fixes}`;
}

/** The digest's headline and counts, as plain sentences (Slack's fallback text, Discord's content). */
export function digestSummary(d: Digest): string {
  return `${headline(d)} ${details(d)}`;
}

const where = (i: { repo: string; path: string; line: number }, multi: boolean) => `${multi ? `${i.repo}:` : ''}${i.path}${i.line ? `:${i.line}` : ''}`;

function driftTitle(d: Digest): string {
  return d.previous ? 'New since the last digest' : 'Open docs problems';
}

/** Plain text (the CLI's default output). */
export function digestText(d: Digest): string {
  const multi = d.scope.includes(',');
  const out = [digestSummary(d)];
  if (d.drift.length) {
    out.push('', `${driftTitle(d)}:`);
    for (const i of d.drift) out.push(`  ${where(i, multi)}  ${i.message}`);
    if (d.driftTotal > d.drift.length) out.push(`  … and ${d.driftTotal - d.drift.length} more`);
  } else if (d.partialPrevious) {
    out.push('', 'Too many open problems to track one by one: the change is counted, not listed.');
  }
  if (d.fixes.length) {
    out.push('', 'Verified fixes (staleproof fix applies them):');
    for (const f of d.fixes) out.push(`  ${where(f, multi)}  ${f.description}`);
  }
  if (d.link) out.push('', `Full report: ${d.link}`);
  return out.join('\n');
}

/** Markdown (a job summary). */
export function digestMarkdown(d: Digest): string {
  const multi = d.scope.includes(',');
  const link = (label: string, url?: string) => (url ? `[${label.replace(/[[\]]/g, '')}](${url})` : `\`${label}\``);
  const out = [`### Staleproof docs digest: ${scopeLabel(d)}`, '', digestSummary(d)];
  if (d.drift.length) {
    out.push('', `**${driftTitle(d)}**`, '');
    for (const i of d.drift) out.push(`- ${link(where(i, multi), i.url)}: ${i.message}`);
    if (d.driftTotal > d.drift.length) out.push(`- … and ${d.driftTotal - d.drift.length} more`);
  }
  if (d.fixes.length) {
    out.push('', '**Verified fixes** (`staleproof fix` applies them)', '');
    for (const f of d.fixes) out.push(`- ${link(where(f, multi), f.url)}: ${f.description}`);
  }
  if (d.link) out.push('', `[Full report](${d.link})`);
  return out.join('\n');
}

// Slack mrkdwn: escape the three control characters; a link label cannot hold `|`.
const slackEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slackLink = (label: string, url?: string) => (url ? `<${url}|${slackEsc(label).replace(/\|/g, '¦')}>` : `\`${slackEsc(label)}\``);

/** Lines joined under a limit (Slack sections take 3000 characters, Discord descriptions 4096). */
function fit(lines: string[], max: number): string {
  const out: string[] = [];
  let n = 0;
  for (const [i, l] of lines.entries()) {
    if (n + l.length + 1 > max - 40) {
      out.push(`… and ${lines.length - i} more`);
      break;
    }
    out.push(l);
    n += l.length + 1;
  }
  return out.join('\n');
}

export interface SlackPayload {
  text: string;
  blocks: Record<string, unknown>[];
}

export function slackPayload(d: Digest): SlackPayload {
  const multi = d.scope.includes(',');
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: `Staleproof docs digest: ${scopeLabel(d)}`.slice(0, 150) } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: slackEsc(`*Docs health ${d.score}/100 (${d.grade})*${d.previous ? `, ${change(d)}` : ''}\n${details(d)}`),
      },
    },
  ];
  if (d.drift.length) {
    const lines = d.drift.map((i) => `• ${slackLink(where(i, multi), i.url)} ${slackEsc(i.message)}`);
    if (d.driftTotal > d.drift.length) lines.push(`… and ${d.driftTotal - d.drift.length} more`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fit([`*${driftTitle(d)}*`, ...lines], 3000) } });
  }
  if (d.fixes.length) {
    const lines = d.fixes.map((f) => `• ${slackLink(where(f, multi), f.url)} ${slackEsc(f.description)}`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fit(['*Verified fixes* (`staleproof fix` applies them)', ...lines], 3000) } });
  }
  const context = [d.link ? `<${d.link}|Full report>` : '', slackEsc(`checked at ${d.commits.join(', ')}`), 'Staleproof'].filter(Boolean).join(' · ');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: context }] });
  return { text: digestSummary(d), blocks };
}

export interface DiscordPayload {
  content: string;
  embeds: Record<string, unknown>[];
  allowed_mentions: { parse: string[] };
}

export function discordPayload(d: Digest): DiscordPayload {
  const multi = d.scope.includes(',');
  const link = (label: string, url?: string) => (url ? `[${label.replace(/[[\]]/g, '')}](${url})` : `\`${label}\``);
  const parts: string[] = [];
  if (d.drift.length) {
    parts.push(`**${driftTitle(d)}**`, ...d.drift.map((i) => `• ${link(where(i, multi), i.url)} ${i.message}`));
    if (d.driftTotal > d.drift.length) parts.push(`… and ${d.driftTotal - d.drift.length} more`);
  }
  if (d.fixes.length) parts.push(...(parts.length ? [''] : []), '**Verified fixes** (`staleproof fix` applies them)', ...d.fixes.map((f) => `• ${link(where(f, multi), f.url)} ${f.description}`));
  const fields = [
    { name: 'Score', value: `${d.score}/100 (${d.grade})`, inline: true },
    ...(d.previous ? [{ name: 'Change', value: d.delta! > 0 ? `up ${d.delta}` : d.delta! < 0 ? `down ${-d.delta!}` : 'unchanged', inline: true }] : []),
    ...(d.previous ? [{ name: 'New', value: String(d.driftTotal), inline: true }] : []),
    ...(d.fixed !== undefined ? [{ name: 'Fixed', value: String(d.fixed), inline: true }] : []),
  ];
  const embed: Record<string, unknown> = {
    title: `Staleproof docs digest: ${scopeLabel(d)}`.slice(0, 256),
    ...(d.link ? { url: d.link } : {}),
    color: parseInt(scoreColor(d.score).slice(1), 16),
    ...(parts.length ? { description: fit(parts, 4096) } : {}),
    fields,
    footer: { text: `Staleproof · ${d.commits.join(', ')}`.slice(0, 2048) },
    timestamp: new Date(d.generatedAt).toISOString(),
  };
  // No pings: the digest never mentions anyone in a channel.
  return { content: digestSummary(d).slice(0, 2000), embeds: [embed], allowed_mentions: { parse: [] } };
}

/** Any other webhook: the digest as JSON, with a `text` line for services that show one. */
export function jsonPayload(d: Digest): Record<string, unknown> {
  return {
    version: 1,
    type: 'staleproof.digest',
    text: digestSummary(d),
    scope: d.scope,
    commits: d.commits,
    score: d.score,
    grade: d.grade,
    previous: d.previous ? { ...d.previous, at: new Date(d.previous.at).toISOString() } : null,
    delta: d.delta ?? null,
    new: d.drift,
    newTotal: d.driftTotal,
    fixed: d.fixed ?? null,
    open: d.open,
    fixes: d.fixes,
    fixesTotal: d.fixesTotal,
    link: d.link ?? null,
    generatedAt: new Date(d.generatedAt).toISOString(),
  };
}

export type WebhookKind = 'slack' | 'discord' | 'json';

/** Slack incoming webhooks and Discord webhooks by host; anything else gets JSON. */
export function webhookKind(url: string): WebhookKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('the digest webhook is not a URL');
  }
  const host = u.hostname.toLowerCase();
  if ((host === 'hooks.slack.com' || host === 'hooks.slack-gov.com') && u.pathname.startsWith('/services/')) return 'slack';
  if (/^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/.test(host) && u.pathname.startsWith('/api/webhooks/')) return 'discord';
  return 'json';
}

export function payloadFor(kind: WebhookKind, d: Digest): unknown {
  return kind === 'slack' ? slackPayload(d) : kind === 'discord' ? discordPayload(d) : jsonPayload(d);
}

/** POST the payload; one retry on 429 or 5xx. Errors name the host only (the URL is a secret). */
export async function postDigest(url: string, payload: unknown, opts: { fetchImpl?: typeof fetch; retryMs?: number } = {}): Promise<{ status: number }> {
  const f = opts.fetchImpl ?? fetch;
  const host = new URL(url).host;
  const send = () =>
    f(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'staleproof' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
  let res: Response;
  try {
    res = await send();
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(5000, Number(res.headers.get('retry-after') ?? 1) * 1000 || 1000);
      await new Promise((r) => setTimeout(r, opts.retryMs ?? wait));
      res = await send();
    }
  } catch (err) {
    throw new Error(`could not post the digest to ${host}: ${(err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message.replace(url, host)}`);
  }
  if (!res.ok) throw new Error(`${host} refused the digest: HTTP ${res.status}`);
  return { status: res.status };
}

/** The hidden line that carries the state in an issue body. Cannot end the HTML comment early. */
export function stateComment(s: DigestState): string {
  return `<!-- ${STATE_MARKER} ${JSON.stringify(s).replace(/-/g, '\\u002d').replace(/>/g, '\\u003e')} -->`;
}

/** The last digest state in a text (an issue body), or undefined. */
export function readState(text: string): DigestState | undefined {
  const all = [...text.matchAll(new RegExp(`<!-- ${STATE_MARKER} (\\{.*?\\}) -->`, 'g'))];
  const last = all.at(-1);
  if (!last) {
    // A bare JSON state file works too.
    try {
      const s = JSON.parse(text) as DigestState;
      return s?.v === 1 && Array.isArray(s.findings) ? s : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const s = JSON.parse(last[1]!) as DigestState;
    return s.v === 1 && Array.isArray(s.findings) && Array.isArray(s.examples) ? s : undefined;
  } catch {
    return undefined;
  }
}

/** The state kept in a persistent graph, by scope. */
export async function loadGraphState(graph: OrgGraph, scope: string): Promise<DigestState | undefined> {
  const row = (await graph.run<{ state: string }>(`MATCH (d:DigestState {scope: $scope}) RETURN d.state AS state`, { scope })).rows[0];
  return row ? readState(row.state) : undefined;
}

export async function saveGraphState(graph: OrgGraph, s: DigestState): Promise<void> {
  await graph.run(`MERGE (d:DigestState {scope: $scope}) SET d.state = $state, d.at = $at`, { scope: s.scope, state: JSON.stringify(s), at: s.at });
}

export type DigestFormat = 'text' | 'markdown' | 'json' | 'slack' | 'discord';
export const DIGEST_FORMATS: DigestFormat[] = ['text', 'markdown', 'json', 'slack', 'discord'];

export interface DigestCommandOptions {
  graph: OrgGraph;
  config: Config;
  /** Repositories to digest (default: every repository in the graph), indexed already (`staleproof audit` first). */
  repos?: string[];
  /** Where to post (the CLI also reads STALEPROOF_DIGEST_WEBHOOK). Never printed. */
  webhook?: string;
  /** Force the payload shape instead of choosing by host (a relay in front of Slack, say). */
  as?: 'auto' | WebhookKind;
  /** What to print (default text; the payload formats print what would be posted). */
  format?: DigestFormat;
  /** A file holding the previous state: the audit issue's body, or a state file. */
  previous?: string;
  /** Append the new state line to this file (the audit report the issue is written from). */
  stateOut?: string;
  /** Read and write the state in the graph (a persistent FalkorDB). */
  graphState?: boolean;
  /** The full report to link to. */
  link?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  log?: (message: string) => void;
}

export interface DigestCommandResult {
  output: string;
  exitCode: number;
  digest: Digest;
  state: DigestState;
  posted?: { kind: WebhookKind; status: number };
}

/** `staleproof digest`: audit the graph's repositories (no runs), compare with the previous digest, post it. */
export async function runDigestCommand(opts: DigestCommandOptions): Promise<DigestCommandResult> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now();
  const format = opts.format ?? 'text';
  if (!DIGEST_FORMATS.includes(format)) throw new Error(`unknown --format ${format} (${DIGEST_FORMATS.join(', ')})`);
  if (opts.as && !['auto', 'slack', 'discord', 'json'].includes(opts.as)) throw new Error(`unknown --as ${opts.as} (auto, slack, discord or json)`);
  const audit = (await auditDocs({ graph: opts.graph, config: opts.config }, { repos: opts.repos?.length ? opts.repos : undefined })).data;
  if (!audit.repos.length) throw new Error(`the "${opts.graph.name}" graph has no repositories: run staleproof audit <owner/name> first`);
  const scope = scopeOf(audit);
  let prev: DigestState | undefined;
  if (opts.previous) {
    const text = await readFile(opts.previous, 'utf8').catch(() => '');
    prev = readState(text);
    log(prev ? `comparing with the digest of ${day(prev.at)} (${prev.score}/100)` : `no earlier digest in ${opts.previous}: this is the first`);
  }
  if (!prev && opts.graphState) prev = await loadGraphState(opts.graph, scope);
  const digest = buildDigest(audit, prev, { now, link: opts.link });
  const state = digestState(audit, now);
  let posted: DigestCommandResult['posted'];
  if (opts.webhook) {
    const kind = opts.as && opts.as !== 'auto' ? opts.as : webhookKind(opts.webhook);
    const r = await postDigest(opts.webhook, payloadFor(kind, digest), { fetchImpl: opts.fetchImpl });
    posted = { kind, status: r.status };
    log(`posted the digest to ${new URL(opts.webhook).host} as ${kind === 'json' ? 'JSON' : kind} (HTTP ${r.status})`);
  }
  if (opts.stateOut) {
    await appendFile(opts.stateOut, `\n${stateComment(state)}\n`);
    log(`kept the digest state in ${opts.stateOut}`);
  }
  if (opts.graphState) await saveGraphState(opts.graph, state);
  const output =
    format === 'markdown'
      ? digestMarkdown(digest)
      : format === 'json'
        ? JSON.stringify(jsonPayload(digest), null, 2)
        : format === 'slack' || format === 'discord'
          ? JSON.stringify(payloadFor(format, digest), null, 2)
          : digestText(digest);
  return { output, exitCode: 0, digest, state, posted };
}
