import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { buildSymbolTable, parseRepo, type ParsedRepo } from './indexer/index.js';
import { git } from './indexer/repo.js';
import type { PyModule } from './indexer/python.js';
import { shown, symbolId, type SymbolTable } from './indexer/resolve.js';
import { arityOf, langOfPath, trustsSignature, type Arity, type SourceLang } from './indexer/signature.js';
import { newFindings } from './lint/diff.js';
import { gitRoot, lintTree, refTree, resolveCommit, type LintTree } from './lint/sources.js';
import type { Finding, LintResult } from './lint/types.js';
import { diffRange, type ChangedSymbol } from './pr/changes.js';

/**
 * The release gate: before a release goes out, are its breaking API changes in the
 * changelog, and do the docs still reference what it removed or changed? Compares two
 * commits of a local clone (default: the latest tag reachable from `HEAD`, and `HEAD`),
 * with no graph and no network:
 *
 * - breaking changes of the public API (`src/pr/changes.ts` over the two commits): removed,
 *   renamed and no longer exported symbols, and signatures that reject calls the old one
 *   accepted, for what the packages export (the audit's definition of public API);
 * - for each, whether the changelog's section for the release (the release's version,
 *   `Unreleased`, or the top section) mentions it;
 * - docs at the new commit that still reference a removed or changed symbol (lint's example
 *   and symbol checks, matched to the changes);
 * - every lint finding at the new commit, marking the ones the old commit did not have.
 */

export type ReleaseGate = 'undocumented-breaking' | 'stale-docs';
export const RELEASE_GATES: ReleaseGate[] = ['undocumented-breaking', 'stale-docs'];
export type ReleaseFormat = 'text' | 'markdown' | 'json';
export const RELEASE_FORMATS: ReleaseFormat[] = ['text', 'markdown', 'json'];

export interface BreakingChange {
  /** The symbol as users name it (`pkg.Client.query`, `@scope/pkg.connect`). */
  symbol: string;
  qualname: string;
  kind: ChangedSymbol['kind'];
  change: 'removed' | 'renamed' | 'export-removed' | 'signature';
  /** Why it breaks callers, one plain phrase each. */
  reasons: string[];
  /** Parameters the reasons name (a changelog entry about them documents the change). */
  params?: string[];
  path: string;
  line: number;
  before?: string;
  after?: string;
  renamedTo?: string;
  /** The changelog section names it. */
  mentioned: boolean;
  /** What the changelog says that matched (`Client.query`). */
  mentionedAs?: string;
}

export interface StaleReference {
  /** The breaking change the docs still rely on. */
  symbol: string;
  finding: Finding;
}

export interface ChangelogSection {
  heading: string;
  line: number;
  /** `version`: the release's own version; `unreleased`; `top`: the first release section. */
  kind: 'version' | 'unreleased' | 'top';
}

export interface ReleaseReport {
  version: 1;
  repo: string;
  from: { ref: string; sha: string; why: string };
  to: { ref: string; sha: string };
  changelog: { path?: string; source?: 'commit' | 'working tree'; section?: ChangelogSection; why?: string };
  breaking: BreakingChange[];
  undocumented: number;
  /** Public signatures that changed in ways callers do not notice, or that could not be compared. */
  compatible: number;
  staleDocs: StaleReference[];
  /** Lint at the new commit: every finding, the fingerprints the old commit did not have, new errors other than `staleDocs`. */
  lint: { findings: Finding[]; newSinceFrom: string[]; errors: number; newErrors: number; files: number };
  failOn: ReleaseGate[];
  failed: ReleaseGate[];
  ms: number;
}

/** Files a changelog may be in, when `--changelog` does not say. */
export const CHANGELOG_FILES = ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md', 'NEWS.md', 'RELEASES.md', 'CHANGELOG.rst', 'CHANGES.rst', 'HISTORY.rst', 'CHANGELOG', 'docs/changelog.md', 'docs/CHANGELOG.md'];

/** Directories whose code is not the library's API (as in the audit). */
const NOT_API = /(^|\/)(tests?|testing|benchmarks?|scripts|examples?|docs?|tools|ci|\.github|noxfile\.py|setup\.py|conftest\.py)(\/|$)/;

/** Decorators that make a method an attribute: its "signature" is not a call signature. */
const PROPERTY = /(^|\.)(property|cached_property|getter|setter|deleter)$/;

const VERSION = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z][0-9A-Za-z.-]*)?)\b/;
const UNRELEASED = /\b(unreleased|upcoming|next release|in development)\b/i;

