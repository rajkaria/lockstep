import type { Finding, TextEdit } from '../lint/types.js';

/**
 * Where a line of one version of a file is in another: lines before the first change keep
 * their number, lines after the last change move by the difference in length, and lines in
 * between have no counterpart (undefined). Enough to carry findings and fixes from the
 * snapshot to an edited buffer, conservatively: anything near an edit is dropped and
 * recomputed, never shown at the wrong place.
 */
export function lineMap(before: string, after: string): (line: number) => number | undefined {
  if (before === after) return (line) => line;
  const a = before.split('\n');
  const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const delta = b.length - a.length;
  return (line) => {
    if (line <= prefix) return line;
    if (line > a.length - suffix && line <= a.length) return line + delta;
    return undefined;
  };
}

/** Findings of the earlier version still on unchanged lines, moved to where those lines are now. */
export function carryFindings(findings: Finding[], before: string, after: string): { kept: Finding[]; dropped: number } {
  if (before === after) return { kept: findings, dropped: 0 };
  const map = lineMap(before, after);
  const kept: Finding[] = [];
  let dropped = 0;
  for (const f of findings) {
    const line = map(f.line);
    const endLine = map(f.endLine);
    if (line === undefined || endLine === undefined) dropped++;
    else kept.push({ ...f, line, endLine });
  }
  return { kept, dropped };
}

function slice(text: string, e: Pick<TextEdit, 'line' | 'column' | 'endLine' | 'endColumn'>): string | undefined {
  const lines = text.split('\n');
  if (e.line < 1 || e.endLine > lines.length) return undefined;
  if (e.line === e.endLine) return lines[e.line - 1]!.slice(e.column - 1, e.endColumn - 1);
  return [lines[e.line - 1]!.slice(e.column - 1), ...lines.slice(e.line, e.endLine - 1), lines[e.endLine - 1]!.slice(0, e.endColumn - 1)].join('\n');
}

/**
 * Edits written against `before`, moved to `after`: undefined when an edit touches a
 * changed line or the text it replaces is no longer the same.
 */
export function carryEdits(edits: TextEdit[], before: string, after: string): TextEdit[] | undefined {
  if (before === after) return edits;
  const map = lineMap(before, after);
  const out: TextEdit[] = [];
  for (const e of edits) {
    const line = map(e.line);
    const endLine = map(e.endLine);
    if (line === undefined || endLine === undefined) return undefined;
    const moved = { ...e, line, endLine };
    if (slice(before, e) !== slice(after, moved)) return undefined;
    out.push(moved);
  }
  return out;
}

/** 1-based line and column of a character offset. */
function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, column: offset - start + 1 };
}

/** The smallest single edit that turns `before` into `after`. */
export function diffEdit(path: string, before: string, after: string): TextEdit | undefined {
  if (before === after) return undefined;
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const start = position(before, prefix);
  const end = position(before, before.length - suffix);
  return { path, line: start.line, column: start.column, endLine: end.line, endColumn: end.column, newText: after.slice(prefix, after.length - suffix) };
}
