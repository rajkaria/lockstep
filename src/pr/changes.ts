import { extractPython, type DefKind, type PyDef, type PyModule } from '../indexer/python.js';
import { classifyFile, git, moduleNames } from '../indexer/repo.js';
import type { PullRequestInfo } from './github.js';

export type ChangeKind = 'removed' | 'renamed' | 'signature' | 'modified' | 'added' | 'export-removed';

export interface ChangedSymbol {
  repo: string;
  qualname: string;
  name: string;
  kind: DefKind;
  change: ChangeKind;
  /** Signature before the PR (absent when added). */
  before?: string;
  /** Signature after the PR (absent when removed). */
  after?: string;
  renamedTo?: string;
  /** For `export-removed`: the definition the vanished export pointed at. */
  exportTarget?: string;
  path: string;
  lineno: number;
  endLineno: number;
  doc?: string;
}

export interface ChangedFile {
  status: string;
  path: string;
  oldPath?: string;
}

export interface PrDiff {
  before: string;
  after: string;
  files: ChangedFile[];
  symbols: ChangedSymbol[];
  /** Markdown files the PR itself touched (docs already updated in the same PR). */
  docsTouched: string[];
}

/** Make sure a commit is present in a blob-less clone. */
async function ensureCommit(dir: string, sha: string, fallbackRef?: string): Promise<void> {
  try {
    await git(dir, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    try {
      await git(dir, ['fetch', '--quiet', 'origin', sha]);
    } catch (err) {
      if (!fallbackRef) throw err;
      await git(dir, ['fetch', '--quiet', 'origin', fallbackRef]);
    }
  }
}

/** The commits a PR changed the code between: merged → (first parent, merge commit); open → (merge base, head). */
export async function prRange(dir: string, pr: PullRequestInfo): Promise<{ before: string; after: string }> {
  if (pr.mergeSha) {
    await ensureCommit(dir, pr.mergeSha);
    const parents = (await git(dir, ['rev-list', '--parents', '-n', '1', pr.mergeSha])).trim().split(/\s+/);
    if (parents.length < 2) throw new Error(`merge commit ${pr.mergeSha} has no parent`);
    return { before: parents[1]!, after: pr.mergeSha };
  }
  await ensureCommit(dir, pr.headSha, `pull/${pr.number}/head`);
  await ensureCommit(dir, pr.baseSha);
  const base = (await git(dir, ['merge-base', pr.baseSha, pr.headSha])).trim();
  return { before: base, after: pr.headSha };
}

export async function diffPullRequest(dir: string, repo: string, pr: PullRequestInfo): Promise<PrDiff> {
  const range = await prRange(dir, pr);
  return diffRange(dir, repo, range.before, range.after);
}

/** Where a diff reads commits from: a local clone (git) or the GitHub API (serverless). */
export interface DiffSource {
  changedFiles(before: string, after: string): Promise<ChangedFile[]>;
  /** Every path in the tree at a commit. */
  files(sha: string): Promise<string[]>;
  read(sha: string, path: string): Promise<string | undefined>;
  hunks(before: string, after: string, oldPath: string, path: string): Promise<Hunks | undefined>;
}

export function gitSource(dir: string): DiffSource {
  return {
    changedFiles: async (before, after) => parseNameStatus(await git(dir, ['diff', '--name-status', '-M', '-z', before, after])),
    files: async (sha) => (await git(dir, ['ls-tree', '-r', '--name-only', sha])).split('\n').filter(Boolean),
    read: (sha, path) => show(dir, sha, path),
    hunks: async (before, after, oldPath, path) => parseHunks(await git(dir, ['diff', '-U0', before, after, '--', oldPath, path])),
  };
}

/** Symbol-level diff between two commits of one repository (local clone). */
export async function diffRange(dir: string, repo: string, before: string, after: string): Promise<PrDiff> {
  return diffWith(gitSource(dir), repo, before, after);
}

/** Symbol-level diff between two commits, reading through any source. */
export async function diffWith(source: DiffSource, repo: string, before: string, after: string): Promise<PrDiff> {
  const files = await source.changedFiles(before, after);
  const docsTouched = files.filter((f) => classifyFile(f.path) === 'markdown').map((f) => f.path);
  const pyChanged = files.filter((f) => classifyFile(f.path) === 'python' || (f.oldPath && classifyFile(f.oldPath) === 'python'));
  if (pyChanged.length === 0) return { before, after, files, symbols: [], docsTouched };

  const pyAt = async (sha: string) => (await source.files(sha)).filter((p) => classifyFile(p) === 'python');
  const namesBefore = moduleNames(await pyAt(before));
  const namesAfter = moduleNames(await pyAt(after));

  const symbols: ChangedSymbol[] = [];
  for (const f of pyChanged) {
    const oldPath = f.oldPath ?? f.path;
    const oldSrc = f.status.startsWith('A') ? undefined : await source.read(before, oldPath);
    const newSrc = f.status.startsWith('D') ? undefined : await source.read(after, f.path);
    const oldMeta = namesBefore.get(oldPath);
    const newMeta = namesAfter.get(f.path);
    const oldMod = oldSrc !== undefined && oldMeta ? await extractPython(oldSrc, { module: oldMeta.module, path: oldPath, isPackage: oldMeta.isPackage }) : undefined;
    const newMod = newSrc !== undefined && newMeta ? await extractPython(newSrc, { module: newMeta.module, path: f.path, isPackage: newMeta.isPackage }) : undefined;
    const hunks = oldMod && newMod ? await source.hunks(before, after, oldPath, f.path) : undefined;
    symbols.push(...compareModules(repo, oldMod, newMod, hunks, { old: oldSrc, new: newSrc }));
  }
  return { before, after, files, symbols, docsTouched };
}

async function show(dir: string, sha: string, path: string): Promise<string | undefined> {
  try {
    return await git(dir, ['show', `${sha}:${path}`]);
  } catch {
    return undefined;
  }
}

export function parseNameStatus(raw: string): ChangedFile[] {
  const parts = raw.split('\0').filter(Boolean);
  const out: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]!;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[i++]!;
      const path = parts[i++]!;
      out.push({ status, path, oldPath });
    } else {
      out.push({ status, path: parts[i++]! });
    }
  }
  return out;
}

