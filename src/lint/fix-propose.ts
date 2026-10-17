import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { buildSymbolTable, type ParsedRepo } from '../indexer/index.js';
import type { PyDef, PyModule } from '../indexer/python.js';
import type { RepoConfig } from '../indexer/repo-config.js';
import type { SymbolTable } from '../indexer/resolve.js';
import { loadHistoryCached, type ParseCache } from './cache.js';
import { checkCli, OLD_DOCS } from './check-cli.js';
import { checkCommands } from './check-commands.js';
import { checkDocstrings } from './check-docstrings.js';
import { checkEnv } from './check-env.js';
import { checkLinks, pathClaims, pathInSpan } from './check-paths.js';
import { checkSymbols, HISTORY_LINE, HISTORY_PAGE } from './check-symbols.js';
import type { RawFinding } from './engine.js';
import { normalizeRepoPath, RepoFacts } from './facts.js';
import { docParams, signatureParams, type CheckedPage } from './facts-docstrings.js';
import { docEnvClaims, envFileClaims } from './facts-env.js';
import { fileRenamedTo, renamedTo, type Renames } from './fix-renames.js';
import { lintTargets } from './files.js';
import { scanClaims, type ScannedDoc } from './scan.js';
import type { Finding, Fix, RuleId, Surface, TextEdit } from './types.js';

/**
 * Fix proposals: for each finding, the edit that would make it go away, only when the
 * answer is unambiguous: a rename between base and head (see fix-renames.ts), else the one
 * closest existing name. Proposals are not verified here (see fix-verify.ts).
 */

/** Rules a fix can be proposed for (the registry's `fixable`, minus what needs a graph). */
export const FIXABLE: ReadonlySet<RuleId> = new Set<RuleId>([
  'path-missing',
  'link-broken',
  'anchor-missing',
  'command-missing',
  'cli-command-unknown',
  'cli-flag-unknown',
  'env-unused',
  'symbol-missing',
  'docstring-param-unknown',
  'example-unknown-keyword',
  'example-missing-attribute',
  'example-missing-import',
  'example-removed',
]);

/** Rules whose fixes read the parsed code (symbols, signatures, examples). */
export const NEEDS_CODE: ReadonlySet<RuleId> = new Set<RuleId>(['symbol-missing', 'docstring-param-unknown', 'example-unknown-keyword', 'example-missing-attribute', 'example-missing-import', 'example-removed']);

/** Levenshtein distance. */
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

/** Words of a name: `API_KEY` → API, KEY; `queryV2` → query, V2; `lint:docs` → lint, docs. */
function words(name: string): string[] {
  return name.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
}

/**
 * Two names that differ in one short whole word (`API_KEY`/`APP_KEY`, `get_url`/`get_uri`)
 * name different things more often than one is a typo of the other.
 */
function swapsShortWord(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.length !== wb.length || wa.length < 2) return false;
  const diff = wa.map((w, i) => [w, wb[i]!] as const).filter(([x, y]) => x.toLowerCase() !== y.toLowerCase());
  return diff.length > 0 && diff.every(([x, y]) => x.length <= 3 && y.length <= 3);
}

/**
 * The one candidate closest to `name`, when it is within `max` edits (fewer for short
 * names: 1 up to 4 characters, 2 up to 7) and no other candidate is as close.
 */
export function closestName(name: string, pool: Iterable<string>, max = 2): string | undefined {
  const limit = Math.min(max, name.length <= 4 ? 1 : name.length <= 7 ? 2 : 3);
  let best: string | undefined;
  let bestD = Infinity;
  let ties = 0;
  for (const c of new Set(pool)) {
    if (c === name) continue;
    const d = editDistance(name, c);
    if (d < bestD) {
      best = c;
      bestD = d;
      ties = 1;
    } else if (d === bestD) ties++;
  }
  if (best === undefined || bestD > limit || ties !== 1) return undefined;
  if (swapsShortWord(name, best)) return undefined;
  return best;
}

/** A finding's raw details as its check produced them: the names that do exist there, and what it points at. */
export interface Hint {
  candidates?: string[];
  target?: string;
}

export interface ProposeContext {
  /** The tree's directory (files are read from here). */
  dir: string;
  repo: string;
  /** Every file of the tree. */
  paths: string[];
  /** The tree is a working tree (not an archive listing): look at the disk as lint does. */
  onDisk: boolean;
  config?: RepoConfig;
  renames?: Renames;
  /** The parsed code (from the verification baseline's lint), for symbol, docstring and example fixes. */
  parsed?: ParsedRepo[];
  cache?: ParseCache;
}

