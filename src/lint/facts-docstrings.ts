/**
 * Docstring facts: the parameters a Python docstring (Google, NumPy, Sphinx) or a
 * JSDoc/TSDoc comment documents, the parameters a signature declares, and the
 * `staleproof: ignore[rule]` comments of a code file (which locate findings in code,
 * not in a docs page).
 */
import type { RawFinding } from './engine.js';
import type { LintTarget } from './files.js';
import type { ScannedDoc, Suppressions } from './scan.js';

/** A file findings are located in: a scanned docs page, or a code or config file. */
export interface CheckedPage {
  target: LintTarget;
  doc: ScannedDoc;
  text: string;
}

export interface PageFinding {
  page: CheckedPage;
  f: RawFinding;
}

export interface DocParam {
  /** As a caller writes it: no `*`/`**`. */
  name: string;
  stars: '' | '*' | '**';
  /** `keyword`: a `Keyword Args:` / `Other Parameters` / `:key x:` entry (often consumed by `**kwargs`). */
  section: 'args' | 'keyword';
  /** 0-based line in the docstring text, and 0-based column of the name (stars included) there. */
  line: number;
  column: number;
  /** JSDoc `opts.x` / `opts[].x`: documents a property of a parameter, not a parameter. */
  dotted?: boolean;
}

export interface DocParams {
  style?: 'google' | 'numpy' | 'sphinx' | 'jsdoc';
  params: DocParam[];
  /** Where the documented parameters start: `Args:`, `Parameters`, the first `:param` or `@param`. */
  header?: { line: number; column: number; text: string };
  /** The docstring has a separate keyword-arguments section. */
  keywordSection: boolean;
}

const GOOGLE_HEADER = /^(\s*)(Args|Arguments|Parameters|Params|Keyword Args|Keyword Arguments|Kwargs|Other Parameters|Other Args)\s*:\s*$/;
const NUMPY_HEADER = /^(\s*)(Parameters|Params|Arguments|Other Parameters|Keyword Arguments)\s*$/;
const KEYWORD_SECTION = /^(Keyword Args|Keyword Arguments|Kwargs|Other Parameters|Other Args)$/;
const UNDERLINE = /^\s*-{3,}\s*$/;
const NAMES = String.raw`\*{0,2}[A-Za-z_]\w*(?:\s*,\s*\*{0,2}[A-Za-z_]\w*)*`;
/** `name (type): text`, `a, b (int): text`, `*args: text` */
const GOOGLE_ENTRY = new RegExp(String.raw`^(\s*)(${NAMES})\s*(?:\((?:[^()]|\([^()]*\))*\))?\s*:(?!:)`);
/** `name : type`, `name`, `a, b : int` */
const NUMPY_ENTRY = new RegExp(String.raw`^(\s*)(${NAMES})\s*(?::.*)?$`);
const SPHINX_FIELD = /:(param|parameter|arg|argument|key|keyword|type)\s+([^:\n]+?)\s*:/g;

const indentOf = (s: string) => s.length - s.trimStart().length;

/** `a, *b` at `column` of a line → one entry per name, each at its own column. */
function namesAt(list: string, line: number, column: number, section: DocParam['section']): DocParam[] {
  const out: DocParam[] = [];
  for (const m of list.matchAll(/(\*{0,2})([A-Za-z_]\w*)/g)) {
    out.push({ name: m[2]!, stars: m[1] as DocParam['stars'], section, line, column: column + m.index! });
  }
  return out;
}

/** Google style: `Args:` sections with `name (type): text` entries. */
function googleParams(lines: string[], out: DocParams): void {
  for (let i = 0; i < lines.length; i++) {
    const h = GOOGLE_HEADER.exec(lines[i]!);
    if (!h) continue;
    const base = h[1]!.length;
    const section = KEYWORD_SECTION.test(h[2]!) ? 'keyword' : 'args';
    if (section === 'keyword') out.keywordSection = true;
    out.header ??= { line: i, column: base, text: h[2]! };
    let entryIndent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (!line.trim()) continue;
      const ind = indentOf(line);
      if (ind <= base) break;
      if (entryIndent < 0) entryIndent = ind;
      if (ind > entryIndent) continue;
      const m = GOOGLE_ENTRY.exec(line);
      if (m) out.params.push(...namesAt(m[2]!, j, ind, section));
    }
  }
}

