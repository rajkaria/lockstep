import { scanClaims } from '../lint/scan.js';
import type { Finding, TextEdit } from '../lint/types.js';

/**
 * "Ignore this rule here": the suppression comment `staleproof lint` honours, written where
 * it silences exactly this finding. Docs pages take `<!-- staleproof: ignore <rule> -->` at
 * the end of the line (on its own line before a heading, so the heading's anchor is
 * unchanged); MDX `{/* … *\/}`; reStructuredText a `.. staleproof: ignore` comment before
 * the paragraph; code and docstrings `# staleproof: ignore[<rule>]` (or `//`) on the
 * definition line; env files a comment line before the variable. A finding inside a code
 * block is silenced by marking the example `staleproof: skip` (examples), else not at all.
 * The server applies the edit in memory and offers it only when the finding is then gone.
 */

export interface IgnoreAction {
  title: string;
  edit: TextEdit;
}

const MARKDOWN = /\.(md|markdown|mdc)$|(^|\/)\.(cursorrules|windsurfrules|clinerules)$/i;
const MDX = /\.mdx$/i;
const RST = /\.rst$/i;
const HASH_CODE = /\.(py|pyi|rb|sh|bash|zsh|ya?ml|toml)$/i;
const SLASH_CODE = /\.([cm]?[jt]sx?|go|java|kt|rs|swift|c|cc|cpp|h|hpp|cs)$/i;
const ENV_FILE = /(^|\/)\.env(\.[\w.-]+)?$|(^|\/)[\w.-]*\.env$/i;

function indentOf(line: string): string {
  return /^\s*/.exec(line)![0];
}

/** Insert `rule` into an existing `staleproof: ignore` list on the line, if there is one. */
function extendExisting(path: string, line: string, lineNo: number, rule: string, re: RegExp): TextEdit | undefined {
  const m = re.exec(line);
  if (!m || !m[1]?.trim()) return undefined;
  const at = m.index + m[0].indexOf(m[1]) + m[1].trimEnd().length;
  const sep = /[[,]$/.test(m[1].trimEnd()) ? '' : re.source.includes('\\[') ? ', ' : ' ';
  return { path, line: lineNo, column: at + 1, endLine: lineNo, endColumn: at + 1, newText: `${sep}${rule}` };
}

function endOfLine(path: string, line: string, lineNo: number, comment: string): TextEdit {
  // Keep trailing spaces (a Markdown hard break) after the comment.
  const body = line.trimEnd();
  return { path, line: lineNo, column: body.length + 1, endLine: lineNo, endColumn: body.length + 1, newText: ` ${comment}` };
}

function lineBefore(path: string, lines: string[], lineNo: number, comment: string, blankAfter = false): TextEdit {
  const indent = indentOf(lines[lineNo - 1] ?? '');
  return { path, line: lineNo, column: 1, endLine: lineNo, endColumn: 1, newText: `${indent}${comment}\n${blankAfter ? '\n' : ''}` };
}

export interface IgnoreContext {
  /** For docstring findings: the line of the definition the docstring belongs to. */
  definitionLine?: (line: number) => number | undefined;
}

export function ignoreAction(f: Finding, text: string, ctx: IgnoreContext = {}): IgnoreAction | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const line = lines[f.line - 1];
  if (line === undefined) return undefined;
  const title = `Ignore ${f.rule} here (staleproof: ignore)`;
  const path = f.path;

  if (MARKDOWN.test(path) || MDX.test(path)) {
    const mdx = MDX.test(path);
    const fence = scanClaims(path, text).fences.find((x) => f.line > x.line && f.line <= (x.lines.at(-1)?.line ?? x.line));
    if (fence) {
      if (!f.rule.startsWith('example-')) return undefined;
      const skip = mdx ? '{/* staleproof: skip */}' : '<!-- staleproof: skip -->';
      return { title: 'Skip this example (staleproof: skip)', edit: lineBefore(path, lines, fence.line, skip) };
    }
    const existing = mdx ? /\{\s*\/\*\s*staleproof\s*:\s*ignore\b([^*]*?)\s*\*\/\s*\}/ : /<!--\s*staleproof\s*:\s*ignore\b(?!-file)([^>]*?)\s*-->/;
    const extended = extendExisting(path, line, f.line, f.rule, existing);
    if (extended) return { title, edit: extended };
    const comment = mdx ? `{/* staleproof: ignore ${f.rule} */}` : `<!-- staleproof: ignore ${f.rule} -->`;
    // A heading's anchor comes from its text, and a trailing backslash is a hard break: comment on the line before.
    if (/^\s{0,3}#{1,6}\s/.test(line) || /\\\s*$/.test(line)) return { title, edit: lineBefore(path, lines, f.line, comment) };
    return { title, edit: endOfLine(path, line, f.line, comment) };
  }

  if (RST.test(path)) {
    // A comment is its own block: before a paragraph's first line only.
    if (f.line > 1 && lines[f.line - 2]!.trim()) return undefined;
    return { title, edit: lineBefore(path, lines, f.line, `.. staleproof: ignore ${f.rule}`, true) };
  }

  const hash = HASH_CODE.test(path) || ENV_FILE.test(path) || f.surface === 'config';
  const slash = SLASH_CODE.test(path);
  if (!hash && !slash) return undefined;
  const marker = hash && !slash ? '#' : '//';
  const comment = `${marker} staleproof: ignore[${f.rule}]`;
  if (ENV_FILE.test(path)) return { title, edit: lineBefore(path, lines, f.line, comment) };

  // Docstring findings are silenced on the definition line; others on their own line.
  const at = f.rule.startsWith('docstring-') ? ctx.definitionLine?.(f.line) : f.line;
  if (at === undefined) return undefined;
  const target = lines[at - 1];
  if (target === undefined) return undefined;
  const extended = extendExisting(path, target, at, f.rule, /staleproof\s*:\s*ignore\[([^\]]*)\]/);
  if (extended) return { title, edit: extended };
  // A Python line continued with a backslash cannot take a comment.
  if (/\\\s*$/.test(target)) return { title, edit: lineBefore(path, lines, at, comment) };
  return { title, edit: endOfLine(path, target, at, comment) };
}
