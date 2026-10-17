import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { diffArrays, structuredPatch } from 'diff';
import { scanDoc } from '../indexer/markdown.js';
import { gitEnv } from '../indexer/repo.js';
import { workingFiles } from './engine.js';
import { gitRoot, subdirOf, type LintTree } from './sources.js';

/**
 * What was renamed between two states of a repository (a PR's base and head, the last
 * commit and the working tree): files (git rename detection, else identical content or a
 * unique file name), names in code and config (a line whose only change is one name: a
 * script, a Make target, a flag, an env var, a function, a parameter), and heading anchors.
 * A reference to the old name is fixed by writing the new one; verification decides.
 */
export interface Renames {
  /** Repository-relative old path → new path (files, and directories every moved file agrees on). */
  files: Map<string, string>;
  /** Old name → the new names it became (more than one: ambiguous). */
  names: Map<string, Set<string>>;
  /** Docs page → old anchor → new anchors. */
  anchors: Map<string, Map<string, Set<string>>>;
}

export function emptyRenames(): Renames {
  return { files: new Map(), names: new Map(), anchors: new Map() };
}

const exec = promisify(execFile);
const DOC = /\.(md|mdx|markdown|rst)$/i;
const MD = /\.(md|mdx|markdown)$/i;
/** Lock files, minified and generated files: their changes are not renames anyone wrote. */
const NOISE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.map$|(^|\/)(node_modules|dist|build|vendor)\//;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|wasm|so|dylib|dll|exe|bin|pyc|class|jar)$/i;
const MAX_TEXT = 512 * 1024;
const MAX_COMPARED = 20_000;

/** A run of name characters: identifiers, script names (`lint:docs`), flags (`--force-all`), paths. */
const NAME_RUN = /[A-Za-z0-9_$@:./-]+/g;
const EDGE = /^[:./]+|[:./]+$/g;

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function addName(map: Map<string, Set<string>>, from: string, to: string): void {
  if (!from || !to || from === to) return;
  const set = map.get(from) ?? new Set<string>();
  set.add(to);
  map.set(from, set);
}

/** Tokens of one line: runs of name characters, and every other non-space character on its own. */
function tokens(line: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (const m of line.matchAll(NAME_RUN)) {
    for (const ch of line.slice(at, m.index).replace(/\s+/g, '')) out.push(ch);
    out.push(m[0]);
    at = m.index! + m[0].length;
  }
  for (const ch of line.slice(at).replace(/\s+/g, '')) out.push(ch);
  return out;
}

/** Record `from` → `to`, with its edges trimmed (`lint-docs:` → `lint-docs`) and the one identifier part that changed. */
function recordToken(map: Map<string, Set<string>>, from: string, to: string): void {
  const a = from.replace(EDGE, '');
  const b = to.replace(EDGE, '');
  if (!a || !b || a === b || /^[\d.]+$/.test(a) || /^[\d.]+$/.test(b)) return;
  addName(map, a, b);
  const pa = a.split(/[^A-Za-z0-9_$]+/);
  const pb = b.split(/[^A-Za-z0-9_$]+/);
  if (pa.length > 1 && pa.length === pb.length) {
    const diff = pa.map((p, i) => [p, pb[i]!] as const).filter(([p, q]) => p !== q);
    if (diff.length === 1 && diff[0]![0] && diff[0]![1]) addName(map, diff[0]![0], diff[0]![1]);
  }
}

/** Similarity of two lines: the share of the longer one their common prefix and suffix cover. */
function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  let p = 0;
  while (p < Math.min(a.length, b.length) && a[p] === b[p]) p++;
  let s = 0;
  while (s < Math.min(a.length, b.length) - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return (p + s) / max;
}

/** Pairs of a removed and an added line that are the same line with names changed. */
function linePairs(oldText: string, newText: string): [string, string][] {
  const patch = structuredPatch('a', 'b', oldText, newText, '', '', { context: 0 });
  const out: [string, string][] = [];
  for (const h of patch.hunks) {
    const removed = h.lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
    const added = h.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
    if (!removed.length || !added.length) continue;
    if (removed.length === added.length) {
      removed.forEach((r, i) => out.push([r, added[i]!]));
      continue;
    }
    const used = new Set<number>();
    for (const r of removed) {
      let best = -1;
      let score = 0.5;
      added.forEach((a, i) => {
        const s = similarity(r, a);
        if (!used.has(i) && s >= score) {
          score = s;
          best = i;
        }
      });
      if (best >= 0) {
        used.add(best);
        out.push([r, added[best]!]);
      }
    }
  }
  return out;
}

