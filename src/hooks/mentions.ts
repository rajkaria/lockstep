import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtractMemo } from '../indexer/index.js';
import { JS_LANGS } from '../indexer/docs.js';
import { extractPython, type PyDef, type PyModule } from '../indexer/python.js';
import { classifyFile, git } from '../indexer/repo.js';
import { extractTs } from '../indexer/typescript.js';
import { scanClaims } from '../lint/scan.js';

/** A docs line that names a symbol whose signature an edit changed (or that it removed). */
export interface Mention {
  path: string;
  line: number;
  column: number;
  /** As the docs write it: `connect`, `Client.query`. */
  symbol: string;
  /** The file that defines it. */
  definedIn: string;
  before: string;
  /** Undefined: the file no longer defines it. */
  after?: string;
  /** Parameters the docs line still names that are gone. */
  removed?: string[];
  /** Parameters a call must now pass. */
  required?: string[];
}

/** A signature on one line, at most `max` characters: `def connect(host, *, deadline=10)`. */
export function compactSignature(sig: string, max = 120): string {
  const one = sig.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/,?\s*\)/g, ')').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

type Def = Pick<PyDef, 'qualname' | 'name' | 'kind' | 'signature' | 'parent' | 'params' | 'arity'>;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const isPublic = (name: string) => !name.startsWith('_') && !name.startsWith('#');
/** `__init__` / `constructor`: docs call it by the class name. */
const isConstructor = (d: Def) => d.kind === 'method' && (d.name === '__init__' || d.name === 'constructor');

async function parse(path: string, source: string | undefined, memo: ExtractMemo): Promise<PyModule | undefined> {
  if (source === undefined) return undefined;
  const kind = classifyFile(path);
  try {
    if (kind === 'python') return await memo.extract('python', source, { module: 'm', path }, (o) => extractPython(source, o));
    if (kind === 'typescript') return await memo.extract('ts', source, { module: 'm', path, tsx: !/\.(ts|mts|cts)$/.test(path) }, (o) => extractTs(source, o));
  } catch {
    // Unparseable now (mid-edit): nothing to compare.
  }
  return undefined;
}

/** Public functions, methods and classes whose signature differs between two parses of one file, or that are gone. */
export function changedSignatures(before: PyModule, after: PyModule | undefined): { def: Def; after?: Def }[] {
  const now = new Map((after?.defs ?? []).map((d) => [d.qualname, d]));
  const out: { def: Def; after?: Def }[] = [];
  for (const d of before.defs) {
    // Names shorter than three letters are matched too loosely in prose to be worth a mention.
    if (d.kind === 'module' || (!isPublic(d.name) && !isConstructor(d)) || d.name.length < 3) continue;
    const parent = before.defs.find((p) => p.qualname === d.parent);
    if (parent && parent.kind !== 'module' && parent.kind !== 'class') continue; // nested helpers
    if (parent?.kind === 'class' && !isPublic(parent.name)) continue;
    const a = now.get(d.qualname);
    if (!a) out.push({ def: d });
    else if (norm(a.signature) !== norm(d.signature)) out.push({ def: d, after: a });
  }
  return out;
}

const RECEIVERS = new Set(['self', 'cls', 'this']);
/** Code blocks the example checks already judge call by call (a fitting call there is not stale). */
const CHECKED_LANGS = new Set(['python', 'py', 'pycon', 'go', 'golang', ...JS_LANGS]);

/**
 * What a doc can get wrong about a changed signature: parameters it may still pass that
 * are gone, and parameters it cannot know it must now pass. Nothing (a new optional
 * parameter, an annotation): no doc is wrong because of it.
 */