export interface Hunks {
  /** Changed line ranges on the old side (1-based, inclusive). */
  old: [number, number][];
  new: [number, number][];
}

/**
 * Exact changed lines from a diff that carries context lines (GitHub's `patch`
 * field uses 3): context is skipped, so a neighbouring definition is not flagged.
 */
export function changedLinesFromPatch(patch: string): Hunks {
  const h: Hunks = { old: [], new: [] };
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      continue;
    }
    if (line.startsWith('-')) h.old.push([oldLine, oldLine]), oldLine++;
    else if (line.startsWith('+')) h.new.push([newLine, newLine]), newLine++;
    else if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    else oldLine++, newLine++;
  }
  return h;
}

export function parseHunks(diff: string): Hunks {
  const h: Hunks = { old: [], new: [] };
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [os, oc, ns, nc] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    if (oc > 0) h.old.push([os, os + oc - 1]);
    if (nc > 0) h.new.push([ns, ns + nc - 1]);
    // A pure insertion/deletion still touches the line it sits at.
    if (oc === 0) h.old.push([os, os]);
    if (nc === 0) h.new.push([ns, ns]);
  }
  return h;
}

/**
 * Whether a changed line belongs to the def itself — not to a nested def (so a
 * method's change doesn't flag its class) and not blank or comment-only.
 */
