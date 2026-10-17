import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newFindings } from '../lint/diff.js';
import type { LintOptions } from '../lint/engine.js';
import { addFixes, applyTextEdits } from '../lint/fixes.js';
import { commitTree, lintTree } from '../lint/sources.js';
import type { Finding, TextEdit } from '../lint/types.js';
import { fetchPullRequest, githubJson, parsePrUrl, type GitHubOptions } from './github.js';

/**
 * Verified fixes as GitHub review suggestions. The planner is pure: findings, the PR's
 * right-hand lines and the head contents in, review comments out. The poster shares one
 * GitHub client shape between the Action (GITHUB_TOKEN) and the App (installation token):
 * one review per push, comments on current lines updated in place, never duplicated.
 */

/** Hidden in every suggestion body: which findings it fixes, so a later push updates instead of repeating it. */
export const SUGGESTION_MARKER = 'staleproof:suggestion';

/** GitHub rejects very large reviews; the rest are listed for `npx staleproof fix`. */
export const MAX_SUGGESTIONS = 50;

export interface SuggestionComment {
  path: string;
  /** The last line the suggestion replaces (right-hand side of the diff). */
  line: number;
  /** The first line, when the suggestion replaces several. */
  start_line?: number;
  side: 'RIGHT';
  start_side?: 'RIGHT';
  body: string;
  /** The findings this comment fixes (also in the hidden marker). */
  fingerprints: string[];
}

export interface SuggestionPlan {
  comments: SuggestionComment[];
  /** Findings with a verified fix that cannot be suggested here: outside the diff, or editing several files. */
  outside: Finding[];
}

/** Head contents by repository-relative path: a map or a reader. */
export type FileContents = ReadonlyMap<string, string> | ((path: string) => string | undefined);

export interface PlanInput {
  /** Findings at the PR head; only those with a verified fix are planned. */
  findings: readonly Finding[];
  /** Right-hand line numbers of the PR diff (added and context lines) per path. */
  changed: ReadonlyMap<string, ReadonlySet<number>>;
  /** The files at the PR head (at least those the fixes edit). */
  files: FileContents;
  /** Default `MAX_SUGGESTIONS`. */
  max?: number;
}

const read = (files: FileContents, path: string): string | undefined => (typeof files === 'function' ? files(path) : files.get(path));