export function breakingParams(before: Def, after: Def): { removed: string[]; required: string[] } {
  const names = (d: Def) => (d.arity?.params.map((p) => p.name) ?? d.params.map((p) => p.name.replace(/^\*+/, ''))).filter((n) => !RECEIVERS.has(n));
  const was = new Set(names(before));
  const now = new Set(names(after));
  const required = (after.arity?.params ?? []).filter((p) => p.required && !was.has(p.name) && !RECEIVERS.has(p.name)).map((p) => p.name);
  return { removed: [...was].filter((n) => !now.has(n)), required };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Docs that name symbols the edit to `path` changed in a way that makes the mention wrong:
 * a call (`connect(`) or a qualified name (`Client.query`) in inline code or a code block
 * the example checks do not cover, passing a parameter that is gone, or any call when a
 * parameter is now required, or any mention of a removed symbol. A method's bare call
 * counts only when no other definition in the repository has its name, so `.get(` is never
 * matched. Graph-free: the before side is HEAD's version of the file, both parsed through
 * the cache.
 */
export async function signatureMentions(
  root: string,
  path: string,
  docs: { path: string; text: string }[],
  memo: ExtractMemo,
  otherNames: (name: string) => number,
  /** The file's module name (`httpx._api`): a function whose name other code shares counts only as `httpx.get(`. */
  moduleName?: string,
): Promise<Mention[]> {
  if (!classifyFile(path) || classifyFile(path) === 'markdown') return [];
  const headText = await git(root, ['show', `HEAD:${path}`]).catch(() => undefined);
  const before = await parse(path, headText, memo);
  if (!before) return [];
  const nowText = await readFile(join(root, path), 'utf8').catch(() => undefined);
  const after = await parse(path, nowText, memo);
  if (nowText !== undefined && !after) return [];
  const changed = changedSignatures(before, after);
  if (!changed.length) return [];

  const patterns = changed.flatMap(({ def, after: a }) => {
    // A removed symbol: every mention is stale. A changed one: a mention passing a parameter that is gone, or any call when one is now required.
    const params = a ? breakingParams(def, a) : undefined;
    if (params && !params.removed.length && !params.required.length) return [];
    const gone = params?.removed.length ? new RegExp(`\\b(?:${params.removed.map(escape).join('|')})\\b`) : undefined;
    const stale = (rest: string) => !params || params.required.length > 0 || (!!gone && gone.test(rest));
    const parent = before.defs.find((p) => p.qualname === def.parent);
    const cls = parent?.kind === 'class' ? parent.name : undefined;
    const call = (name: string) => `(?<![\\w$])${escape(name)}\\s*\\(`;
    const found = { stale, before: def.signature, after: a?.signature, removed: params?.removed ?? [], required: params?.required ?? [] };
    if (cls && isConstructor(def)) return [{ re: new RegExp(call(cls)), symbol: cls, ...found }];
    // A bare call only for a name nothing else in the repository defines; else qualified by class or package.
    const unique = otherNames(def.name) <= 1;
    const qualifiers = cls ? [cls] : [...new Set([moduleName?.split('.')[0], moduleName].filter((q): q is string => !!q))];
    const forms = [...qualifiers.map((q) => `(?<![\\w$])${escape(q)}\\.${escape(def.name)}\\b`), unique ? call(def.name) : undefined].filter(Boolean);
    if (!forms.length) return [];
    return [{ re: new RegExp(forms.join('|')), symbol: cls ? `${cls}.${def.name}` : def.name, ...found }];
  });
  if (!patterns.length) return [];

  const out: Mention[] = [];
  for (const doc of docs) {
    if (doc.path === path) continue;
    const scanned = scanClaims(doc.path, doc.text);
    const pieces = [
      ...scanned.spans.map((s) => ({ text: s.text, line: s.line, column: s.column })),
      ...scanned.fences.filter((f) => !CHECKED_LANGS.has(f.lang)).flatMap((f) => f.lines.map((l) => ({ text: l.text, line: l.line, column: 1 }))),
    ];
    const seen = new Set<string>();
    for (const piece of pieces) {
      for (const p of patterns) {
        const m = p.re.exec(piece.text);
        if (!m || seen.has(`${piece.line}:${p.symbol}`) || !p.stale(piece.text.slice(m.index))) continue;
        seen.add(`${piece.line}:${p.symbol}`);
        const rest = piece.text.slice(m.index);
        const removed = p.removed.filter((n) => new RegExp(`\\b${escape(n)}\\b`).test(rest));
        out.push({
          path: doc.path,
          line: piece.line,
          column: piece.column + m.index,
          symbol: p.symbol,
          definedIn: path,
          before: p.before,
          ...(p.after !== undefined ? { after: p.after } : {}),
          ...(removed.length ? { removed } : {}),
          ...(p.required.length ? { required: p.required } : {}),
        });
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}