/** NumPy style: an underlined `Parameters` section with `name : type` entries. */
function numpyParams(lines: string[], out: DocParams): void {
  for (let i = 0; i + 1 < lines.length; i++) {
    const h = NUMPY_HEADER.exec(lines[i]!);
    if (!h || !UNDERLINE.test(lines[i + 1]!) || indentOf(lines[i + 1]!) !== h[1]!.length) continue;
    const base = h[1]!.length;
    const section = KEYWORD_SECTION.test(h[2]!) || h[2] === 'Keyword Arguments' ? 'keyword' : 'args';
    if (section === 'keyword') out.keywordSection = true;
    out.header ??= { line: i, column: base, text: h[2]! };
    for (let j = i + 2; j < lines.length; j++) {
      const line = lines[j]!;
      if (!line.trim()) continue;
      const ind = indentOf(line);
      if (ind < base) break;
      if (ind > base) continue;
      // The next section's header.
      if (j + 1 < lines.length && UNDERLINE.test(lines[j + 1]!)) break;
      const m = NUMPY_ENTRY.exec(line);
      if (!m) break;
      out.params.push(...namesAt(m[2]!, j, ind, section));
    }
  }
}

/** Sphinx fields: `:param x:`, `:param int x:`, `:type x:`, `:keyword x:`. */
function sphinxParams(lines: string[], out: DocParams): void {
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(SPHINX_FIELD)) {
      const words = m[2]!.trim().split(/\s+/);
      const raw = words[words.length - 1]!;
      if (!/^\*{0,2}[A-Za-z_]\w*$/.test(raw)) continue;
      const at = m.index! + m[0].lastIndexOf(raw);
      out.header ??= { line: i, column: m.index!, text: `:${m[1]}` };
      out.params.push(...namesAt(raw, i, at, m[1] === 'key' || m[1] === 'keyword' ? 'keyword' : 'args'));
    }
  }
}

/** JSDoc/TSDoc: `@param x`, `@param {T} x`, `@param [x]`, `@param [x=1]`, `@param opts.x`. */
function jsdocParams(lines: string[], out: DocParams): void {
  for (const [i, line] of lines.entries()) {
    // A block tag starts its line (after the comment's `/**` or `*`); `@param x` in a sentence or a code span is prose.
    const tag = /^\s*(?:\/\*\*+|\*+)?\s*@(param|arg|argument)\b/.exec(line);
    if (!tag) continue;
    let k = tag.index + tag[0].length;
    const skipSpace = () => {
      while (k < line.length && /\s/.test(line[k]!)) k++;
    };
    skipSpace();
    if (line[k] === '{') {
      let depth = 0;
      for (; k < line.length; k++) {
        if (line[k] === '{') depth++;
        else if (line[k] === '}' && --depth === 0) break;
      }
      if (depth !== 0) continue;
      k++;
      skipSpace();
    }
    if (line[k] === '[') {
      k++;
      skipSpace();
    }
    const m = /^[A-Za-z_$][\w$]*(?:(?:\[\])?\.[\w$]+)*/.exec(line.slice(k));
    if (!m) continue;
    out.header ??= { line: i, column: tag.index, text: tag[0] };
    const name = m[0];
    out.params.push({ name, stars: '', section: 'args', line: i, column: k, ...(name.includes('.') ? { dotted: true } : {}) });
  }
}

