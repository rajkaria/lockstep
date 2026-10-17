/**
 * A line scanner for the claims a docs page makes about its repository: inline code
 * spans, links and shell blocks, each with its exact line and column, plus the
 * `staleproof: ignore` comments that silence them. Markdown, MDX, agent rule files
 * (`.mdc`, `.cursorrules`) and reStructuredText.
 */

export interface Span {
  text: string;
  line: number;
  /** 1-based column of the first character of `text`. */
  column: number;
  /** Exclusive. */
  endColumn: number;
}

export interface LinkClaim extends Span {
  /** `text` is the link target as written. */
  kind: 'inline' | 'reference' | 'html';
}

export interface FenceLine {
  text: string;
  line: number;
}

export interface Fence {
  lang: string;
  /** Line of the opening fence. */
  line: number;
  lines: FenceLine[];
}

export interface Suppressions {
  /** The whole file is ignored. */
  file: boolean;
  /** Line → rule ids ignored on it (`*` for every rule). */
  lines: Map<number, Set<string>>;
}

export interface ScannedDoc {
  path: string;
  spans: Span[];
  links: LinkClaim[];
  fences: Fence[];
  suppress: Suppressions;
  /** Text of each line (1-based index → line), for messages and fixes. */
  lines: string[];
}

const IGNORE_RE = /staleproof\s*:\s*ignore(-file)?\b([^>*]*)/i;
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'console', 'zsh', 'terminal', 'shellscript', 'shell-session', 'powershell', 'ps1', 'cmd', 'fish']);

export function isShellLang(lang: string): boolean {
  return SHELL_LANGS.has(lang.toLowerCase());
}

export function scanClaims(path: string, text: string): ScannedDoc {
  return /\.rst$/i.test(path) ? scanRstClaims(path, text) : scanMarkdownClaims(path, text);
}

function emptyDoc(path: string, lines: string[]): ScannedDoc {
  return { path, spans: [], links: [], fences: [], suppress: { file: false, lines: new Map() }, lines };
}

/** Record a `staleproof: ignore [rules]` comment found on `index` (0-based) for that line or the next non-blank one. */
function addSuppression(doc: ScannedDoc, lines: string[], index: number, comment: string, rest: string): void {
  const m = IGNORE_RE.exec(comment);
  if (!m) return;
  if (m[1]) {
    doc.suppress.file = true;
    return;
  }
  const ids = m[2]!.replace(/-->|\*\/|\}/g, ' ').split(/[\s,]+/).filter((x) => /^[a-z][a-z-]+$/.test(x));
  let target = index;
  if (!rest.trim()) {
    target = index + 1;
    while (target < lines.length && !lines[target]!.trim()) target++;
  }
  const line = target + 1;
  const set = doc.suppress.lines.get(line) ?? new Set<string>();
  if (ids.length) for (const id of ids) set.add(id);
  else set.add('*');
  doc.suppress.lines.set(line, set);
}

/** Replace inline code spans with spaces (same length), so link patterns never match inside code. */
function maskCode(line: string): string {
  return line.replace(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g, (m) => ' '.repeat(m.length));
}