interface Page {
  path: string;
  text: string;
  doc: ScannedDoc;
  lines: string[];
  surface: Surface;
}

/** What a proposal needs, built lazily and shared by every finding of one result. */
class Context {
  readonly facts: RepoFacts;
  private pages = new Map<string, Promise<Page | undefined>>();
  private hintsByRule = new Map<string, Promise<Map<string, Hint>>>();
  private historyLoaded?: Promise<void>;
  private tableMemo?: SymbolTable;
  readonly surfaces: Map<string, Surface>;

  constructor(readonly o: ProposeContext) {
    this.facts = new RepoFacts(o.dir, new Set(o.paths), o.onDisk);
    this.surfaces = new Map(lintTargets(o.paths, o.config).map((t) => [t.path, t.surface]));
  }

  page(path: string): Promise<Page | undefined> {
    let p = this.pages.get(path);
    if (!p) {
      p = readFile(join(this.o.dir, path), 'utf8')
        .then((text) => {
          const doc = scanClaims(path, text);
          return { path, text, doc, lines: doc.lines, surface: this.surfaces.get(path) ?? 'docs' };
        })
        .catch(() => undefined);
      this.pages.set(path, p);
    }
    return p;
  }

  history(): Promise<void> {
    this.historyLoaded ??= loadHistoryCached(this.facts, this.o.cache);
    return this.historyLoaded;
  }

  get table(): SymbolTable | undefined {
    if (!this.o.parsed?.length) return undefined;
    this.tableMemo ??= buildSymbolTable(this.o.parsed);
    return this.tableMemo;
  }

  /** Every docs page lint reads, scanned (the env and symbol checks look across pages). */
  async allPages(): Promise<CheckedPage[]> {
    const out: CheckedPage[] = [];
    for (const t of lintTargets(this.o.paths, this.o.config)) {
      const p = await this.page(t.path);
      if (p) out.push({ target: t, doc: p.doc, text: p.text });
    }
    return out;
  }

  /** The check's raw finding for `f` (same rule, place and subject), keyed by fingerprint. */
  async hint(f: Finding): Promise<Hint | undefined> {
    const key = ['command-missing', 'cli-command-unknown', 'cli-flag-unknown', 'link-broken', 'anchor-missing'].includes(f.rule) ? `${f.rule}\0${f.path}` : f.rule;
    let p = this.hintsByRule.get(key);
    if (!p) {
      p = this.computeHints(f).catch(() => new Map<string, Hint>());
      this.hintsByRule.set(key, p);
    }
    return (await p).get(`${f.rule}\0${f.path}\0${f.line}\0${f.column}\0${f.subject}`);
  }

  private async computeHints(f: Finding): Promise<Map<string, Hint>> {
    const out = new Map<string, Hint>();
    const put = (path: string, r: RawFinding) =>
      out.set(`${r.rule}\0${path}\0${r.span.line}\0${r.span.column}\0${r.subject}`, { ...(r.candidates ? { candidates: r.candidates } : {}), ...(r.target ? { target: r.target } : {}) });
    const ctx = { facts: this.facts, repo: this.o.repo };
    if (f.rule === 'command-missing' || f.rule === 'cli-command-unknown' || f.rule === 'cli-flag-unknown' || f.rule === 'link-broken' || f.rule === 'anchor-missing') {
      const page = await this.page(f.path);
      if (!page) return out;
      const surface = page.surface === 'agent' || page.surface === 'readme' ? page.surface : 'docs';
      const raws =
        f.rule === 'command-missing'
          ? await checkCommands(page.doc, { ...ctx, surface })
          : f.rule === 'link-broken' || f.rule === 'anchor-missing'
            ? await checkLinks(page.doc, this.facts)
            : await checkCli(page.doc, { ...ctx, surface });
      for (const r of raws) put(f.path, r);
      return out;
    }
    if (f.rule === 'env-unused') {
      for (const { page, f: r } of await checkEnv({ dir: this.o.dir, repo: this.o.repo, paths: this.o.paths, pages: await this.allPages(), config: this.o.config, unused: true, undocumented: false })) {
        put(page.target.path, r);
      }
      return out;
    }
    if (f.rule === 'symbol-missing' && this.table && this.o.parsed) {
      for (const { page, f: r } of await checkSymbols(await this.allPages(), this.table, this.o.parsed)) put(page.target.path, r);
      return out;
    }
    if (f.rule === 'docstring-param-unknown' && this.o.parsed?.[0]) {
      for (const { page, f: r } of await checkDocstrings(this.o.parsed[0], (p) => this.facts.text(p))) put(page.target.path, r);
    }
    return out;
  }
}

