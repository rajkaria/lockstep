import type { PrFindings } from '../agent/graph-check.js';
import { COMMENT_MARKER } from '../format/markdown.js';
import type { AppConfig } from '../indexer/repo-config.js';
import type { Finding } from '../lint/types.js';

/**
 * The pure part of a check run: what it says (title, conclusion, annotations), whether the
 * pull request gets a comment, and what the comment says when everything is clear again.
 */

export const CHECK_NAME = 'Staleproof';
export const APPLY_FIXES = 'apply-fixes';
/** The Checks API takes at most 50 annotations per request. */
export const ANNOTATIONS_PER_REQUEST = 50;
/** GitHub refuses a check run summary or text over 65535 characters. */
export const MAX_OUTPUT = 65_000;

export type ResolvedAppConfig = Required<AppConfig>;

export const APP_DEFAULTS: ResolvedAppConfig = {
  comment: 'findings',
  failOn: 'never',
  suggestions: true,
  drafts: false,
  fixPrs: false,
  auditIssue: false,
  alsoIndex: [],
};

export function resolveAppConfig(app?: AppConfig): ResolvedAppConfig {
  return { ...APP_DEFAULTS, ...Object.fromEntries(Object.entries(app ?? {}).filter(([, v]) => v !== undefined)) } as ResolvedAppConfig;
}

/** What one check found, as the App reports it. */
export interface CheckOutcome {
  /** The Markdown report (the PR comment format, starting with COMMENT_MARKER). */
  report: string;
  /** Docs references the pull request makes wrong (absent when they could not be checked). */
  newFindings?: PrFindings;
  newFindingsError?: string;
  /** Docs examples predicted to break. */
  predicted: number;
  /** Doc sections the changed code reaches. */
  sections: number;
  /** Impacted sections a model judged stale (agent mode only; graph mode has none). */
  stale: number;
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title: string;
}

const LEVEL = { error: 'failure', warning: 'warning', info: 'notice' } as const;

/** One annotation per new finding, on the doc line it is about. */
export function annotationsOf(findings: readonly Finding[]): Annotation[] {
  return findings.map((f) => {
    const sameLine = f.line === f.endLine && f.endColumn > f.column;
    return {
      path: f.path,
      start_line: f.line,
      end_line: Math.max(f.line, f.endLine),
      // Columns only when the span is on one line (the Checks API rejects them otherwise); the API's end column is inclusive.
      ...(sameLine ? { start_column: f.column, end_column: f.endColumn - 1 } : {}),
      annotation_level: LEVEL[f.severity],
      message: `${f.message}${f.fix?.verified ? ` Fix: ${f.fix.description}` : ''}${f.evidence?.looked ? ` (looked in ${f.evidence.looked})` : ''}`.slice(0, 60_000),
      title: `${f.rule}: ${f.subject}`.slice(0, 255),
    };
  });
}

export function chunks<T>(items: readonly T[], size = ANNOTATIONS_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Whether the pull request needs a comment under `comment = "findings"`. */
export function somethingToSay(o: CheckOutcome): boolean {
  return (o.newFindings?.total ?? 0) > 0 || o.predicted > 0 || o.stale > 0;
}

/** `success` when clean, `neutral` with findings, `failure` when `[app] fail-on` says so. */
export function conclusionOf(o: CheckOutcome, failOn: ResolvedAppConfig['failOn']): 'success' | 'neutral' | 'failure' {
  if (failOn === 'findings' && (o.newFindings?.summary.errors ?? 0) > 0) return 'failure';
  if (failOn === 'predicted' && o.predicted > 0) return 'failure';
  return somethingToSay(o) ? 'neutral' : 'success';
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The check run's one-line title. */
export function checkTitle(o: CheckOutcome): string {
  const parts: string[] = [];
  const wrong = o.newFindings?.total ?? 0;
  if (wrong) parts.push(`${plural(wrong, 'docs reference')} made wrong`);
  if (o.predicted) parts.push(`${plural(o.predicted, 'example')} predicted to break`);
  if (o.stale) parts.push(`${plural(o.stale, 'section')} judged stale`);
  if (parts.length) return parts.join(', ');
  if (o.sections) return `No docs problems found (${plural(o.sections, 'doc section')} reached)`;
  return 'No docs problems found';
}

export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const note = '\n\n_The report was cut to fit a GitHub check run; the pull request comment has all of it._';
  return text.slice(0, max - note.length) + note;
}

/** Marks the App's comment, so the GitHub Action on the same repository keeps its own (it skips comments carrying this). */
export const APP_COMMENT_MARKER = '<!-- staleproof:app -->';

export type CommentPlan = { kind: 'none' } | { kind: 'create'; body: string } | { kind: 'update'; id: number; body: string };

/** The "All clear" comment a later push leaves where the findings were. */
export function allClearBody(headSha: string): string {
  return [
    COMMENT_MARKER,
    '### Staleproof: all clear',
    '',
    `As of \`${headSha.slice(0, 7)}\`, this pull request makes no docs reference wrong and no docs example is predicted to break. What this comment listed before is fixed.`,
    '',
    '<!-- staleproof:all-clear -->',
    APP_COMMENT_MARKER,
  ].join('\n');
}

export function isAllClear(body: string): boolean {
  return body.includes('<!-- staleproof:all-clear -->');
}

/**
 * What to do with the pull request comment: `never` leaves it alone; `always` keeps the
 * report there; `findings` (default) comments only when there is something to say and,
 * when a later push clears everything, edits its comment to "All clear" (never deletes it).
 */
export function planComment(policy: ResolvedAppConfig['comment'], o: CheckOutcome, body: string, headSha: string, existing?: { id: number; body: string }): CommentPlan {
  if (policy === 'never') return { kind: 'none' };
  if (policy === 'always' || somethingToSay(o)) {
    if (existing) return existing.body === body ? { kind: 'none' } : { kind: 'update', id: existing.id, body };
    return { kind: 'create', body };
  }
  if (!existing || isAllClear(existing.body)) return { kind: 'none' };
  return { kind: 'update', id: existing.id, body: allClearBody(headSha) };
}