/** The version a tag names (`v0.4.0` → `0.4.0`), if it names one. */
export function tagVersion(tag: string): string | undefined {
  return VERSION.exec(tag.replace(/^.*\//, ''))?.[1];
}

async function tagsAt(root: string, sha: string): Promise<string[]> {
  const out = (await git(root, ['tag', '--points-at', sha]).catch(() => '')).split('\n').filter(Boolean);
  // A version-like tag names the release best (`v0.3.0` over `v1`): the most version parts first.
  return out.sort((a, b) => (tagVersion(b)?.split(/[.+-]/).length ?? 0) - (tagVersion(a)?.split(/[.+-]/).length ?? 0) || a.localeCompare(b));
}

/** A prerelease version (`13.0.0-0`, `1.2.0-rc.1`). */
const PRERELEASE = /^\d+\.\d+(?:\.\d+)?-/;

/**
 * The latest tag reachable from `to` that is not on `to` itself (on a `release: published`
 * run, `HEAD` carries the new tag: the release is compared with the one before it). A stable
 * release skips prerelease tags (`v13.0.0` is compared with `v12.1.0`, not `v13.0.0-0`).
 */
export async function previousTag(root: string, toSha: string, toVersion?: string): Promise<{ tag: string; sha: string } | undefined> {
  const describe = async (rev: string) => (await git(root, ['describe', '--tags', '--abbrev=0', rev]).catch(() => '')).trim();
  const skipPre = !(toVersion && PRERELEASE.test(toVersion));
  let rev = toSha;
  for (let i = 0; i < 100; i++) {
    const tag = await describe(rev);
    if (!tag) return undefined;
    const sha = await resolveCommit(root, tag);
    const best = (await tagsAt(root, sha))[0] ?? tag;
    const version = tagVersion(best);
    if (sha !== toSha && !(skipPre && version && PRERELEASE.test(version))) return { tag: best, sha };
    const parent = (await git(root, ['rev-parse', '--verify', '--quiet', `${sha}^`]).catch(() => '')).trim();
    if (!parent) return undefined;
    rev = parent;
  }
  return undefined;
}

async function repoName(root: string): Promise<string> {
  const url = (await git(root, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : basename(root);
}

const isPrivateName = (q: string) => q.split('.').some((p) => p.startsWith('_') && !/^__.*__$/.test(p));
const parentOf = (q: string) => q.slice(0, q.lastIndexOf('.'));
const last = (q: string) => q.slice(q.lastIndexOf('.') + 1);

/**
 * Whether a changed symbol was public API at the old commit: exported by its package
 * (the indexer's `exportedIds`), a constructor of an exported class, or a re-export of a
 * package entry module. When the packages export nothing the source shows (an empty
 * `__init__`, lazy `__getattr__` exports), naming decides: no `_` part, not in tests,
 * scripts or examples, capitalised in Go.
 */
export function wasPublic(c: ChangedSymbol, exported: Set<string>, repo: string): boolean {
  const byName = exported.size === 0;
  if (NOT_API.test(c.path)) return false;
  if (c.change === 'export-removed') {
    const module = parentOf(c.qualname);
    const entry = /(^|\/)__init__\.py$/.test(c.path) || !module.includes('.');
    return entry && !isPrivateName(c.qualname);
  }
  const lang = langOfPath(c.path);
  const nameOk = (q: string) => !isPrivateName(q) && (lang !== 'go' || /^[A-Z]/.test(last(q)));
  if (c.kind === 'method' && (c.name === '__init__' || c.name === 'constructor')) {
    const cls = parentOf(c.qualname);
    return byName ? nameOk(cls) : exported.has(symbolId(repo, cls));
  }
  if (c.kind === 'module') return false;
  return byName ? nameOk(c.qualname) : exported.has(symbolId(repo, c.qualname));
}

/** Names a Python module lists in `__all__` (a literal list or tuple, `+=` too); undefined when it has none. */
export function dunderAll(source: string): string[] | undefined {
  let found = false;
  const names: string[] = [];
  for (const m of source.matchAll(/^__all__\s*(?::[^=\n]*)?(\+?=)\s*[[(]([\s\S]*?)[\])]/gm)) {
    if (m[1] === '=') names.length = 0;
    found = true;
    for (const s of m[2]!.matchAll(/["']([A-Za-z_]\w*)["']/g)) names.push(s[1]!);
  }
  return found ? names : undefined;
}

/**
 * Python's `import *` takes a module's `__all__` when it has one: a name that only reaches
 * the package through `from ._client import *` is public only if `_client.__all__` lists it
 * (httpx's `_utils.Timer`, imported by `_client`, is not). `exported` (the indexer's export
 * set) is narrowed to what the package entry modules really offer; other languages pass.
 */
export function honourDunderAll(exported: Set<string>, repo: string, modules: PyModule[], table: SymbolTable, allOf: Map<string, string[]>): Set<string> {
  const py = modules.filter((m) => !m.lang || m.lang === 'python');
  if (!py.length || !allOf.size) return exported;
  const byModule = new Map(py.map((m) => [m.module, m]));
  const memo = new Map<string, Map<string, string>>();
  const namesOf = (module: string, depth = 0): Map<string, string> => {
    const hit = memo.get(module);
    if (hit) return hit;
    const names = new Map<string, string>();
    const mod = byModule.get(module);
    if (!mod || depth > 8) return names;
    memo.set(module, names);
    for (const d of mod.defs) if (d.parent === module) names.set(d.name, `${module}.${d.name}`);
    for (const i of mod.imports) {
      if (i.alias === '*') {
        for (const [n, q] of namesOf(i.target, depth + 1)) if (!names.has(n)) names.set(n, q);
      } else if (!i.alias.includes('.')) names.set(i.alias, `${module}.${i.alias}`);
    }
    const all = allOf.get(module);
    for (const n of [...names.keys()]) if (all ? !all.includes(n) : n.startsWith('_')) names.delete(n);
    return names;
  };
  const allowed = new Set<string>();
  for (const mod of py) {
    const entry = /(^|\/)__init__\.py$/.test(mod.path) || !mod.module.includes('.');
    if (!entry || isPrivateName(mod.module)) continue;
    for (const dotted of namesOf(mod.module).values()) {
      const v = table.resolveDotted(dotted, 0, repo);
      if (v?.t === 'sym' && v.sym.repo === repo) allowed.add(v.sym.id);
    }
  }
  const prefix = `${repo}:`;
  return new Set(
    [...exported].filter((id) => {
      const sym = table.symbol(id.slice(prefix.length), repo);
      if (!sym || (sym.def.kind !== 'class' && sym.def.kind !== 'function' && sym.def.kind !== 'method')) return true;
      if (!byModule.has(sym.module)) return true;
      // Methods follow their class.
      const owner = sym.def.kind === 'method' ? symbolId(repo, sym.def.parent ?? '') : id;
      return allowed.has(owner);
    }),
  );
}

/**
 * Why a new signature rejects calls the old one accepted, from both arities. Python
 * callers pass by keyword too; JavaScript/TypeScript and Go only by position.
 */
export function breakingReasons(a: Arity, b: Arity, lang: SourceLang): string[] {
  const out: string[] = [];
  const posA = a.params.filter((p) => p.kind !== 'kw-only');
  const posB = b.params.filter((p) => p.kind !== 'kw-only');
  const word = lang === 'python' ? 'positional argument' : 'argument';
  if (!b.varArgs && posB.length < posA.length) out.push(`takes at most ${posB.length} ${word}${posB.length === 1 ? '' : 's'} (was ${posA.length})`);
  if (a.varArgs && !b.varArgs) out.push(lang === 'python' ? 'no longer takes *args' : 'no longer takes rest arguments');
  if (lang !== 'python') {
    const reqA = a.params.filter((p) => p.required).length;
    const reqB = b.params.filter((p) => p.required).length;
    if (reqB > reqA) out.push(`requires ${reqB} argument${reqB === 1 ? '' : 's'} (was ${reqA})`);
    return out;
  }
  if (a.varKw && !b.varKw) out.push('no longer takes **kwargs');
  const inB = new Map(b.params.map((p) => [p.name, p]));
  const inA = new Map(a.params.map((p) => [p.name, p]));
  for (const [i, p] of a.params.entries()) {
    if (p.kind === 'pos-only') continue;
    const q = inB.get(p.name);
    if (!q) {
      if (b.varKw) continue;
      const twin = b.params[i];
      out.push(twin && !inA.has(twin.name) && twin.kind !== 'pos-only' ? `parameter \`${p.name}\` renamed to \`${twin.name}\`` : `\`${p.name}\` is no longer a parameter`);
    } else if (q.kind === 'pos-only') {
      out.push(`\`${p.name}\` can no longer be passed by keyword`);
    } else if (p.kind !== 'kw-only' && q.kind === 'kw-only') {
      out.push(`\`${p.name}\` is keyword-only now`);
    }
  }
  for (const q of b.params) {
    if (!q.required) continue;
    const p = inA.get(q.name);
    if (!p) {
      if (!out.some((r) => r.endsWith(`renamed to \`${q.name}\``))) out.push(`new required parameter \`${q.name}\``);
    } else if (!p.required) out.push(`\`${q.name}\` is required now`);
  }
  // Positional callers bind by order: two parameters swapped breaks them silently.
  const shared = posA.map((p) => p.name).filter((n) => posB.some((q) => q.name === n));
  const orderB = posB.map((q) => q.name).filter((n) => shared.includes(n));
  const moved = shared.findIndex((n, i) => orderB[i] !== n);
  if (moved >= 0) out.push(`positional order changed: \`${orderB[moved]}\` now comes before \`${shared[moved]}\``);
  return [...new Set(out)];
}

interface Heading {
  level: number;
  text: string;
  line: number;
}

/** Markdown (ATX and setext) or reStructuredText headings, outside code fences. */
export function changelogHeadings(text: string, rst = false): Heading[] {
  const lines = text.split(/\r?\n/);
  const out: Heading[] = [];
  if (rst) {
    const styles: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const under = lines[i]!;
      const title = lines[i - 1]!.trim();
      if (!title || !/^([=\-~^"'+*#`:.])\1{2,}\s*$/.test(under) || /^([=\-~^"'+*#`:.])\1+$/.test(title)) continue;
      const style = under[0]!;
      if (!styles.includes(style)) styles.push(style);
      out.push({ level: styles.indexOf(style) + 1, text: title, line: i });
    }
    return out;
  }
  let fence: string | undefined;
  for (const [i, raw] of lines.entries()) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (m) {
      if (!fence) fence = m[1]![0]!;
      else if (m[1]![0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (atx) {
      out.push({ level: atx[1]!.length, text: atx[2]!, line: i + 1 });
      continue;
    }
    const prev = lines[i - 1];
    if (i > 0 && prev && prev.trim() && !/^\s*([-*+>#]|\d+[.)])\s/.test(prev) && /^\s{0,3}(=+|-+)\s*$/.test(raw) && (i < 2 || !lines[i - 2]?.trim())) {
      out.push({ level: raw.trim().startsWith('=') ? 1 : 2, text: prev.trim(), line: i });
    }
  }
  return out;
}

/**
 * The changelog section for the release: the heading naming its version, else a non-empty
 * `Unreleased` section, else the top release section, unless that one is the previous
 * release's (then the release has no section yet).
 */
export function releaseSection(text: string, opts: { rst?: boolean; version?: string; previousVersion?: string } = {}): { section?: ChangelogSection; body: string; why?: string } {
  const lines = text.split(/\r?\n/);
  const hs = changelogHeadings(text, opts.rst);
  const first = hs.find((h) => UNRELEASED.test(h.text) || VERSION.test(h.text));
  if (!first) return { body: '', why: 'it has no Unreleased or version heading' };
  const level = first.level;
  const releases = hs.filter((h) => h.level === level);
  const bodyOf = (h: Heading) => {
    const next = hs.find((x) => x.line > h.line && x.level <= level);
    // A setext or RST heading's underline is on its own line: start after it.
    const start = opts.rst || /^\s{0,3}(=+|-+)\s*$/.test(lines[h.line] ?? '') ? h.line + 1 : h.line;
    // Every heading's line is its title's (1-based): the section ends on the line before it.
    return lines.slice(start, next ? next.line - 1 : undefined).join('\n');
  };
  const versionOf = (h: Heading) => VERSION.exec(h.text)?.[1];
  const make = (h: Heading, kind: ChangelogSection['kind']) => ({ section: { heading: h.text, line: h.line, kind }, body: bodyOf(h) });
  if (opts.version) {
    const own = releases.find((h) => versionOf(h) === opts.version);
    if (own) return make(own, 'version');
  }
  // Only the first release section can be the one in progress (an old "0.1.0 (unreleased)" further down is history).
  const unreleased = releases[0] && UNRELEASED.test(releases[0].text) ? releases[0] : undefined;
  if (unreleased && bodyOf(unreleased).trim()) return make(unreleased, 'unreleased');
  const top = releases.find((h) => h !== unreleased);
  if (!top) return unreleased ? { ...make(unreleased, 'unreleased') } : { body: '', why: 'it has no release section' };
  if (opts.previousVersion && versionOf(top) === opts.previousVersion) {
    return { body: '', why: `its top section is ${top.text}, the previous release: this release has no section yet` };
  }
  return make(top, 'top');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What the changelog section says about a change, if anything: the full name, `Class.member`,
 * or the bare name; for a signature change, also every parameter it names, written as code
 * (`` `proxies` ``), as `proxies=`, or as "proxies argument".
 */
export function mentionIn(body: string, c: Pick<BreakingChange, 'qualname' | 'symbol' | 'renamedTo' | 'params'> & { name: string }): string | undefined {
  const ctor = /^(__init__|constructor)$/.test(c.name);
  const own = ctor ? last(parentOf(c.qualname)) : c.name;
  const tail = c.qualname.split('.').slice(-2).join('.');
  const names = [c.symbol, c.qualname, ctor ? '' : tail, own, c.renamedTo ? last(c.renamedTo) : ''].filter(Boolean);
  for (const n of names) {
    if (new RegExp(`(^|[^\\w$])${escapeRe(n)}(?![\\w$])`).test(body)) return n;
  }
  if (c.params?.length) {
    const said = (p: string) =>
      new RegExp(`\`${escapeRe(p)}\`|(^|[^\\w$])${escapeRe(p)}=|(^|[^\\w$])${escapeRe(p)}\\s+(argument|parameter|param|kwarg|keyword|option)`, 'i').test(body);
    if (c.params.every(said)) return c.params.map((p) => `\`${p}\``).join(', ');
  }
  return undefined;
}

/** The symbols a lint finding at the new commit says the docs still rely on. */
function findingTargets(f: Finding): string[] {
  const looked = f.evidence?.looked ?? '';
  if (f.rule.startsWith('example-')) {
    const subject = f.subject.replace(/\(\)$/, '');
    return [looked, `${looked}.${subject}`, subject, `${subject}.__init__`].filter(Boolean);
  }
  if (f.rule === 'symbol-missing') {
    const owner = /^(?:members of|names in) (\S+)/.exec(looked)?.[1];
    const member = f.subject.replace(/\(\)$/, '').split('.').pop();
    return owner && member ? [`${owner}.${member}`] : [];
  }
  return [];
}

export interface ReleaseOptions {
  /** A folder of the git checkout. */
  dir: string;
  /** Default: the latest tag reachable from `to` (not on `to` itself). */
  from?: string;
  /** Default `HEAD`. */
  to?: string;
  /** Default: the first of `CHANGELOG_FILES` at `to`. */
  changelog?: string;
  failOn?: ReleaseGate[];
  /** `owner/name` (default: from the origin remote). */
  repo?: string;
  log?: (message: string) => void;
}

/** Compare two commits for a release (see the module comment). */
export async function releaseReport(opts: ReleaseOptions): Promise<ReleaseReport> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const root = await gitRoot(opts.dir);
  if (!root) throw new Error(`${opts.dir} is not in a git checkout: the release gate compares two commits of one`);
  const toRef = opts.to ?? 'HEAD';
  const toSha = await resolveCommit(root, toRef);
  let from: ReleaseReport['from'];
  if (opts.from) {
    from = { ref: opts.from, sha: await resolveCommit(root, opts.from), why: 'the given --from' };
  } else {
    const toVersion = (toRef !== 'HEAD' ? tagVersion(toRef) : undefined) ?? (await tagsAt(root, toSha)).map(tagVersion).find(Boolean);
    const prev = await previousTag(root, toSha, toVersion);
    if (!prev) throw new Error(`no tag is reachable from ${toRef} (other than one on that commit): pass --from <ref> (a tag, a branch or a commit)`);
    from = { ref: prev.tag, sha: prev.sha, why: `the latest tag reachable from ${toRef}` };
  }
  const repo = opts.repo ?? (await repoName(root));
  const failOn = opts.failOn ?? RELEASE_GATES;
  log(`release ${from.ref} (${from.sha.slice(0, 7)}) → ${toRef} (${toSha.slice(0, 7)})`);

  // Both commits are extracted and linted the same way; the parse feeds the public API.
  const trees: LintTree[] = [];
  let fromLint: LintResult;
  let toLint: LintResult;
  let fromParsed: ParsedRepo | undefined;
  let toParsed: ParsedRepo | undefined;
  const allOf = new Map<string, string[]>();
  try {
    const fromTree = await refTree(root, from.sha, { repo });
    trees.push(fromTree);
    const toTree = await refTree(root, toSha, { repo });
    trees.push(toTree);
    fromLint = await lintTree(fromTree, { repo, onParsed: (p) => (fromParsed = p[0]) });
    toLint = await lintTree(toTree, { repo, onParsed: (p) => (toParsed = p[0]) });
    fromParsed ??= await parseRepo({ repo, dir: fromTree.dir, sha: from.sha });
    for (const m of fromParsed.modules) {
      if (m.lang && m.lang !== 'python') continue;
      const all = dunderAll(await readFile(join(fromTree.dir, m.path), 'utf8').catch(() => ''));
      if (all) allOf.set(m.module, all);
    }
  } finally {
    await Promise.all(trees.map((t) => t.dispose()));
  }
  const parsedFrom = fromParsed!;
  const table = buildSymbolTable([parsedFrom]);
  const exported = honourDunderAll(table.exportedIds(repo, parsedFrom.modules), repo, parsedFrom.modules, table, allOf);

  const defsOf = (p?: ParsedRepo) => {
    const m = new Map<string, PyModule['defs']>();
    for (const mod of p?.modules ?? []) for (const d of mod.defs) m.set(d.qualname, [...(m.get(d.qualname) ?? []), d]);
    return m;
  };
  const defsFrom = defsOf(parsedFrom);
  const defsTo = defsOf(toParsed);
  const diff = from.sha === toSha ? { symbols: [] as ChangedSymbol[] } : await diffRange(root, repo, from.sha, toSha);
  // How users name a symbol: Python's dotted path; a JS/TS or Go module as it is imported, then the member.
  const moduleOf = new Map<string, string>();
  for (const p of [parsedFrom, toParsed]) for (const m of p?.modules ?? []) for (const d of m.defs) moduleOf.set(d.qualname, m.module);
  const display = (q: string) => {
    const module = moduleOf.get(q);
    if (!module || !/^(js|go)-/.test(module) || q === module) return shown(q);
    return `${shown(module)}.${q.slice(module.length + 1)}`;
  };
  const breaking: BreakingChange[] = [];
  let compatible = 0;
  for (const c of diff.symbols) {
    if (c.change === 'added' || c.change === 'modified' || !wasPublic(c, exported, repo)) continue;
    let reasons: string[] = [];
    if (c.change === 'removed') reasons = ['removed'];
    else if (c.change === 'renamed') reasons = [`renamed to \`${display(c.renamedTo ?? '')}\``];
    else if (c.change === 'export-removed') reasons = [`no longer exported from \`${shown(parentOf(c.qualname))}\``];
    else if (c.change === 'signature' && c.before && c.after) {
      // Properties are not called; a decorator outside the known signature-keeping ones may rewrap the function.
      const decorators = [...(defsFrom.get(c.qualname) ?? []), ...(defsTo.get(c.qualname) ?? [])].flatMap((d) => d.decorators);
      if (decorators.some((d) => PROPERTY.test(d)) || !trustsSignature(decorators)) {
        compatible++;
        continue;
      }
      const lang = langOfPath(c.path);
      const [a, b] = await Promise.all([arityOf(c.before, lang, c.path), arityOf(c.after, lang, c.path)]);
      reasons = a && b ? breakingReasons(a, b, lang) : [];
      if (!reasons.length) {
        compatible++;
        continue;
      }
    } else continue;
    breaking.push({
      symbol: display(c.qualname),
      qualname: c.qualname,
      kind: c.kind,
      change: c.change as BreakingChange['change'],
      reasons,
      ...(c.change === 'signature' ? { params: [...new Set(reasons.flatMap((r) => [...r.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)))] } : {}),
      path: c.path,
      line: c.lineno,
      ...(c.before ? { before: c.before } : {}),
      ...(c.after ? { after: c.after } : {}),
      ...(c.renamedTo ? { renamedTo: display(c.renamedTo) } : {}),
      mentioned: false,
    });
  }
  // A removed class takes its members with it: report the class once.
  const goneClasses = new Set(breaking.filter((b) => b.kind === 'class' && (b.change === 'removed' || b.change === 'renamed')).map((b) => b.qualname));
  const listed = breaking.filter((b) => !goneClasses.has(parentOf(b.qualname)));

  // The changelog at the new commit (or on disk, when checking HEAD with uncommitted notes).
  const changelog: ReleaseReport['changelog'] = {};
  const at = async (path: string) => git(root, ['show', `${toSha}:${path}`]).catch(() => undefined);
  const path = opts.changelog ?? (await (async () => {
    for (const p of CHANGELOG_FILES) if ((await at(p)) !== undefined || (!opts.to && existsSync(join(root, p)))) return p;
    return undefined;
  })());
  let text = path ? await at(path) : undefined;
  if (path && !opts.to && existsSync(join(root, path))) {
    const disk = await readFile(join(root, path), 'utf8');
    if (disk !== text) {
      text = disk;
      changelog.source = 'working tree';
    }
  }
  if (path && text === undefined) {
    if (opts.changelog) throw new Error(`${opts.changelog} is not in ${toRef}`);
  }
  let body = '';
  if (path && text !== undefined) {
    changelog.path = path;
    changelog.source ??= 'commit';
    const toTags = await tagsAt(root, toSha);
    const version = (toRef !== 'HEAD' ? tagVersion(toRef) : undefined) ?? toTags.map(tagVersion).find(Boolean);
    const sec = releaseSection(text, { rst: /\.rst$/i.test(path), version, previousVersion: tagVersion(from.ref) });
    if (sec.section) changelog.section = sec.section;
    else changelog.why = `${path}: ${sec.why}`;
    body = sec.body;
  } else {
    changelog.why = `no changelog at ${toRef} (looked for ${CHANGELOG_FILES.slice(0, 4).join(', ')}, …; --changelog names one)`;
  }
  for (const b of listed) {
    const m = changelog.section ? mentionIn(body, { ...b, name: last(b.qualname) }) : undefined;
    b.mentioned = !!m;
    if (m) b.mentionedAs = m;
  }

  // Docs at the new commit that still call or name what changed.
  const byQualname = new Map(listed.map((b) => [b.qualname, b]));
  for (const b of breaking) if (!byQualname.has(b.qualname)) byQualname.set(b.qualname, listed.find((x) => b.qualname.startsWith(`${x.qualname}.`)) ?? b);
  // Only references the release broke: one already wrong at the old commit is not this release's doing.
  const fresh = newFindings(fromLint, toLint);
  const staleDocs: StaleReference[] = [];
  for (const f of fresh) {
    const hit = findingTargets(f).map((t) => byQualname.get(t)).find(Boolean);
    if (hit) staleDocs.push({ symbol: hit.symbol, finding: f });
  }

  const lint = {
    findings: toLint.findings,
    newSinceFrom: fresh.map((f) => f.fingerprint),
    errors: toLint.summary.errors,
    // Errors the release introduced besides the stale references above.
    newErrors: fresh.filter((f) => f.severity === 'error' && !staleDocs.some((x) => x.finding === f)).length,
    files: toLint.summary.files,
  };
  const undocumented = listed.filter((b) => !b.mentioned).length;
  const failed = failOn.filter((g) => (g === 'undocumented-breaking' ? undocumented > 0 : staleDocs.length > 0 || lint.newErrors > 0));
  return {
    version: 1,
    repo,
    from,
    to: { ref: toRef, sha: toSha },
    changelog,
    breaking: listed,
    undocumented,
    compatible,
    staleDocs,
    lint,
    failOn,
    failed,
    ms: Date.now() - started,
  };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const short = (r: { ref: string; sha: string }) => (r.ref === r.sha || r.sha.startsWith(r.ref) ? r.sha.slice(0, 7) : `${r.ref} (${r.sha.slice(0, 7)})`);

function changelogLine(r: ReleaseReport): string {
  const c = r.changelog;
  if (!c.section) return `Changelog: ${c.why}`;
  const which = c.section.kind === 'unreleased' ? 'the Unreleased section' : c.section.kind === 'version' ? 'the section for this version' : 'the top section';
  return `Changelog: ${c.path}${c.source === 'working tree' ? ' (working tree, uncommitted)' : ''}, ${which} "${c.section.heading}" (line ${c.section.line})`;
}

/** One sentence: what failed, or that the gate passes. */
export function releaseVerdict(r: ReleaseReport): string {
  const why: string[] = [];
  if (r.undocumented) why.push(`${plural(r.undocumented, 'breaking change')} ${r.undocumented === 1 ? 'is' : 'are'} not in the changelog`);
  if (r.staleDocs.length) why.push(`${plural(r.staleDocs.length, 'docs reference')} still rel${r.staleDocs.length === 1 ? 'ies' : 'y'} on what changed`);
  if (r.lint.newErrors) why.push(`${plural(r.lint.newErrors, `${r.staleDocs.length ? 'other ' : ''}new error`)} in the docs references`);
  const gates = r.failOn.length ? r.failOn.join(',') : 'never';
  if (r.failed.length) return `Release gate (--fail-on ${gates}): fails: ${why.join('; ')}.`;
  return why.length ? `Release gate (--fail-on ${gates}): passes, with ${why.join('; ')}.` : `Release gate (--fail-on ${gates}): passes.`;
}

const where = (f: Finding) => `${f.path}:${f.line}`;

export function releaseText(r: ReleaseReport): string {
  const out = [`Release ${r.repo}: ${short(r.from)} → ${short(r.to)} (from: ${r.from.why})`, changelogLine(r), ''];
  out.push(`Breaking API changes (${r.breaking.length})${r.compatible ? `; ${plural(r.compatible, 'other public signature')} changed compatibly` : ''}`);
  if (!r.breaking.length) out.push('  none: every public symbol of the old commit is still there and accepts the calls it accepted');
  for (const b of r.breaking) {
    out.push(`  ${b.mentioned ? '✓' : '✗'} ${b.symbol}: ${b.reasons.join('; ')}  ${b.mentioned ? `(changelog: "${b.mentionedAs}")` : '(not in the changelog)'}`);
  }
  out.push('', `Docs still relying on them (${r.staleDocs.length})`);
  for (const s of r.staleDocs) out.push(`  ${where(s.finding)}  ${s.finding.message} [${s.finding.rule}]`);
  const fresh = new Set(r.lint.newSinceFrom);
  out.push('', `Docs references at ${short(r.to)}: ${plural(r.lint.findings.length, 'finding')} in ${plural(r.lint.files, 'file')} checked, ${fresh.size} new since ${short(r.from)}`);
  for (const f of r.lint.findings.filter((x) => fresh.has(x.fingerprint)).slice(0, 50)) out.push(`  ${where(f)}  ${f.severity}  ${f.message} [${f.rule}] (new)`);
  out.push('', releaseVerdict(r));
  return out.join('\n');
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function releaseMarkdown(r: ReleaseReport): string {
  const out = [`<!-- staleproof-release -->`, `### Staleproof release gate: ${r.repo} ${short(r.from)} → ${short(r.to)}`, '', releaseVerdict(r), '', changelogLine(r), ''];
  out.push(`#### Breaking API changes (${r.breaking.length})`, '');
  if (r.breaking.length) {
    out.push('| Symbol | Change | In the changelog |', '|---|---|---|');
    for (const b of r.breaking) out.push(`| \`${esc(b.symbol)}\` | ${esc(b.reasons.join('; '))} | ${b.mentioned ? `yes ("${esc(b.mentionedAs ?? '')}")` : '**no**'} |`);
  } else out.push('None: every public symbol of the old commit is still there and accepts the calls it accepted.');
  if (r.compatible) out.push('', `${plural(r.compatible, 'other public signature')} changed without rejecting earlier calls.`);
  out.push('');
  if (r.staleDocs.length) {
    out.push(`#### Docs still relying on them (${r.staleDocs.length})`, '', '| Where | Problem | Change |', '|---|---|---|');
    for (const s of r.staleDocs) out.push(`| ${s.finding.evidence?.url ? `[${where(s.finding)}](${s.finding.evidence.url})` : `\`${where(s.finding)}\``} | ${esc(s.finding.message)} | \`${esc(s.symbol)}\` |`);
    out.push('');
  }
  const fresh = r.lint.findings.filter((f) => r.lint.newSinceFrom.includes(f.fingerprint));
  out.push(`#### Docs references at ${short(r.to)}: ${plural(r.lint.findings.length, 'finding')}, ${fresh.length} new since ${short(r.from)}`, '');
  if (fresh.length) {
    out.push('| Where | Problem | Rule |', '|---|---|---|');
    for (const f of fresh.slice(0, 50)) out.push(`| \`${where(f)}\` | ${esc(f.message)} | ${f.rule} |`);
    out.push('');
  }
  out.push(`<sub>[Staleproof](https://github.com/rajkaria/staleproof) · ${r.from.sha.slice(0, 7)}..${r.to.sha.slice(0, 7)}</sub>`);
  out.push(`<!-- staleproof:release breaking=${r.breaking.length} undocumented=${r.undocumented} stale=${r.staleDocs.length} findings=${r.lint.findings.length} new-errors=${r.lint.newErrors} failed=${r.failed.length} -->`);
  return out.join('\n');
}

export function formatRelease(r: ReleaseReport, format: ReleaseFormat): string {
  return format === 'json' ? JSON.stringify(r, null, 2) : format === 'markdown' ? releaseMarkdown(r) : releaseText(r);
}

/** `--fail-on`: a comma- or space-separated list of gates, or `never`. */
export function parseFailOn(value: string | undefined): ReleaseGate[] {
  if (value === undefined) return RELEASE_GATES;
  const parts = value.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 1 && parts[0] === 'never') return [];
  const bad = parts.filter((p) => !RELEASE_GATES.includes(p as ReleaseGate));
  if (bad.length || !parts.length) throw new Error(`--fail-on takes ${RELEASE_GATES.join(', ')} (comma-separated) or never; got ${value}`);
  return parts as ReleaseGate[];
}

export interface ReleaseCommandOptions {
  dir?: string;
  from?: string;
  to?: string;
  changelog?: string;
  failOn?: string;
  format?: string;
  out?: string;
  repo?: string;
  log?: (message: string) => void;
}

/** `staleproof release`: the report and the exit code (0 passes, 1 a gate fails, 2 usage or internal error). */
export async function runReleaseCommand(opts: ReleaseCommandOptions): Promise<{ output: string; exitCode: number; report?: ReleaseReport }> {
  const log = opts.log ?? (() => {});
  try {
    const format = (opts.format ?? 'text') as ReleaseFormat;
    if (!RELEASE_FORMATS.includes(format)) throw new Error(`unknown --format ${opts.format} (${RELEASE_FORMATS.join(', ')})`);
    const failOn = parseFailOn(opts.failOn);
    const report = await releaseReport({ dir: opts.dir ?? '.', from: opts.from, to: opts.to, changelog: opts.changelog, failOn, repo: opts.repo, log });
    const body = formatRelease(report, format);
    if (opts.out) {
      await writeFile(opts.out, `${body}\n`);
      log(`wrote ${opts.out}: ${releaseVerdict(report)}`);
      return { output: '', exitCode: report.failed.length ? 1 : 0, report };
    }
    return { output: body, exitCode: report.failed.length ? 1 : 0, report };
  } catch (err) {
    log(`staleproof release: ${(err as Error).message}`);
    return { output: '', exitCode: 2 };
  }
}
