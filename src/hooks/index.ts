import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseRepo } from '../indexer/index.js';
import { workingFiles } from '../lint/engine.js';
import { ParseCache } from '../lint/cache.js';
import { lintTargets } from '../lint/files.js';
import { addFixes } from '../lint/fixes.js';
import { gitRoot, refTree, worktreeTree } from '../lint/sources.js';
import type { Finding } from '../lint/types.js';
import { lintAgainstHead, pruneRecords, type DiffLint } from './diff-lint.js';
import { predictedFromLocalGraph } from './graph.js';
import { parseHookInput, type HookDialect, type HookInput } from './input.js';
import { signatureMentions, type Mention } from './mentions.js';
import { itemList, type PredictedBreak } from './report.js';

export { parseHookInput, type HookInput, type HookDialect } from './input.js';
export { lintAgainstHead, type DiffLint } from './diff-lint.js';

export type HookEvent = 'session-start' | 'post-edit' | 'stop';
export const HOOK_EVENTS: HookEvent[] = ['session-start', 'post-edit', 'stop'];

export type StopMode = 'block' | 'warn' | 'off';

export interface HookOptions {
  env?: NodeJS.ProcessEnv;
  /** Force a dialect (`staleproof hook <event> --cursor`); otherwise read from the input. */
  dialect?: HookDialect;
  /** Give up (silently) after this long. */
  timeoutMs?: number;
  /** Look for predicted breaks in a local graph (stop). Default true. */
  graph?: boolean;
}

/** What the hook prints (JSON for the agent, or nothing). The exit status is always 0. */
export interface HookResult {
  stdout: string;
}

/** Per-session record: what the last hook saw, so each edit reports only what it changed. */
interface SessionState {
  /** Fingerprints of the new-since-HEAD findings at session start. */
  start?: string[];
  /** Fingerprints of the new-since-HEAD findings after the last edit. */
  seen?: string[];
  /** Findings already reported about an edited file (each is said once; the stop hook repeats what is left). */
  reported?: string[];
  /** Mentions already reported (path:line:symbol:signature). */
  mentioned?: string[];
  /** The session edited files: after a session-start record, only then may the stop hook block. */
  edited?: boolean;
  /** Repository paths the session edited. */
  files?: string[];
}

const DEFAULT_TIMEOUT: Record<HookEvent, number> = { 'session-start': 120_000, 'post-edit': 10_000, stop: 50_000 };
const KEEP_SESSIONS = 30;

/** `STALEPROOF_HOOK` (or its former name `LOCKSTEP_HOOK`), read without loading the CLI's config module. */
function hookSetting(env: NodeJS.ProcessEnv): string | undefined {
  return (env.STALEPROOF_HOOK || env.LOCKSTEP_HOOK || undefined)?.trim().toLowerCase();
}

/** `STALEPROOF_HOOK=off|warn|block` wins over `[hooks] stop` in the repository config; default block. */
export function stopMode(env: NodeJS.ProcessEnv, configured?: StopMode): StopMode {
  const v = hookSetting(env);
  if (v === 'off' || v === 'warn' || v === 'block') return v;
  return configured ?? 'block';
}

function sessionKey(input: HookInput): string {
  return `hook-session-${(input.sessionId ?? 'default').replace(/[^\w.-]/g, '_').slice(0, 80)}`;
}

async function readSession(cache: ParseCache, input: HookInput): Promise<SessionState> {
  return (await cache.readJson<SessionState>(sessionKey(input), { shared: true })) ?? {};
}

/**
 * Merge into the session record as it is now: hooks of one session can overlap (the
 * session-start hook runs in the background while the first edits come in).
 */
async function updateSession(cache: ParseCache, input: HookInput, change: (now: SessionState) => SessionState): Promise<void> {
  await cache.writeJson(sessionKey(input), change(await readSession(cache, input)), { shared: true });
  await pruneRecords(cache, 'hook-session-', KEEP_SESSIONS);
}

const union = (a: string[] | undefined, b: string[], max: number) => [...new Set([...(a ?? []), ...b])].slice(-max);

/** What the edited files are to the code checks: their module names (`demo.client`) and every definition name's count. */
interface CodeView {
  modules: Map<string, string>;
  names: Map<string, number>;
}

async function codeView(d: DiffLint): Promise<CodeView> {
  // The lint's own parse; else a warm one (every file from the cache the lint just filled).
  const parsed = d.parsed ?? (await parseRepo({ repo: d.head.repo ?? 'repo', dir: d.root, sha: 'worktree' }, { memo: d.cache }));
  const modules = new Map<string, string>();
  const names = new Map<string, number>();
  for (const m of parsed.modules) {
    if (m.path) modules.set(m.path, m.module);
    for (const def of m.defs) names.set(def.name, (names.get(def.name) ?? 0) + 1);
  }
  return { modules, names };
}