/** The edit replacing `needle` inside the finding's span: at its end (`end`), or its one occurrence. */
function editInSpan(f: Finding, line: string, needle: string, newText: string, where: 'end' | 'once' = 'once'): TextEdit | undefined {
  if (!needle) return undefined;
  const start = f.column - 1;
  const end = f.endColumn - 1;
  let at = -1;
  if (where === 'end') {
    if (line.slice(end - needle.length, end) === needle) at = end - needle.length;
  } else {
    const inside = line.slice(start, end);
    const first = inside.indexOf(needle);
    if (first >= 0 && inside.indexOf(needle, first + 1) < 0) at = start + first;
  }
  if (at < 0) return undefined;
  return { path: f.path, line: f.line, column: at + 1, endLine: f.line, endColumn: at + 1 + needle.length, newText };
}

function fix(description: string, edits: TextEdit[]): Fix | undefined {
  return edits.length ? { description, edits, verified: false } : undefined;
}

const GENERIC_NAMES = /^(index|main|mod|lib|init|__init__|__main__|utils?|helpers?|common|types?|config|settings|constants|readme|license|changelog|contributing|setup|package|makefile|dockerfile|test|tests|conftest|app|server|client|cli)\.[\w.]+$/i;
const VENDORED_OR_TESTS = /(^|\/)(node_modules|vendor|third[-_]party|tests?|__tests__|fixtures?|testdata|spec|e2e|examples?)\//;

/** The one file of the repository with this file name (not a generic name, not in tests or vendored code unless the original was). */
function uniqueSameName(path: string, ctx: Context): string | undefined {
  const name = posix.basename(path);
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name) || GENERIC_NAMES.test(name)) return undefined;
  const inTests = VENDORED_OR_TESTS.test(path);
  const same = ctx.facts.withBasename(name).filter((p) => p !== path && (inTests || !VENDORED_OR_TESTS.test(p)));
  return same.length === 1 ? same[0] : undefined;
}

/** Where a missing repository path lives now: renamed between base and head, renamed in history, or the one file of its name. */
async function pathNow(path: string, ctx: Context, sameName: boolean): Promise<{ to: string; why: string } | undefined> {
  const p = path.replace(/\/+$/, '');
  const renamed = fileRenamedTo(ctx.o.renames, p);
  if (renamed && ctx.facts.exists(renamed)) return { to: renamed, why: 'renamed in this change' };
  await ctx.history();
  const moved = ctx.facts.movedTo(p);
  if (moved) return { to: moved, why: 'moved in git history' };
  if (sameName) {
    const only = uniqueSameName(p, ctx);
    if (only) return { to: only, why: 'the only file of that name' };
  }
  return undefined;
}

/** The bases a path written in `docPath` may be relative to, in `pathClaims` order: '' is the repository root. */
function baseDirs(docPath: string): string[] {
  const docDir = posix.dirname(docPath);
  const out = ['', docDir === '.' ? '' : docDir];
  for (let d = posix.dirname(docDir); d !== '.' && d !== '/'; d = posix.dirname(d)) out.push(d);
  return [...new Set(out)];
}

/** `newPath` written the way `written` was: from the same base, with its `./` and trailing slash. */
function writeLike(written: string, base: string, newPath: string, rootStyle: boolean): string {
  const slash = written.endsWith('/') && !newPath.endsWith('/') ? '/' : '';
  let out = rootStyle ? newPath : posix.relative(base, newPath) || '.';
  if (written.startsWith('./') && !out.startsWith('../') && !out.startsWith('./')) out = `./${out}`;
  return `${out}${slash}`;
}

/** The repository paths a path written in `docPath` is tried as, in `pathClaims` order. */
function resolutions(written: string, docPath: string): { base: string; path: string }[] {
  const docDir = posix.dirname(docPath) === '.' ? '' : posix.dirname(docPath);
  const bases = written.startsWith('../') ? [docDir] : written.startsWith('./') ? [docDir, ...baseDirs(docPath).filter((d) => d !== docDir && d !== ''), ''] : baseDirs(docPath);
  const out: { base: string; path: string }[] = [];
  for (const base of bases) {
    const path = normalizeRepoPath(posix.join(base, written));
    if (path !== undefined) out.push({ base, path });
  }
  return out;
}

