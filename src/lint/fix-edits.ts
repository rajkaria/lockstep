import type { Fix, TextEdit } from './types.js';

/** Applying edits to text: the Finding convention (1-based lines and columns, end column exclusive). */

/** Offsets of the first character of each line (1-based line `n` starts at `starts[n - 1]`), for `\n`, `\r\n` and `\r`. */
function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (content.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Length of line `index` (0-based) without its line break. */
function lineLength(content: string, starts: number[], index: number): number {
  const start = starts[index]!;
  let end = index + 1 < starts.length ? starts[index + 1]! : content.length;
  if (end > start && content.charCodeAt(end - 1) === 10) end--;
  if (end > start && content.charCodeAt(end - 1) === 13) end--;
  return end - start;
}

function offsetOf(content: string, starts: number[], line: number, column: number, what: string): number {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) throw new Error(`edit ${what} ${line}:${column} is not a 1-based position`);
  if (line > starts.length) throw new Error(`edit ${what} line ${line} is past the end of the file (${starts.length} lines)`);
  const len = lineLength(content, starts, line - 1);
  if (column > len + 1) throw new Error(`edit ${what} column ${column} is past the end of line ${line} (${len} characters)`);
  return starts[line - 1]! + column - 1;
}

/** Apply single-file edits (1-based lines/columns, endColumn exclusive, the Finding convention). Throws on overlap. */
export function applyTextEdits(content: string, edits: readonly TextEdit[]): string {
  if (!edits.length) return content;
  const starts = lineStarts(content);
  const ranges = edits.map((e) => {
    const start = offsetOf(content, starts, e.line, e.column, 'start');
    const end = offsetOf(content, starts, e.endLine, e.endColumn, 'end');
    if (end < start) throw new Error(`edit ${e.line}:${e.column}-${e.endLine}:${e.endColumn} ends before it starts`);
    return { start, end, text: e.newText };
  });
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1]!;
    const cur = ranges[i]!;
    // Two insertions at one point have no defined order, and an edit inside another is a conflict.
    if (cur.start < prev.end || (cur.start === prev.start && cur.start === cur.end && prev.start === prev.end)) {
      throw new Error('edits overlap');
    }
  }
  let out = '';
  let at = 0;
  for (const r of ranges) {
    out += content.slice(at, r.start) + r.text;
    at = r.end;
  }
  return out + content.slice(at);
}

/**
 * Apply every edit of the given fixes to in-memory file contents keyed by repo-relative
 * path; returns changed files. Throws when a fix edits a file that is not in `files`
 * or when two edits overlap.
 */
export function applyFixes(files: ReadonlyMap<string, string>, fixes: readonly Fix[]): Map<string, string> {
  const byPath = new Map<string, TextEdit[]>();
  for (const fix of fixes) {
    for (const e of fix.edits) {
      const list = byPath.get(e.path) ?? [];
      list.push(e);
      byPath.set(e.path, list);
    }
  }
  const changed = new Map<string, string>();
  for (const [path, edits] of byPath) {
    const content = files.get(path);
    if (content === undefined) throw new Error(`no content for ${path}`);
    const next = applyTextEdits(content, edits);
    if (next !== content) changed.set(path, next);
  }
  return changed;
}