/** Names renamed between two versions of a code or config file. */
export function nameRenames(oldText: string, newText: string, into: Map<string, Set<string>> = new Map()): Map<string, Set<string>> {
  for (const [r, a] of linePairs(oldText, newText)) {
    const tr = tokens(r);
    const ta = tokens(a);
    if (tr.length > 400 || ta.length > 400) continue;
    const parts = diffArrays(tr, ta);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      const q = parts[i + 1];
      // One token replaced by one token, the rest of the line the same around it.
      if (p.removed && q?.added && p.value.length === 1 && q.value.length === 1) {
        recordToken(into, p.value[0]!, q.value[0]!);
        i++;
      } else if (p.added && q?.removed && p.value.length === 1 && q.value.length === 1) {
        recordToken(into, q.value[0]!, p.value[0]!);
        i++;
      }
    }
  }
  return into;
}

/** Heading anchors renamed between two versions of a Markdown page. */
export function anchorRenames(path: string, oldText: string, newText: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const before = new Set(scanDoc(path, oldText).sections.map((s) => s.anchor.toLowerCase()).filter(Boolean));
  const after = new Set(scanDoc(path, newText).sections.map((s) => s.anchor.toLowerCase()).filter(Boolean));
  const removed = [...before].filter((a) => !after.has(a));
  const added = [...after].filter((a) => !before.has(a));
  if (!removed.length || !added.length) return out;
  if (removed.length === 1 && added.length === 1) {
    out.set(removed[0]!, new Set([added[0]!]));
    return out;
  }
  // Several headings changed: pair the heading lines the edit changed.
  const slug = (line: string) => scanDoc(path, `${line}\n`).sections.find((s) => s.anchor)?.anchor.toLowerCase();
  for (const [r, a] of linePairs(oldText, newText)) {
    if (!/^\s{0,3}#{1,6}\s/.test(r) || !/^\s{0,3}#{1,6}\s/.test(a)) continue;
    const from = slug(r);
    const to = slug(a);
    if (from && to && removed.includes(from) && added.includes(to)) addName(out, from, to);
  }
  return out;
}

async function readText(dir: string, path: string): Promise<string | undefined> {
  try {
    const s = await stat(join(dir, path));
    if (!s.isFile() || s.size > MAX_TEXT) return undefined;
    return await readFile(join(dir, path), 'utf8');
  } catch {
    return undefined;
  }
}

async function treeFiles(tree: LintTree): Promise<string[]> {
  return tree.paths ?? (await workingFiles(tree.dir));
}

interface Changes {
  modified: string[];
  renamed: [string, string][];
}

/** Base and head in one git repository: `git diff -M` from the base commit to head's files. */
async function gitChanges(base: LintTree, head: LintTree): Promise<Changes | undefined> {
  if (!base.sha) return undefined;
  const root = await gitRoot(head.dir);
  if (!root || !existsSync(join(root, '.git'))) return undefined;
  // `/var` and `/private/var` are one folder on macOS: compare real paths.
  const sub = subdirOf(await realpath(root).catch(() => root), await realpath(head.dir).catch(() => head.dir));
  if (sub.startsWith('..')) return undefined;
  const strip = (p: string) => (sub ? (p.startsWith(`${sub}/`) ? p.slice(sub.length + 1) : undefined) : p);
  let out: string;
  try {
    ({ stdout: out } = await exec('git', ['--no-optional-locks', 'diff', '-M', '--name-status', '-z', base.sha, '--'], { cwd: root, env: gitEnv(), maxBuffer: 64 << 20 }));
  } catch {
    return undefined;
  }
  const parts = out.split('\0');
  const changes: Changes = { modified: [], renamed: [] };
  const deleted: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = strip(parts[++i]!);
      const to = strip(parts[++i]!);
      if (from && to && status.startsWith('R')) changes.renamed.push([from, to]);
    } else {
      const p = strip(parts[++i]!);
      if (!p) continue;
      if (status === 'M' || status === 'T') changes.modified.push(p);
      else if (status === 'D') deleted.push(p);
    }
  }
  // `git diff` does not see new untracked files: pair a deleted file with the one untracked file of its name.
  if (deleted.length && !head.temporary) {
    const untracked = (await exec('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root, env: gitEnv(), maxBuffer: 64 << 20 }).catch(() => ({ stdout: '' }))).stdout
      .split('\0')
      .map((p) => (p ? strip(p) : undefined))
      .filter((p): p is string => !!p);
    for (const d of deleted) {
      const same = untracked.filter((u) => posix.basename(u) === posix.basename(d));
      if (same.length === 1) changes.renamed.push([d, same[0]!]);
    }
  }
  return changes;
}

/** Base and head as plain folders (tarballs): compare file lists and contents. */
async function folderChanges(base: LintTree, head: LintTree): Promise<Changes> {
  const [b, h] = await Promise.all([treeFiles(base), treeFiles(head)]);
  const hs = new Set(h);
  const bs = new Set(b);
  const changes: Changes = { modified: [], renamed: [] };
  const common = b.filter((p) => hs.has(p) && !BINARY.test(p) && !NOISE.test(p)).slice(0, MAX_COMPARED);
  for (const p of common) {
    const [x, y] = await Promise.all([readText(base.dir, p), readText(head.dir, p)]);
    if (x !== undefined && y !== undefined && x !== y) changes.modified.push(p);
  }
  const deleted = b.filter((p) => !hs.has(p) && !BINARY.test(p));
  const added = h.filter((p) => !bs.has(p) && !BINARY.test(p));
  if (deleted.length && added.length && deleted.length * added.length <= 4_000_000) {
    const byHash = new Map<string, string[]>();
    for (const a of added.slice(0, MAX_COMPARED)) {
      const t = await readText(head.dir, a);
      if (t === undefined) continue;
      const k = sha1(t);
      byHash.set(k, [...(byHash.get(k) ?? []), a]);
    }
    const taken = new Set<string>();
    for (const d of deleted.slice(0, MAX_COMPARED)) {
      const t = await readText(base.dir, d);
      const same = t === undefined ? [] : (byHash.get(sha1(t)) ?? []).filter((a) => !taken.has(a));
      let to = same.length === 1 ? same[0] : undefined;
      if (!to) {
        const named = added.filter((a) => posix.basename(a) === posix.basename(d) && !taken.has(a));
        if (named.length === 1) to = named[0];
      }
      if (to) {
        taken.add(to);
        changes.renamed.push([d, to]);
      }
    }
  }
  return changes;
}

/** Directory renames every moved file agrees on (`src/old/` → `src/new/`). */
function directoryRenames(files: [string, string][]): Map<string, string> {
  const votes = new Map<string, Set<string>>();
  for (const [from, to] of files) {
    const a = from.split('/');
    const b = to.split('/');
    let k = 0;
    while (k < Math.min(a.length, b.length) - 1 && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
    if (k === 0) continue;
    const da = a.slice(0, a.length - k).join('/');
    const db = b.slice(0, b.length - k).join('/');
    if (!da || !db || da === db) continue;
    const set = votes.get(da) ?? new Set<string>();
    set.add(db);
    votes.set(da, set);
  }
  const out = new Map<string, string>();
  for (const [from, to] of votes) if (to.size === 1) out.set(from, [...to][0]!);
  return out;
}

/** Renames between `base` and `head` (see `Renames`). */
export async function detectRenames(base: LintTree, head: LintTree): Promise<Renames> {
  const renames = emptyRenames();
  const changes = (await gitChanges(base, head)) ?? (await folderChanges(base, head));
  for (const [from, to] of changes.renamed) renames.files.set(from, to);
  for (const [from, to] of directoryRenames(changes.renamed)) if (!renames.files.has(from)) renames.files.set(from, to);
  const pairs: [string, string][] = [...changes.modified.map((p) => [p, p] as [string, string]), ...changes.renamed];
  for (const [from, to] of pairs.slice(0, MAX_COMPARED)) {
    if (NOISE.test(to) || BINARY.test(to)) continue;
    const [x, y] = await Promise.all([readText(base.dir, from), readText(head.dir, to)]);
    if (x === undefined || y === undefined || x === y) continue;
    if (DOC.test(to)) {
      if (MD.test(to)) {
        const a = anchorRenames(to, x, y);
        if (a.size) renames.anchors.set(to, a);
      }
      continue;
    }
    nameRenames(x, y, renames.names);
  }
  return renames;
}

/** The one name `name` was renamed to, or undefined (not renamed, or renamed to several). */
export function renamedTo(renames: Renames | undefined, name: string): string | undefined {
  if (!renames) return undefined;
  const direct = renames.names.get(name);
  if (direct) return direct.size === 1 ? [...direct][0] : undefined;
  // click and typer derive `sync-all` from `def sync_all`: the code's rename is in underscores.
  if (name.includes('-') && !name.startsWith('-')) {
    const under = renames.names.get(name.replace(/-/g, '_'));
    if (under?.size === 1) return [...under][0]!.replace(/_/g, '-');
  }
  return undefined;
}

/** Where a renamed file (or a file under a renamed directory) lives now. */
export function fileRenamedTo(renames: Renames | undefined, path: string): string | undefined {
  if (!renames) return undefined;
  const p = path.replace(/\/+$/, '');
  const direct = renames.files.get(p);
  if (direct) return direct;
  let best: string | undefined;
  for (const from of renames.files.keys()) if (p.startsWith(`${from}/`) && (!best || from.length > best.length)) best = from;
  return best ? `${renames.files.get(best)}${p.slice(best.length)}` : undefined;
}