/**
 * How to write `target` in `docPath` so it resolves to it (the first existing candidate is
 * the target): from `prefer` when that works, else the shortest way, keeping `./` and a
 * trailing slash as written.
 */
function writeFor(written: string, docPath: string, target: string, ctx: Context, prefer?: string): string | undefined {
  const slash = written.endsWith('/') && !target.endsWith('/') ? '/' : '';
  const options: { base: string; text: string }[] = [];
  for (const base of baseDirs(docPath)) {
    let text = base === '' ? target : posix.relative(base, target);
    if (!text || text === '.') continue;
    if (written.startsWith('./') && !text.startsWith('../')) text = `./${text}`;
    const first = resolutions(text, docPath).find((r) => ctx.facts.exists(r.path));
    if (first?.path === target) options.push({ base, text: `${text}${slash}` });
  }
  const preferred = prefer !== undefined ? options.find((o) => o.base === prefer) : undefined;
  return (preferred ?? options.sort((a, b) => a.text.length - b.text.length)[0])?.text;
}

async function fixPath(f: Finding, ctx: Context): Promise<Fix | undefined> {
  const page = await ctx.page(f.path);
  if (!page) return undefined;
  const line = page.lines[f.line - 1] ?? '';
  const claim = pathClaims(page.doc, ctx.facts).find((c) => c.span.line === f.line && c.span.column === f.column);
  const ref = claim?.ref ?? pathInSpan(line.slice(f.column - 1, f.endColumn - 1));
  if (!ref) return undefined;
  const written = ref.path;
  const cands = resolutions(written, f.path);
  // Evidence first (a rename in this change, a move in git history) for every reading of the path; then the one file of its name.
  let found: { to: string; why: string; base?: string } | undefined;
  for (const c of cands) {
    const now = await pathNow(c.path, ctx, false);
    if (now) {
      found = { ...now, base: c.base };
      break;
    }
  }
  if (!found) {
    const names = [...new Set(cands.map((c) => uniqueSameName(c.path.replace(/\/+$/, ''), ctx)).filter((x): x is string => !!x))];
    if (names.length === 1) found = { to: names[0]!, why: 'the only file of that name' };
  }
  if (!found) return undefined;
  const newText = writeFor(written, f.path, found.to, ctx, found.base);
  if (!newText) return undefined;
  const edit = editInSpan(f, line, written, newText);
  return edit ? fix(`Rename to \`${newText.replace(/\/$/, '')}\` (${found.why})`, [edit]) : undefined;
}

const EXT = /\.[A-Za-z0-9]{1,8}$/;

