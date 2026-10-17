import { isAbsolute, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DiagnosticSeverity, type Diagnostic, type Range, type TextEdit as LspTextEdit } from 'vscode-languageserver/node';
import type { Finding, Severity, TextEdit } from '../lint/types.js';

/**
 * Between the findings model (1-based lines and columns, end column exclusive, columns
 * counted in UTF-16 code units like JavaScript strings) and the Language Server Protocol
 * (0-based lines and characters, UTF-16 by default): the same columns, shifted by one.
 */

export const SOURCE = 'staleproof';

const SEVERITY: Record<Severity, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
};

export function ruleUrl(rule: string): string {
  return `https://staleproof.dev/#/docs/rules#${rule}`;
}

/** A 1-based, end-exclusive span as an LSP range (never negative, never inverted). */
export function toRange(line: number, column: number, endLine: number, endColumn: number): Range {
  const start = { line: Math.max(0, line - 1), character: Math.max(0, column - 1) };
  let end = { line: Math.max(0, endLine - 1), character: Math.max(0, endColumn - 1) };
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) end = start;
  return { start, end };
}

export function findingRange(f: Finding): Range {
  return toRange(f.line, f.column, f.endLine, f.endColumn);
}

/** What travels with a diagnostic, so code actions find their finding again. */
export interface DiagnosticData {
  fingerprint: string;
}

export function toDiagnostic(f: Finding): Diagnostic {
  return {
    range: findingRange(f),
    severity: SEVERITY[f.severity],
    source: SOURCE,
    code: f.rule,
    codeDescription: { href: ruleUrl(f.rule) },
    message: f.evidence?.looked ? `${f.message}\nLooked at ${f.evidence.looked}.` : f.message,
    data: { fingerprint: f.fingerprint } satisfies DiagnosticData,
  };
}

export function toLspEdit(e: TextEdit): LspTextEdit {
  return { range: toRange(e.line, e.column, e.endLine, e.endColumn), newText: e.newText };
}

/** Whether two ranges share a character (or touch, for an empty range at the cursor). */
export function overlaps(a: Range, b: Range): boolean {
  const before = (x: Range['start'], y: Range['start']) => x.line < y.line || (x.line === y.line && x.character < y.character);
  return !before(a.end, b.start) && !before(b.end, a.start);
}

/** The local path of a `file:` URI, or undefined for any other scheme (untitled buffers, remote files). */
export function uriToPath(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'file:') return undefined;
  let path = decodeURIComponent(url.pathname);
  if (process.platform === 'win32') {
    // `/c:/x` (or `/C%3A/x`, decoded above) is `c:\x`; a UNC host keeps its `\\host` prefix.
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    path = path.replace(/\//g, '\\');
    if (url.host) path = `\\\\${url.host}${path}`;
  }
  return path;
}

export function pathToUri(path: string): string {
  return pathToFileURL(path).href;
}

/** The repository-relative POSIX path of `path` inside `root`, or undefined when it lies outside. */
export function repoRelative(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}