/** Whether a finding is in one of `paths`, names one of them, or (an example check) calls code defined in one. */
function about(f: Finding, paths: string[], code: CodeView): boolean {
  return paths.some((p) => {
    if (f.path === p || f.subject === p || f.subject.startsWith(`${p}:`) || f.subject.startsWith(`${p}#`)) return true;
    const mod = code.modules.get(p);
    return !!mod && f.rule.startsWith('example-') && (f.subject === mod || f.subject.startsWith(`${mod}.`));
  });
}

async function docsOf(root: string, d: DiffLint): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const t of lintTargets(await workingFiles(root), d.config)) {
    const text = await readFile(join(root, t.path), 'utf8').catch(() => undefined);
    if (text !== undefined) out.push({ path: t.path, text });
  }
  return out;
}

/** Mentions of symbols whose signature the edited code files changed, minus lines a finding already covers. */
async function mentionsFor(d: DiffLint, rels: string[], code: CodeView): Promise<Mention[]> {
  const edited = rels.filter((r) => !/\.(md|mdx|rst|mdc|txt)$/i.test(r));
  if (!edited.length) return [];
  const docs = await docsOf(d.root, d);
  if (!docs.length) return [];
  const covered = new Set(d.head.findings.map((f) => `${f.path}:${f.line}`));
  const out: Mention[] = [];
  for (const rel of edited) {
    for (const m of await signatureMentions(d.root, rel, docs, d.cache, (n) => code.names.get(n) ?? 0, code.modules.get(rel))) if (!covered.has(`${m.path}:${m.line}`)) out.push(m);
  }
  await d.cache.save();
  return out;
}

/** `path` relative to the checkout, through symlinks (`/var` is `/private/var` on macOS); undefined outside it. */
async function repoRelative(root: string, path: string): Promise<string | undefined> {
  const real = async (p: string): Promise<string> => {
    try {
      return await realpath(p);
    } catch {
      // A deleted file: its folder still resolves.
      return join(await real(dirname(p)).catch(() => dirname(p)), basename(p));
    }
  };
  const rel = relative(await real(root), await real(path)).split('\\').join('/');
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : undefined;
}

/**
 * `findings` with the verified fixes Staleproof can find before `deadline` (renames against HEAD when `renames`);
 * the findings as they were on any error. Nothing leaves the machine: the fixes are checked in a local mirror.
 */
async function withFixes(d: DiffLint, findings: Finding[], deadline: number, renames: boolean): Promise<Finding[]> {
  if (!findings.length || Date.now() > deadline) return findings;
  const base = renames && d.sha ? await refTree(d.root, d.sha).catch(() => undefined) : undefined;
  try {
    const r = await addFixes({ ...d.head, findings }, worktreeTree(d.root, d.head.repo), { ...(base ? { baseTree: base } : {}), cache: d.cache, lint: { config: d.config }, deadline });
    return r.findings;
  } catch {
    return findings;
  } finally {
    await base?.dispose();
  }
}