async function fixLink(f: Finding, ctx: Context): Promise<Fix | undefined> {
  const page = await ctx.page(f.path);
  if (!page) return undefined;
  const line = page.lines[f.line - 1] ?? '';
  const text = line.slice(f.column - 1, f.endColumn - 1);
  const cut = text.search(/[#?]/);
  const filePart = cut >= 0 ? text.slice(0, cut) : text;
  if (!filePart || filePart.includes('%') || /\s/.test(filePart)) return undefined;
  const docDir = posix.dirname(f.path) === '.' ? '' : posix.dirname(f.path);
  const hint = await ctx.hint(f);
  // The check found the file at the repository root: the link should be relative to this page.
  const up = hint?.candidates?.length === 1 ? hint.candidates[0] : undefined;
  let newText: string | undefined;
  let why = '';
  if (up) {
    newText = filePart.startsWith('./') && !up.startsWith('../') ? `./${up}` : up;
    why = 'the file at the repository root, relative to this page';
  } else if (EXT.test(filePart)) {
    const now = (await pathNow(f.subject, ctx, true)) ?? (() => {
      const close = closestName(f.subject, ctx.o.paths.filter((p) => Math.abs(p.length - f.subject.length) <= 2 && posix.extname(p) === posix.extname(f.subject)));
      return close ? { to: close, why: 'the closest file name' } : undefined;
    })();
    if (!now) return undefined;
    newText = writeLike(filePart, docDir, now.to, false);
    why = now.why;
  }
  if (!newText || /[\s()]/.test(newText)) return undefined;
  const edit = editInSpan({ ...f, endColumn: f.column + filePart.length }, line, filePart, newText);
  return edit ? fix(`Rename to \`${newText}\` (${why})`, [edit]) : undefined;
}

async function fixAnchor(f: Finding, ctx: Context): Promise<Fix | undefined> {
  const page = await ctx.page(f.path);
  if (!page) return undefined;
  const line = page.lines[f.line - 1] ?? '';
  const text = line.slice(f.column - 1, f.endColumn - 1);
  const hash = text.indexOf('#');
  if (hash < 0) return undefined;
  const anchor = text.slice(hash + 1);
  if (!anchor || /[%\s]/.test(anchor)) return undefined;
  const target = f.subject.slice(0, f.subject.lastIndexOf('#')) || f.path;
  const renamed = ctx.o.renames?.anchors.get(target)?.get(anchor.toLowerCase());
  let to = renamed?.size === 1 ? [...renamed][0] : undefined;
  let why = 'heading renamed in this change';
  if (!to) {
    const anchors = (await ctx.hint(f))?.candidates ?? [...((await ctx.facts.anchors(target)) ?? [])];
    to = closestName(anchor.toLowerCase(), anchors, 3);
    why = 'the closest heading';
  }
  if (!to) return undefined;
  const edit: TextEdit = { path: f.path, line: f.line, column: f.column + hash + 1, endLine: f.line, endColumn: f.column + text.length, newText: to };
  return fix(`Rename to \`#${to}\` (${why})`, [edit]);
}

/** A renamed name, else the one close candidate the check offered. */
function renamedOrClose(name: string, candidates: readonly string[] | undefined, ctx: Context, max = 2): { to: string; why: string } | undefined {
  const renamed = renamedTo(ctx.o.renames, name);
  if (renamed) return { to: renamed, why: 'renamed in this change' };
  if (ctx.o.renames?.names.has(name)) return undefined; // renamed to several names: ambiguous
  const close = candidates?.length ? closestName(name, candidates, max) : undefined;
  return close ? { to: close, why: 'the closest name' } : undefined;
}

async function fixCommand(f: Finding, ctx: Context): Promise<Fix | undefined> {
  const page = await ctx.page(f.path);
  if (!page) return undefined;
  const line = page.lines[f.line - 1] ?? '';
  const name = f.subject.split(' ').pop()!;
  const hint = await ctx.hint(f);
  const target = renamedOrClose(name, hint?.candidates, ctx);
  if (!target) return undefined;
  const edit = editInSpan(f, line, name, target.to, 'end');
  const shown = `${f.subject.slice(0, f.subject.length - name.length)}${target.to}`;
  const why = target.why === 'renamed in this change' ? `renamed${hint?.target ? ` in ${hint.target}` : ''}` : `the closest ${f.subject.startsWith('make ') ? 'target' : f.subject.startsWith('just ') || f.subject.startsWith('task ') ? 'recipe' : f.subject.includes(' -m ') ? 'module' : 'script'}${hint?.target ? ` in ${hint.target}` : ''}`;
  return edit ? fix(`Rename to \`${shown}\` (${why})`, [edit]) : undefined;
}

async function fixCli(f: Finding, ctx: Context): Promise<Fix | undefined> {
  const page = await ctx.page(f.path);
  if (!page) return undefined;
  const line = page.lines[f.line - 1] ?? '';
  const name = f.subject.split(' ').pop()!;
  const word = line.slice(f.column - 1, f.endColumn - 1);
  // A cluster of short flags (`-abc`) is not one name to replace.
  if (word !== name && !word.startsWith(`${name}=`)) return undefined;
  const hint = await ctx.hint(f);
  const target = renamedOrClose(name, hint?.candidates, ctx);
  if (!target) return undefined;
  const edit: TextEdit = { path: f.path, line: f.line, column: f.column, endLine: f.line, endColumn: f.column + name.length, newText: target.to };
  const what = f.rule === 'cli-flag-unknown' ? 'option' : 'command';
  return fix(`Rename to \`${target.to}\` (${target.why === 'the closest name' ? `the closest ${what} of \`${f.subject.slice(0, f.subject.length - name.length - 1)}\`` : target.why})`, [edit]);
}

async function fixEnv(f: Finding, ctx: Context): Promise<Fix | undefined> {
  const page = await ctx.page(f.path);
  if (!page) return undefined;
  const hint = await ctx.hint(f);
  const target = renamedOrClose(f.subject, hint?.candidates, ctx);
  if (!target) return undefined;
  // One finding stands for every mention of the variable on the page: rename them all.
  const claims = page.surface === 'config' || !/\.(md|mdx|rst|mdc|txt)$/i.test(f.path) ? envFileClaims(page.text).claims : docEnvClaims(page.doc);
  const edits: TextEdit[] = claims
    .filter((c) => c.name === f.subject && (page.lines[c.span.line - 1] ?? '').slice(c.span.column - 1, c.span.endColumn - 1) === f.subject)
    .map((c) => ({ path: f.path, line: c.span.line, column: c.span.column, endLine: c.span.line, endColumn: c.span.endColumn, newText: target.to }));
  if (!edits.some((e) => e.line === f.line && e.column === f.column)) return undefined;
  return fix(`Rename to \`${target.to}\` (${target.why === 'the closest name' ? 'the closest variable the code reads' : target.why})`, edits);
}