function ownLinesTouched(def: PyDef, all: PyDef[], ranges: [number, number][], lines?: string[]): boolean {
  const children = all.filter((d) => d.parent === def.qualname && d.kind !== 'module');
  for (const [a, b] of ranges) {
    for (let line = Math.max(a, def.lineno); line <= Math.min(b, def.endLineno); line++) {
      if (children.some((c) => line >= c.lineno && line <= c.endLineno)) continue;
      const text = lines?.[line - 1];
      if (text !== undefined && /^\s*(#.*)?$/.test(text)) continue;
      return true;
    }
  }
  return false;
}

export function compareModules(
  repo: string,
  oldMod: PyModule | undefined,
  newMod: PyModule | undefined,
  hunks?: Hunks,
  sources: { old?: string; new?: string } = {},
): ChangedSymbol[] {
  const oldLines = sources.old?.split('\n');
  const newLines = sources.new?.split('\n');
  const oldDefs = new Map((oldMod?.defs ?? []).filter((d) => d.kind !== 'module').map((d) => [d.qualname, d]));
  const newDefs = new Map((newMod?.defs ?? []).filter((d) => d.kind !== 'module').map((d) => [d.qualname, d]));
  const out: ChangedSymbol[] = [];
  const path = newMod?.path ?? oldMod?.path ?? '';

  const removed = [...oldDefs.values()].filter((d) => !newDefs.has(d.qualname));
  const added = [...newDefs.values()].filter((d) => !oldDefs.has(d.qualname));
  const renamedTargets = new Set<string>();

  for (const d of removed) {
    // A removed def plus an added def of the same kind, parent and parameters reads as a rename.
    const twin = added.find(
      (a) =>
        !renamedTargets.has(a.qualname) &&
        a.kind === d.kind &&
        a.parent === d.parent &&
        paramsKey(a) === paramsKey(d),
    );
    if (twin) renamedTargets.add(twin.qualname);
    out.push({
      repo,
      qualname: d.qualname,
      name: d.name,
      kind: d.kind,
      change: twin ? 'renamed' : 'removed',
      before: d.signature,
      after: twin?.signature,
      renamedTo: twin?.qualname,
      path: oldMod?.path ?? path,
      lineno: d.lineno,
      endLineno: d.endLineno,
      doc: d.doc,
    });
  }
  for (const a of added) {
    if (renamedTargets.has(a.qualname)) continue;
    out.push({ repo, qualname: a.qualname, name: a.name, kind: a.kind, change: 'added', after: a.signature, path, lineno: a.lineno, endLineno: a.endLineno, doc: a.doc });
  }
  for (const [q, n] of newDefs) {
    const o = oldDefs.get(q);
    if (!o) continue;
    if (o.signature !== n.signature || o.decorators.join() !== n.decorators.join()) {
      out.push({ repo, qualname: q, name: n.name, kind: n.kind, change: 'signature', before: o.signature, after: n.signature, path, lineno: n.lineno, endLineno: n.endLineno, doc: n.doc });
    } else if (
      hunks &&
      (ownLinesTouched(n, newMod!.defs, hunks.new, newLines) || ownLinesTouched(o, oldMod!.defs, hunks.old, oldLines))
    ) {
      out.push({ repo, qualname: q, name: n.name, kind: n.kind, change: 'modified', before: o.signature, after: n.signature, path, lineno: n.lineno, endLineno: n.endLineno, doc: n.doc });
    }
  }
  // Package re-exports that disappeared: `from falkordb import X` stops working even if X still exists.
  if (oldMod && newMod) {
    const newAliases = new Set(newMod.imports.map((i) => i.alias));
    for (const imp of oldMod.imports) {
      if (imp.alias === '*' || newAliases.has(imp.alias) || newDefs.has(`${newMod.module}.${imp.alias}`)) continue;
      if (!imp.target.startsWith(`${oldMod.module.split('.')[0]}.`)) continue; // only the package's own names
      out.push({
        repo,
        qualname: `${oldMod.module}.${imp.alias}`,
        name: imp.alias,
        kind: 'module',
        change: 'export-removed',
        before: `from ${oldMod.module} import ${imp.alias}`,
        exportTarget: imp.target,
        path: oldMod.path,
        lineno: imp.lineno,
        endLineno: imp.lineno,
      });
    }
  }
  return out.sort((a, b) => a.qualname.localeCompare(b.qualname));
}

function paramsKey(d: PyDef): string {
  return d.params.map((p) => `${p.name}:${p.annotation ?? ''}`).join(',') + `->${d.returns ?? ''}`;
}