function scanMarkdownClaims(path: string, text: string): ScannedDoc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const doc = emptyDoc(path, lines);
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  }
  let fence: { char: string; len: number; fence: Fence } | null = null;
  let inComment = false;

  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;

    if (fence) {
      if (new RegExp(`^\\s*\\${fence.char}{${fence.len},}\\s*$`).test(raw)) {
        doc.fences.push(fence.fence);
        fence = null;
      } else fence.fence.lines.push({ text: raw, line: lineNo });
      continue;
    }

    // HTML comments: suppression directives, and no claims inside them.
    let line = raw;
    if (inComment) {
      const close = line.indexOf('-->');
      if (close < 0) continue;
      inComment = false;
      line = ' '.repeat(close + 3) + line.slice(close + 3);
    }
    line = line.replace(/<!--(.*?)-->/g, (m, body: string, offset: number) => {
      addSuppression(doc, lines, i, body, raw.slice(0, offset) + raw.slice(offset + m.length));
      return ' '.repeat(m.length);
    });
    line = line.replace(/\{\s*\/\*(.*?)\*\/\s*\}/g, (m, body: string, offset: number) => {
      addSuppression(doc, lines, i, body, raw.slice(0, offset) + raw.slice(offset + m.length));
      return ' '.repeat(m.length);
    });
    const open = line.indexOf('<!--');
    if (open >= 0) {
      addSuppression(doc, lines, i, line.slice(open), line.slice(0, open));
      inComment = true;
      line = line.slice(0, open);
    }

    const fenceOpen = /^(\s*)(`{3,}|~{3,})\s*([^\s`{]*)(.*)$/.exec(line);
    if (fenceOpen && !(fenceOpen[2]![0] === '`' && fenceOpen[4]!.includes('`'))) {
      fence = {
        char: fenceOpen[2]![0]!,
        len: fenceOpen[2]!.length,
        fence: { lang: (fenceOpen[3] ?? '').replace(/^\{?\.?/, '').toLowerCase(), line: lineNo, lines: [] },
      };
      continue;
    }

    for (const m of line.matchAll(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g)) {
      const inner = m[2]!;
      const lead = inner.length - inner.trimStart().length;
      const t = inner.trim();
      if (!t) continue;
      const column = m.index! + m[1]!.length + lead + 1;
      doc.spans.push({ text: t, line: lineNo, column, endColumn: column + t.length });
    }

    const masked = maskCode(line);
    for (const m of masked.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
      const column = m.index! + m[0].indexOf(m[1]!) + 1;
      doc.links.push({ kind: 'inline', text: m[1]!, line: lineNo, column, endColumn: column + m[1]!.length });
    }
    const def = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(masked);
    if (def) {
      const column = masked.indexOf(def[1]!, def[0].length - def[1]!.length - 1) + 1;
      doc.links.push({ kind: 'reference', text: def[1]!, line: lineNo, column, endColumn: column + def[1]!.length });
    }
    for (const m of masked.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
      const column = m.index! + m[0].indexOf(m[1]!) + 1;
      doc.links.push({ kind: 'html', text: m[1]!, line: lineNo, column, endColumn: column + m[1]!.length });
    }
  }
  if (fence) doc.fences.push(fence.fence);
  return doc;
}

/** reStructuredText: ``literals``, `text <target>`_ links and `::` literal blocks (skipped). */
function scanRstClaims(path: string, text: string): ScannedDoc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const doc = emptyDoc(path, lines);
  let blockIndent = -1;
  let blockLang = '';
  let block: Fence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const indent = /^\s*/.exec(line)![0].length;
    if (blockIndent >= 0) {
      if (!line.trim() || indent > blockIndent) {
        if (line.trim()) block?.lines.push({ text: line.slice(blockIndent + 1), line: lineNo });
        continue;
      }
      if (block) doc.fences.push(block);
      blockIndent = -1;
      block = null;
    }
    const comment = /^\s*\.\.\s+(.*)$/.exec(line);
    if (comment && IGNORE_RE.test(comment[1]!)) {
      addSuppression(doc, lines, i, comment[1]!, '');
      continue;
    }
    const directive = /^(\s*)\.\.\s+(?:code-block|code|sourcecode|highlight)::\s*(\S*)/.exec(line);
    if (directive || /::\s*$/.test(line)) {
      blockIndent = indent;
      blockLang = directive?.[2] ?? '';
      block = { lang: blockLang.toLowerCase(), line: lineNo, lines: [] };
      if (directive) continue;
    }
    for (const m of line.matchAll(/``([^`]+?)``/g)) {
      const column = m.index! + 3;
      doc.spans.push({ text: m[1]!.trim(), line: lineNo, column, endColumn: column + m[1]!.trim().length });
    }
    for (const m of line.matchAll(/`[^`<]*<([^>`]+)>`__?/g)) {
      const column = m.index! + m[0].indexOf(`<${m[1]}>`) + 2;
      doc.links.push({ kind: 'inline', text: m[1]!, line: lineNo, column, endColumn: column + m[1]!.length });
    }
  }
  if (block) doc.fences.push(block);
  return doc;
}

/** Whether a finding on `line` for `rule` is silenced by a comment. */
export function isSuppressed(doc: ScannedDoc, line: number, rule: string): boolean {
  if (doc.suppress.file) return true;
  const set = doc.suppress.lines.get(line);
  return !!set && (set.has('*') || set.has(rule));
}