async function fixSymbol(f: Finding, ctx: Context): Promise<Fix | undefined> {
  const page = await ctx.page(f.path);
  if (!page) return undefined;
  const line = page.lines[f.line - 1] ?? '';
  const member = f.subject.split('.').pop()!;
  const hint = await ctx.hint(f);
  const target = renamedOrClose(member, hint?.candidates, ctx);
  if (!target) return undefined;
  const edit = editInSpan(f, line, member, target.to, 'end');
  const owner = f.subject.slice(0, f.subject.length - member.length);
  return edit ? fix(`Rename to \`${owner}${target.to}\` (${target.why === 'the closest name' ? `the closest member of \`${owner.replace(/\.$/, '')}\`` : target.why})`, [edit]) : undefined;
}

const RECEIVERS = new Set(['self', 'cls']);

/** The docstring a line of a code file belongs to, with the signature it describes. */
function docstringAt(mod: PyModule, line: number): { def: PyDef; sig: PyDef; bound: boolean } | undefined {
  for (const def of mod.defs) {
    if (!def.docText || !def.docLine) continue;
    const last = def.docLine + def.docText.split('\n').length - 1;
    if (line < def.docLine || line > last) continue;
    if (def.kind === 'class') {
      const init = mod.defs.find((d) => d.qualname === `${def.qualname}.__init__`);
      return init ? { def, sig: init, bound: true } : undefined;
    }
    if (def.kind !== 'function' && def.kind !== 'method') return undefined;
    return { def, sig: def, bound: mod.lang !== 'ts' && def.kind === 'method' && !def.decorators.includes('staticmethod') };
  }
  return undefined;
}

async function fixDocstring(f: Finding, ctx: Context): Promise<Fix | undefined> {
  const mod = ctx.o.parsed?.[0]?.modules.find((m) => m.path === f.path);
  const source = await ctx.facts.text(f.path);
  if (!mod || source === undefined) return undefined;
  const at = docstringAt(mod, f.line);
  if (!at) return undefined;
  const lang = mod.lang === 'ts' ? 'ts' : 'python';
  const sig = signatureParams(at.sig.signature, lang);
  if (!sig || sig.destructured) return undefined;
  const doc = docParams(at.def.docText!, lang);
  const unknownName = /\(([^()]*)\)$/.exec(f.subject)?.[1];
  if (!unknownName) return undefined;
  const declared = sig.names.slice(at.bound ? 1 : 0);
  const named = doc.params.filter((p) => !p.dotted);
  const documented = new Set([...named.map((p) => p.name), ...doc.params.filter((p) => p.dotted).map((p) => p.name.split(/[.[]/)[0]!)]);
  const known = new Set([...sig.names, ...sig.names.map((n) => n.replace(/^_+/, '')), ...(sig.varArgs ? [sig.varArgs] : []), ...(sig.varKw ? [sig.varKw] : [])]);
  const unknown = [...new Set(named.filter((p) => !known.has(p.name)).map((p) => p.name))];
  const undocumented = declared.filter((n) => !documented.has(n) && !RECEIVERS.has(n) && !n.startsWith('_'));
  let to: string | undefined;
  let why = '';
  const renamed = renamedTo(ctx.o.renames, unknownName);
  if (renamed && undocumented.includes(renamed)) {
    to = renamed;
    why = 'renamed in the signature';
  } else if (unknown.length === 1 && unknown[0] === unknownName && undocumented.length === 1) {
    to = undocumented[0];
    why = 'the one undocumented parameter';
  }
  if (!to) return undefined;
  // An options object took the place of the documented parameter: the entry describes one of its properties, not it.
  if ((sig.types?.[to] ?? '').trim().startsWith('{')) return undefined;
  // Every entry of the old name (`:param x:` and `:type x:`), located as the check locates them.
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const docLines = at.def.docText!.split('\n');
  const edits: TextEdit[] = [];
  for (const p of doc.params.filter((x) => x.name === unknownName)) {
    const lineNo = at.def.docLine! + p.line;
    const text = lines[lineNo - 1] ?? '';
    const offset = p.line === 0 ? Math.max(0, text.indexOf(docLines[0]!)) : 0;
    const written = `${p.stars}${p.name}`;
    let col = text.indexOf(written, offset + p.column);
    if (col < 0) col = text.indexOf(written);
    if (col < 0) return undefined;
    const start = col + p.stars.length;
    edits.push({ path: f.path, line: lineNo, column: start + 1, endLine: lineNo, endColumn: start + 1 + p.name.length, newText: to });
  }
  const label = f.subject.slice(0, f.subject.lastIndexOf('('));
  return fix(`Rename to \`${to}\` (${why} of \`${label}\`)`, edits);
}