/** The longest run of backticks in `text`, so a fence around it can be longer. */
function longestBackticks(text: string): number {
  let best = 0;
  for (const m of text.matchAll(/`+/g)) best = Math.max(best, m[0].length);
  return best;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

function editsOf(f: Finding): TextEdit[] {
  return f.fix?.edits ?? [];
}

function span(edits: readonly TextEdit[]): { first: number; last: number } {
  return { first: Math.min(...edits.map((e) => e.line)), last: Math.max(...edits.map((e) => e.endLine)) };
}

/** The suggestion comment body: the replacement lines in a ```suggestion block, with the hidden marker. */
export function suggestionBody(group: readonly Finding[], replacement: string): string {
  const fence = '`'.repeat(Math.max(3, longestBackticks(replacement) + 1));
  const fps = group.map((f) => f.fingerprint);
  const why = group.map((f) => `**Staleproof** \`${f.rule}\`: ${f.message}${f.fix ? ` ${f.fix.description}.`.replace(/\.\.$/, '.') : ''}`);
  return [`<!-- ${SUGGESTION_MARKER} fp=${fps.join(',')} -->`, ...why, '', `${fence}suggestion`, replacement, fence].join('\n');
}

/**
 * Plan the review: each verified single-file fix whose lines all sit on the PR diff's right
 * side becomes a ```suggestion comment (fixes touching the same lines share one); every
 * other verified fix is returned in `outside`.
 */
export function planSuggestions(input: PlanInput): SuggestionPlan {
  const max = input.max ?? MAX_SUGGESTIONS;
  const outside: Finding[] = [];
  const byPath = new Map<string, Finding[]>();
  for (const f of input.findings) {
    if (!f.fix?.verified || !f.fix.edits.length) continue;
    const paths = new Set(f.fix.edits.map((e) => e.path));
    if (paths.size !== 1) {
      outside.push(f);
      continue;
    }
    const path = [...paths][0]!;
    byPath.set(path, [...(byPath.get(path) ?? []), f]);
  }

  const comments: SuggestionComment[] = [];
  for (const [path, list] of byPath) {
    // Fixes whose line ranges touch are merged: GitHub applies one suggestion per range.
    const sorted = [...list].sort((a, b) => span(editsOf(a)).first - span(editsOf(b)).first);
    const groups: { first: number; last: number; findings: Finding[] }[] = [];
    for (const f of sorted) {
      const s = span(editsOf(f));
      const g = groups[groups.length - 1];
      if (g && s.first <= g.last) {
        g.last = Math.max(g.last, s.last);
        g.findings.push(f);
      } else groups.push({ ...s, findings: [f] });
    }
    const content = read(input.files, path);
    const lines = input.changed.get(path);
    for (const g of groups) {
      let inside = !!lines && content !== undefined;
      for (let n = g.first; inside && n <= g.last; n++) if (!lines!.has(n)) inside = false;
      let replacement: string | undefined;
      if (inside) {
        const all = splitLines(content!);
        const segment = all.slice(g.first - 1, g.last).join('\n');
        const shifted = g.findings.flatMap((f) => editsOf(f).map((e) => ({ ...e, line: e.line - g.first + 1, endLine: e.endLine - g.first + 1 })));
        try {
          replacement = applyTextEdits(segment, shifted);
        } catch {
          replacement = undefined;
        }
      }
      if (replacement === undefined || comments.length >= max) {
        outside.push(...g.findings);
        continue;
      }
      comments.push({
        path,
        line: g.last,
        ...(g.last > g.first ? { start_line: g.first, start_side: 'RIGHT' as const } : {}),
        side: 'RIGHT',
        body: suggestionBody(g.findings, replacement),
        fingerprints: g.findings.map((f) => f.fingerprint),
      });
    }
  }
  return { comments, outside };
}

/** The right-hand line numbers (added and context lines) of one file's unified diff (`files[].patch`). */
export function rightHandLines(patch: string): Set<number> {
  const out = new Set<number>();
  let line = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (h) {
      line = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const c = raw[0];
    if (c === '+' || c === ' ') out.add(line++);
    else if (c === '\\' || c === '-') continue;
    else if (raw === '') continue;
    else inHunk = false;
  }
  return out;
}

/** Fixes outside the diff, for the PR comment: one bullet each and the command that applies them. */
export function outsideFixesMarkdown(outside: readonly Finding[], opts: { command?: string } = {}): string {
  if (!outside.length) return '';
  const command = opts.command ?? 'npx staleproof fix';
  const items = outside.map((f) => `- \`${f.path}:${f.line}\` ${f.fix?.description ?? f.message}`);
  return [`${outside.length === 1 ? 'One verified fix is' : `${outside.length} verified fixes are`} outside this diff. Run \`${command}\` to apply ${outside.length === 1 ? 'it' : 'them'}:`, '', ...items].join('\n');
}

// ---------------------------------------------------------------------------
// Posting

/** A GitHub client: the Action's GITHUB_TOKEN or the App's installation token, and an injectable fetch. */
export interface SuggestionClient extends GitHubOptions {
  token: string;
  /** Only comments by this login count as earlier Staleproof comments (default: any comment carrying the marker). */
  author?: string;
}

export interface PullTarget {
  owner: string;
  repo: string;
  number: number;
  /** The head commit the review is about. */
  headSha: string;
}

export interface PostResult {
  /** The review holding the new comments, when there were any. */
  review?: { id: number; url?: string };
  created: number;
  /** Earlier comments on the same lines whose body changed. */
  updated: number;
  /** Earlier comments already saying the same thing. */
  unchanged: number;
  /** Earlier comments on current lines at a different range, marked superseded. */
  superseded: number;
  /** Comments GitHub refused (a line no longer in the diff). */
  skipped: number;
}

interface GhReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  start_line: number | null;
  user: { login: string } | null;
}

const MARKER_RE = new RegExp(`<!--\\s*${SUGGESTION_MARKER}\\s+fp=([0-9a-f,]+)(\\s+superseded)?\\s*-->`);

/** The fingerprints a comment body's marker names, or undefined for other comments (and superseded ones). */
export function markerFingerprints(body: string): string[] | undefined {
  const m = MARKER_RE.exec(body);
  if (!m || m[2]) return undefined;
  return m[1]!.split(',').filter(Boolean);
}

async function listPages<T>(path: string, client: SuggestionClient): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await githubJson<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, client);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** The right-hand lines of every file a pull request changes (`GET /pulls/{n}/files`). */
export async function fetchChangedLines(pr: Omit<PullTarget, 'headSha'>, client: SuggestionClient): Promise<Map<string, Set<number>>> {
  const files = await listPages<{ filename: string; patch?: string; status: string }>(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files`, client);
  const out = new Map<string, Set<number>>();
  for (const f of files) if (f.patch && f.status !== 'removed') out.set(f.filename, rightHandLines(f.patch));
  return out;
}

/**
 * Post the plan as one review on the head commit. An earlier Staleproof comment for the same
 * findings on the same current lines is updated in place (or left when it already says the
 * same); one on current lines at another range is marked superseded; outdated ones are left.
 */
export async function postSuggestions(plan: SuggestionPlan, pr: PullTarget, client: SuggestionClient): Promise<PostResult> {
  const result: PostResult = { created: 0, updated: 0, unchanged: 0, superseded: 0, skipped: 0 };
  const base = `/repos/${pr.owner}/${pr.repo}/pulls`;
  const send = <T>(path: string, method: string, body: unknown) => githubJson<T>(path, client, { method, body: JSON.stringify(body) });
  const existing = (await listPages<GhReviewComment>(`${base}/${pr.number}/comments`, client))
    .filter((c) => !client.author || c.user?.login === client.author)
    .map((c) => ({ c, fps: markerFingerprints(c.body ?? '') }))
    .filter((x): x is { c: GhReviewComment; fps: string[] } => !!x.fps && x.c.line !== null);

  const fresh: SuggestionComment[] = [];
  const claimed = new Set<number>();
  for (const comment of plan.comments) {
    const mine = existing.filter((x) => !claimed.has(x.c.id) && x.c.path === comment.path && x.fps.some((fp) => comment.fingerprints.includes(fp)));
    const same = mine.find((x) => x.c.line === comment.line && (x.c.start_line ?? undefined) === comment.start_line);
    for (const x of mine) claimed.add(x.c.id);
    for (const x of mine) {
      if (x === same) continue;
      // Same findings, current lines, another range: the old suggestion would now replace the wrong text.
      const note = `<!-- ${SUGGESTION_MARKER} fp=${x.fps.join(',')} superseded -->\nSuperseded by a newer Staleproof suggestion on this pull request.`;
      try {
        await send(`${base}/comments/${x.c.id}`, 'PATCH', { body: note });
        result.superseded++;
      } catch {
        // Not ours to edit (another account copied the marker): leave it.
      }
    }
    if (same) {
      if (same.c.body === comment.body) {
        result.unchanged++;
        continue;
      }
      try {
        await send(`${base}/comments/${same.c.id}`, 'PATCH', { body: comment.body });
        result.updated++;
        continue;
      } catch {
        // Fall through: post it as a new comment.
      }
    }
    fresh.push(comment);
  }
  if (!fresh.length) return result;

  const wire = (c: SuggestionComment) => ({
    path: c.path,
    line: c.line,
    side: c.side,
    ...(c.start_line !== undefined ? { start_line: c.start_line, start_side: c.start_side ?? 'RIGHT' } : {}),
    body: c.body,
  });
  const summary = `Staleproof found ${fresh.length === 1 ? 'a stale docs reference' : `${fresh.length} stale docs references`} this pull request can fix in place. Each suggestion was re-checked: applying it clears the finding and adds none.`;
  try {
    const review = await send<{ id: number; html_url?: string }>(`${base}/${pr.number}/reviews`, 'POST', {
      commit_id: pr.headSha,
      event: 'COMMENT',
      body: summary,
      comments: fresh.map(wire),
    });
    result.review = { id: review.id, ...(review.html_url ? { url: review.html_url } : {}) };
    result.created += fresh.length;
  } catch (err) {
    if (!/\b422\b/.test((err as Error).message)) throw err;
    // A line left the diff since the plan was made: post the rest one by one.
    for (const c of fresh) {
      try {
        await send(`${base}/${pr.number}/comments`, 'POST', { ...wire(c), commit_id: pr.headSha });
        result.created++;
      } catch {
        result.skipped++;
      }
    }
  }
  return result;
}

/**
 * Plan and post in one call: fetch the PR's right-hand lines, plan, post. What the Action's
 * check mode and the App's pull request handler run; returns the plan too (its `outside`
 * list goes in the PR comment).
 */
export async function suggestFixes(
  input: { findings: readonly Finding[]; files: FileContents; pr: PullTarget; max?: number },
  client: SuggestionClient,
): Promise<{ plan: SuggestionPlan; posted: PostResult }> {
  const changed = await fetchChangedLines(input.pr, client);
  const plan = planSuggestions({ findings: input.findings, changed, files: input.files, ...(input.max ? { max: input.max } : {}) });
  const posted = await postSuggestions(plan, input.pr, client);
  return { plan, posted };
}

// ---------------------------------------------------------------------------
// The Action's check mode: `staleproof suggest <pr-url>`

export interface SuggestCommandOptions {
  /** `https://github.com/owner/name/pull/N` or `owner/name#N`. */
  pr: string;
  /** GITHUB_TOKEN (the Action) or an installation token (the App). */
  token: string;
  /** Where clones and downloads live (`config.home`). */
  home: string;
  /** A local clone that has both commits (default: `<home>/repos/<owner>/<name>` when it exists). */
  clone?: string;
  fetchImpl?: typeof fetch;
  /** Only comments by this login count as earlier Staleproof comments. */
  author?: string;
  lint?: Omit<LintOptions, 'dir' | 'paths' | 'rules' | 'files' | 'repo' | 'sha'>;
  /** Plan only: post nothing. */
  dryRun?: boolean;
  max?: number;
}

export interface SuggestCommandResult {
  /** New findings at the head, with their fixes. */
  findings: Finding[];
  plan: SuggestionPlan;
  posted?: PostResult;
  /** For the PR comment: the verified fixes outside the diff (empty when none). */
  markdown: string;
  /** Why nothing was posted, when posting failed (a fork's read-only token). */
  warning?: string;
}

/**
 * Suggest the verified fixes for what a pull request makes stale: lint base and head
 * (a local clone, else the archives), keep the new findings, fix them with renames
 * detected between base and head, and post the suggestions on the head commit.
 */
export async function runSuggestCommand(opts: SuggestCommandOptions): Promise<SuggestCommandResult> {
  const ref = parsePrUrl(opts.pr);
  const pr = await fetchPullRequest(ref, { token: opts.token, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const guess = join(opts.home, 'repos', ref.owner, ref.repo);
  const clone = opts.clone ?? (existsSync(join(guess, '.git')) ? guess : undefined);
  const source = { home: opts.home, token: opts.token, ...(clone ? { clone } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) };
  const base = await commitTree(ref.fullName, pr.baseSha, source);
  try {
    const head = await commitTree(ref.fullName, pr.headSha, source);
    try {
      const lint = { ...opts.lint, repo: ref.fullName };
      const [atBase, atHead] = await Promise.all([lintTree(base, lint), lintTree(head, lint)]);
      const fresh = new Set(newFindings(atBase, atHead).map((f) => f.fingerprint));
      const fixed = await addFixes(atHead, head, { baseTree: base, only: (f) => fresh.has(f.fingerprint), ...(opts.lint ? { lint: opts.lint } : {}) });
      const findings = fixed.findings.filter((f) => fresh.has(f.fingerprint));
      const read = (p: string) => {
        try {
          return readFileSync(join(head.dir, ...p.split('/')), 'utf8');
        } catch {
          return undefined;
        }
      };
      const target: PullTarget = { owner: ref.owner, repo: ref.repo, number: ref.number, headSha: pr.headSha };
      const client: SuggestionClient = { token: opts.token, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), ...(opts.author ? { author: opts.author } : {}) };
      const changed = await fetchChangedLines(target, client);
      const plan = planSuggestions({ findings, changed, files: read, ...(opts.max ? { max: opts.max } : {}) });
      const markdown = outsideFixesMarkdown(plan.outside);
      if (opts.dryRun || !plan.comments.length) return { findings, plan, markdown };
      try {
        return { findings, plan, posted: await postSuggestions(plan, target, client), markdown };
      } catch (err) {
        const msg = (err as Error).message;
        if (!/\b(403|404)\b|not found|Resource not accessible/i.test(msg)) throw err;
        return { findings, plan, markdown, warning: `Could not post suggestions (${msg.slice(0, 160)}); pull requests from forks get a read-only token.` };
      }
    } finally {
      await head.dispose();
    }
  } finally {
    await base.dispose();
  }
}