/** The parameters a docstring (Python) or a JSDoc comment (TypeScript/JavaScript) documents. */
export function docParams(text: string, lang: 'python' | 'ts'): DocParams {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: DocParams = { params: [], keywordSection: false };
  if (lang === 'ts') {
    jsdocParams(lines, out);
    if (out.params.length) out.style = 'jsdoc';
    return out;
  }
  const styles: [DocParams['style'], (l: string[], o: DocParams) => void][] = [
    ['google', googleParams],
    ['numpy', numpyParams],
    ['sphinx', sphinxParams],
  ];
  for (const [style, parse] of styles) {
    const before = out.params.length;
    parse(lines, out);
    if (out.params.length > before) out.style ??= style;
  }
  // One name documented twice (`:param x:` and `:type x:`) counts once, at its first line.
  const seen = new Set<string>();
  out.params = out.params.filter((p) => {
    const key = `${p.section}\0${p.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return out;
}

export interface SigParams {
  /** Named parameters in order (a method's receiver included). */
  names: string[];
  /** `*args` / `...rest`. */
  varArgs?: string;
  /** `**kwargs`. */
  varKw?: string;
  /** A destructured parameter (`{ a, b }`, `[x, y]`): its JSDoc name is the writer's choice. */
  destructured: boolean;
  /** Type annotations as written, by parameter name. */
  types?: Record<string, string>;
}

/**
 * A signature without its comments (`def f(  # noqa: C901`). TypeScript signatures are stored
 * on one line, so a `//` comment there hides the rest: undefined.
 */
function withoutComments(sig: string, lang: 'python' | 'ts'): string | undefined {
  let out = '';
  for (let k = 0; k < sig.length; k++) {
    const c = sig[k]!;
    if (c === '"' || c === "'" || c === '`') {
      const end = sig.indexOf(c, k + 1);
      const stop = end < 0 ? sig.length : end + 1;
      out += sig.slice(k, stop);
      k = stop - 1;
    } else if (lang === 'python' && c === '#') {
      const end = sig.indexOf('\n', k);
      k = end < 0 ? sig.length : end - 1;
    } else if (lang === 'ts' && c === '/' && sig[k + 1] === '*') {
      const end = sig.indexOf('*/', k + 2);
      if (end < 0) return undefined;
      k = end + 1;
    } else if (lang === 'ts' && c === '/' && sig[k + 1] === '/') return undefined;
    else out += c;
  }
  return out;
}

/** Index just past the bracket that closes the one at `open` (strings skipped), or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k]!;
    if (c === '"' || c === "'" || c === '`') {
      const end = text.indexOf(c, k + 1);
      if (end < 0) return -1;
      k = end;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return k + 1;
  }
  return -1;
}

/** Split at commas outside brackets and strings. */
function topLevelSplit(text: string, angles: boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k]!;
    if (c === '"' || c === "'" || c === '`') {
      const end = text.indexOf(c, k + 1);
      if (end < 0) break;
      k = end;
    } else if ('([{'.includes(c) || (angles && c === '<')) depth++;
    else if (')]}'.includes(c) || (angles && c === '>' && text[k - 1] !== '=')) depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, k));
      start = k + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * The parameters a stored signature declares: `def f(a, *args, b=1, **kw) -> X` (Python),
 * `function f(a: T, { b }: O, ...rest)`, `async query(q, opts?)`, `(a, b = 2) =>`, `x =>`
 * (TypeScript/JavaScript). Undefined when the parameter list cannot be read whole (a
 * signature cut short).
 */
export function signatureParams(signature: string, lang: 'python' | 'ts'): SigParams | undefined {
  const sig = withoutComments(signature.trim(), lang);
  if (sig === undefined) return undefined;
  let open: number;
  if (lang === 'python') {
    const m = /^(?:async\s+)?def\s+\w+\s*(?:\[[^\]]*\])?\s*\(/.exec(sig);
    if (!m) return undefined;
    open = m[0].length - 1;
  } else {
    // The first `(` outside type parameters, unless an arrow's single bare parameter comes first.
    let angle = 0;
    open = -1;
    for (let k = 0; k < sig.length; k++) {
      const c = sig[k]!;
      if (c === '<') angle++;
      else if (c === '>' && sig[k - 1] !== '=') angle--;
      else if (c === '(' && angle <= 0) {
        open = k;
        break;
      } else if (c === '=' && sig[k + 1] === '>' && angle <= 0) {
        const bare = /([A-Za-z_$][\w$]*)\s*$/.exec(sig.slice(0, k));
        return bare ? { names: [bare[1]!], destructured: false } : undefined;
      }
    }
    if (open < 0) return undefined;
  }
  const end = closing(sig, open);
  if (end < 0) return undefined;
  const out: SigParams = { names: [], destructured: false };
  for (let p of topLevelSplit(sig.slice(open + 1, end - 1), lang === 'ts')) {
    if (lang === 'python') {
      if (p === '*' || p === '/') continue;
      const star = /^(\*{1,2})\s*([A-Za-z_]\w*)/.exec(p);
      if (star) {
        if (star[1] === '*') out.varArgs = star[2];
        else out.varKw = star[2];
        continue;
      }
      const name = /^[A-Za-z_]\w*/.exec(p);
      if (name) {
        out.names.push(name[0]);
        const type = /^[A-Za-z_]\w*\s*:\s*([^=]+)/.exec(p)?.[1]?.trim();
        if (type) (out.types ??= {})[name[0]] = type;
      }
      continue;
    }
    p = p.replace(/^(?:@[\w.]+(?:\((?:[^()]|\([^()]*\))*\))?\s*)+/, '').replace(/^(?:(?:public|private|protected|readonly|override)\s+)+/, '');
    if (p.startsWith('...')) {
      const rest = /^\.\.\.\s*([A-Za-z_$][\w$]*)/.exec(p);
      out.varArgs = rest?.[1] ?? '...';
      if (!rest) out.destructured = true;
      continue;
    }
    if (p.startsWith('{') || p.startsWith('[')) {
      out.destructured = true;
      continue;
    }
    const name = /^[A-Za-z_$][\w$]*/.exec(p);
    if (!name || name[0] === 'this') continue;
    out.names.push(name[0]);
    const type = /^[A-Za-z_$][\w$]*\??\s*:\s*([^=]+)/.exec(p)?.[1]?.trim();
    if (type) (out.types ??= {})[name[0]] = type;
  }
  return out;
}

const CODE_IGNORE = /staleproof\s*:\s*ignore(-file)?(?:\[([^\]]*)\])?/i;

/**
 * `staleproof: ignore[rule]` comments in a code or config file (`#`, `//`, `/* *\/`, or
 * a docstring line): for the line they end, or for the next non-blank line when the
 * comment stands alone. `ignore` with no rules silences every rule; `ignore-file` the file.
 */
export function codeSuppressions(text: string): Suppressions {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Suppressions = { file: false, lines: new Map() };
  for (const [i, line] of lines.entries()) {
    const m = CODE_IGNORE.exec(line);
    if (!m) continue;
    if (m[1]) {
      out.file = true;
      continue;
    }
    const ids = (m[2] ?? '').split(/[\s,]+/).filter((x) => /^[a-z][a-z-]+$/.test(x));
    const alone = /^[\s#/*;!<-]*$/.test(line.slice(0, m.index));
    let target = i;
    if (alone) {
      target = i + 1;
      while (target < lines.length && !lines[target]!.trim()) target++;
    }
    for (const t of new Set([i, target])) {
      const set = out.lines.get(t + 1) ?? new Set<string>();
      if (ids.length) for (const id of ids) set.add(id);
      else set.add('*');
      out.lines.set(t + 1, set);
    }
  }
  return out;
}

/** A code or config file as a page findings can be located in (no claims, only its suppressions). */
export function codeDoc(path: string, text: string): ScannedDoc {
  return { path, spans: [], links: [], fences: [], suppress: codeSuppressions(text), lines: text.replace(/\r\n?/g, '\n').split('\n') };
}

/** Names close to `name`, best first: a small edit distance, or one containing the other. */
export function closeNames(name: string, pool: Iterable<string>, limit = 3, stems = true): string[] {
  const lower = name.toLowerCase();
  const scored: [string, number][] = [];
  for (const cand of new Set(pool)) {
    if (cand === name) continue;
    const c = cand.toLowerCase();
    const d = editDistance(lower, c);
    const contains = stems && Math.min(lower.length, c.length) >= 3 && (lower.includes(c) || c.includes(lower));
    let prefix = 0;
    while (prefix < Math.min(lower.length, c.length) && lower[prefix] === c[prefix]) prefix++;
    const sharesStem = stems && prefix >= 4 && prefix * 2 >= Math.min(lower.length, c.length);
    // Without stems (variable names), only a typo-sized difference: `DATABASE_URI` for `DATABASE_URL`, not `API_KEY` for `API_URL`.
    const limit = stems ? Math.max(2, Math.floor(Math.max(lower.length, c.length) / 3)) : Math.min(2, Math.floor(Math.max(lower.length, c.length) / 4));
    if (d <= limit || contains || sharesStem) scored.push([cand, contains || sharesStem ? Math.min(d, 1.5) : d]);
  }
  return scored.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([c]) => c);
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