function contextOutput(dialect: HookDialect, text: string): string {
  return JSON.stringify(dialect === 'cursor' ? { additional_context: text } : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
}

/**
 * `SessionStart`: lint once so the parse cache and HEAD's baseline are warm before the
 * first edit, and remember what was already new since HEAD (not the agent's doing).
 */
async function sessionStart(input: HookInput): Promise<string> {
  const d = await lintAgainstHead(input.cwd);
  if (!d) return '';
  const fresh = d.fresh.map((f) => f.fingerprint);
  // A resumed session keeps what it already knew. An edit that came in while this ran may be in `fresh`: then
  // nothing counts as "already there" (the stop hook may ask about more, never about less).
  await updateSession(d.cache, input, (now) => ({ ...now, start: now.start ?? (now.edited ? [] : fresh), seen: now.seen ?? fresh }));
  return '';
}

/**
 * After an edit: the docs the edit made wrong. New-since-HEAD findings in or about the
 * edited files, or that appeared since the last hook, plus docs naming a symbol whose
 * signature the edit changed. Nothing to say: no output.
 */
async function postEdit(input: HookInput, env: NodeJS.ProcessEnv): Promise<string> {
  if (hookSetting(env) === 'off' || !input.files.length) return '';
  const root = await gitRoot(input.cwd);
  if (!root) return '';
  const rels = (await Promise.all(input.files.map((f) => repoRelative(root, resolve(input.cwd, f))))).filter((r): r is string => !!r && !r.startsWith('.staleproof/'));
  if (!rels.length) return '';
  const cache = await ParseCache.open(root);
  const state = await readSession(cache, input);
  // Recorded first, so a slow lint that times out still lets the stop hook know the session edited files.
  if (!state.edited) await updateSession(cache, input, (now) => ({ ...now, edited: true }));
  const d = await lintAgainstHead(root, { cache });
  if (!d) return '';
  const code = await codeView(d);
  const seen = state.seen ? new Set(state.seen) : undefined;
  const reported = new Set(state.reported ?? []);
  // In an edited file: always (the agent is looking at it). About an edited file, or new since the last hook: once.
  const items = d.fresh.filter((f) => rels.includes(f.path) || (!reported.has(f.fingerprint) && (about(f, rels, code) || (seen !== undefined && !seen.has(f.fingerprint)))));
  const mentioned = new Set(state.mentioned ?? []);
  const mentions = (await mentionsFor(d, rels, code)).filter((m) => !mentioned.has(`${m.path}:${m.line}:${m.symbol}:${m.after ?? ''}`));
  await updateSession(d.cache, input, (now) => ({
    ...now,
    seen: d.fresh.map((f) => f.fingerprint),
    reported: union(now.reported, [...reported, ...items.map((f) => f.fingerprint)], 1000),
    files: union(now.files, rels, 200),
    mentioned: union(now.mentioned, [...mentioned, ...mentions.map((m) => `${m.path}:${m.line}:${m.symbol}:${m.after ?? ''}`)], 500),
    edited: true,
  }));
  if (!items.length && !mentions.length) return '';
  const fixed = await withFixes(d, items, Date.now() + 1200, false);
  const text = [
    `Staleproof: this edit leaves docs out of date (checked against HEAD, nothing left the machine):`,
    itemList(fixed, mentions),
    fixed.some((f) => f.fix?.verified) ? 'Apply the fixes listed (or run `npx staleproof fix`), or say why they stay.' : 'Update them in the same change, or say why they stay.',
  ].join('\n');
  return contextOutput(input.dialect, text);
}

/**
 * Before the agent stops: every new-since-HEAD error finding the session introduced, plus
 * examples a running local graph predicts break. `block` asks the agent to fix the docs
 * (once: never when it is already continuing for a stop hook), `warn` tells the user only.
 */
async function stop(input: HookInput, env: NodeJS.ProcessEnv, opts: HookOptions): Promise<string> {
  if (stopMode(env) === 'off') return '';
  const d = await lintAgainstHead(input.cwd);
  if (!d) return '';
  const mode = stopMode(env, d.config.hooks?.stop);
  if (mode === 'off') return '';
  const state = await readSession(d.cache, input);
  // Only a session that edited files is asked about drift; what was new at its start is not its doing.
  if (state.start !== undefined && !state.edited) return '';
  const before = new Set(state.start ?? []);
  const errors = d.fresh.filter((f) => f.severity === 'error' && !before.has(f.fingerprint));
  const predicted: PredictedBreak[] = opts.graph === false ? [] : await predictedFromLocalGraph(d.root);
  const examplesFound = new Set(errors.map((f) => `${f.path}:${f.line}`));
  const extra = predicted.filter((p) => !examplesFound.has(`${p.example}:${p.line}`));
  // Docs naming a symbol whose signature the session changed: listed with the errors, never a reason to block alone.
  const mentions = state.files?.length ? await mentionsFor(d, state.files, await codeView(d)) : [];
  if (!errors.length && !extra.length && !mentions.length) return '';
  const list = itemList(await withFixes(d, errors, Date.now() + 20_000, true), mentions, extra);
  const count = errors.length + extra.length;
  const summary = count
    ? `Staleproof: ${count} doc reference${count === 1 ? '' : 's'} this session made wrong (new since HEAD):`
    : 'Staleproof: docs that name code this session changed (check they still hold):';
  if (mode === 'warn' || input.stopHookActive || !count) {
    return input.dialect === 'cursor' ? '' : JSON.stringify({ systemMessage: `${summary}\n${list}` });
  }
  const reason = `${summary}\n${list}\nUpdate the docs and agent files above in this change (apply the fixes listed), or explain why they stay as they are.`;
  return JSON.stringify(input.dialect === 'cursor' ? { followup_message: reason } : { decision: 'block', reason });
}

/** The hook JSON on stdin; empty from a terminal, and never waits more than `ms` for the agent to close it. */
export function readStdin(stream: NodeJS.ReadStream, ms = 3000): Promise<string> {
  if (stream.isTTY) return Promise.resolve('');
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    const finish = () => {
      clearTimeout(timer);
      done(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.once('end', finish);
    stream.once('error', finish);
  });
}

/**
 * Run one hook on the JSON the agent sent. Never throws and never fails the agent: on an
 * error or after `timeoutMs` it returns no output.
 */
export async function runHook(event: HookEvent, stdin: string, opts: HookOptions = {}): Promise<HookResult> {
  const env = opts.env ?? process.env;
  const input = parseHookInput(stdin, env, opts.dialect);
  const work = (async () => {
    if (event === 'session-start') return sessionStart(input);
    if (event === 'post-edit') return postEdit(input, env);
    return stop(input, env, opts);
  })().catch(() => '');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((done) => {
    timer = setTimeout(() => done(''), opts.timeoutMs ?? DEFAULT_TIMEOUT[event]);
    timer.unref?.();
  });
  const stdout = await Promise.race([work, timeout]);
  clearTimeout(timer);
  return { stdout };
}