/** The fence of a page that holds `line`. */
function fenceAt(doc: ScannedDoc, line: number): { first: number; last: number } | undefined {
  for (const fe of doc.fences) {
    const first = fe.lines[0]?.line ?? fe.line + 1;
    const last = fe.lines.at(-1)?.line ?? fe.line;
    if (line >= first && line <= last) return { first, last };
  }
  return undefined;
}

/** Keyword arguments of the call that starts at (line, col), by name, with their positions. */
function callKeywords(lines: string[], line: number, col: number, lastLine: number): Map<string, { line: number; column: number }[]> | undefined {
  const out = new Map<string, { line: number; column: number }[]>();
  let depth = 0;
  let started = false;
  let quote: string | undefined;
  for (let l = line; l <= lastLine; l++) {
    const text = lines[l - 1] ?? '';
    for (let i = l === line ? col : 0; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '#' && started) break;
      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
        started = true;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (started && depth === 0) return out;
        continue;
      }
      if (!started && !/\s/.test(ch)) return undefined;
      if (depth === 1 && /[A-Za-z_]/.test(ch) && !/[\w.]/.test(text[i - 1] ?? '')) {
        const m = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(text.slice(i));
        if (m) {
          const list = out.get(m[1]!) ?? [];
          list.push({ line: l, column: i + 1 });
          out.set(m[1]!, list);
        }
        const w = /^\w+/.exec(text.slice(i));
        i += (w?.[0].length ?? 1) - 1;
      }
    }
    quote = undefined;
  }
  return undefined;
}

/** Parameters a caller may pass by keyword, for a function or a class (its constructor). */
function keywordParams(table: SymbolTable, qualname: string, repo: string): string[] | undefined {
  let sym = table.symbol(qualname, repo);
  if (sym?.def.kind === 'class') sym = table.symbol(`${qualname}.__init__`, repo);
  const arity = sym?.def.arity;
  if (!arity) return undefined;
  return arity.params.filter((p) => p.kind !== 'pos-only' && !RECEIVERS.has(p.name)).map((p) => p.name);
}

async function fixExample(f: Finding, ctx: Context): Promise<Fix | undefined> {
  const page = await ctx.page(f.path);
  const table = ctx.table;
  if (!page) return undefined;
  const line = page.lines[f.line - 1] ?? '';
  if (f.rule === 'example-unknown-keyword') {
    const keyword = /has no parameter `([^`]+)`/.exec(f.message)?.[1];
    if (!keyword || !table) return undefined;
    const params = keywordParams(table, f.subject, ctx.o.repo);
    if (!params?.length) return undefined;
    const renamed = renamedTo(ctx.o.renames, keyword);
    const to = renamed && params.includes(renamed) ? renamed : ctx.o.renames?.names.has(keyword) ? undefined : closestName(keyword, params);
    if (!to) return undefined;
    const fence = fenceAt(page.doc, f.line);
    const kws = callKeywords(page.lines, f.line, f.endColumn - 1, fence?.last ?? f.line);
    const at = kws?.get(keyword);
    // One `keyword=` in the call, and the new name not passed already.
    if (!at || at.length !== 1 || kws!.has(to)) return undefined;
    const edit: TextEdit = { path: f.path, line: at[0]!.line, column: at[0]!.column, endLine: at[0]!.line, endColumn: at[0]!.column + keyword.length, newText: to };
    return fix(`Rename to \`${to}=\` (${renamed ? 'renamed in the signature' : 'the closest parameter'} of \`${f.subject}\`)`, [edit]);
  }
  if (f.rule === 'example-missing-attribute' || f.rule === 'example-removed') {
    const member = f.subject.split('.').pop()!;
    let target = renamedTo(ctx.o.renames, member);
    let why = 'renamed in this change';
    if (!target && f.rule === 'example-missing-attribute' && table && !ctx.o.renames?.names.has(member)) {
      const owner = f.evidence?.looked;
      const members = owner ? table.memberMissing(owner, member, ctx.o.repo)?.members : undefined;
      target = members ? closestName(member, members.filter((m) => !m.startsWith('_'))) : undefined;
      why = 'the closest member';
    }
    if (!target) return undefined;
    const edit = editInSpan(f, line, member, target, 'end');
    return edit ? fix(`Rename to \`${target}\` (${why})`, [edit]) : undefined;
  }
  if (f.rule === 'example-missing-import') {
    const name = f.subject;
    let target = renamedTo(ctx.o.renames, name);
    let why = 'renamed in this change';
    if (!target && table && !ctx.o.renames?.names.has(name)) {
      const owner = f.evidence?.looked;
      const members = owner ? table.memberMissing(owner, name, ctx.o.repo)?.members : undefined;
      target = members ? closestName(name, members.filter((m) => !m.startsWith('_'))) : undefined;
      why = 'the closest name';
    }
    if (!target) return undefined;
    const word = new RegExp(`(?<![\\w.])${name.replace(/[$]/g, '\\$')}(?![\\w])`, 'g');
    const hits = [...line.matchAll(word)];
    const importAt = line.search(/\bimport\b/);
    if (hits.length !== 1 || importAt < 0 || hits[0]!.index! < importAt) return undefined;
    // Renaming the import breaks every later use of the old name, unless it is imported `as` another name.
    const aliased = new RegExp(`${name}\\s+as\\s+\\w+`).test(line);
    if (!aliased) {
      const use = new RegExp(`(?<![\\w.])${name.replace(/[$]/g, '\\$')}(?![\\w])`);
      const code = page.doc.fences.flatMap((fe) => fe.lines).filter((x) => x.line !== f.line);
      if (code.some((x) => use.test(x.text))) return undefined;
    }
    const col = hits[0]!.index! + 1;
    return fix(`Rename to \`${target}\` (${why})`, [{ path: f.path, line: f.line, column: col, endLine: f.line, endColumn: col + name.length, newText: target }]);
  }
  return undefined;
}

/** A proposal for one finding, or undefined when the answer is not unambiguous. */
async function proposeOne(f: Finding, ctx: Context): Promise<Fix | undefined> {
  switch (f.rule) {
    case 'path-missing':
      return fixPath(f, ctx);
    case 'link-broken':
      return fixLink(f, ctx);
    case 'anchor-missing':
      return fixAnchor(f, ctx);
    case 'command-missing':
      return fixCommand(f, ctx);
    case 'cli-command-unknown':
    case 'cli-flag-unknown':
      return fixCli(f, ctx);
    case 'env-unused':
      return fixEnv(f, ctx);
    case 'symbol-missing':
      return fixSymbol(f, ctx);
    case 'docstring-param-unknown':
      return fixDocstring(f, ctx);
    case 'example-unknown-keyword':
    case 'example-missing-attribute':
    case 'example-missing-import':
    case 'example-removed':
      return fixExample(f, ctx);
    default:
      return undefined;
  }
}

/** Proposed (unverified) fixes by finding fingerprint. */
export async function proposeFixes(findings: readonly Finding[], o: ProposeContext): Promise<Map<string, Fix>> {
  const ctx = new Context(o);
  const out = new Map<string, Fix>();
  for (const f of findings) {
    if (!FIXABLE.has(f.rule)) continue;
    // Migration guides, release notes and old versions' docs name what is gone on purpose: never rewrite them.
    if (HISTORY_PAGE.test(f.path) || OLD_DOCS.test(f.path)) continue;
    try {
      const line = (await ctx.page(f.path))?.lines[f.line - 1] ?? '';
      if (HISTORY_LINE.test(line)) continue;
      const proposed = await proposeOne(f, ctx);
      if (proposed) out.set(f.fingerprint, proposed);
    } catch {
      // A proposal that cannot be computed is no proposal.
    }
  }
  return out;
}
