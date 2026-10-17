import { extractPython, type DefKind, type PyDef, type PyModule } from '../indexer/python.js';
import { extractTs } from '../indexer/typescript.js';
import { extractGoFile, parseGoPackages } from '../indexer/go.js';
import { readManifest, relativeResolver, tsModuleNames, type NpmPackage, type TsModuleName } from '../indexer/tsmodules.js';
import { classifyFile, git, moduleNames, pythonSourceRoots } from '../indexer/repo.js';
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
  const tsChanged = files.filter((f) => classifyFile(f.path) === 'typescript' || (f.oldPath && classifyFile(f.oldPath) === 'typescript'));
  const goChanged = files.filter((f) => classifyFile(f.path) === 'go' || (f.oldPath && classifyFile(f.oldPath) === 'go'));
  const otherSymbols: ChangedSymbol[] = [
    ...(tsChanged.length ? await diffTs(source, repo, before, after, tsChanged) : []),
    ...(goChanged.length ? await diffGo(source, repo, before, after, goChanged) : []),
  ];
  const symbols: ChangedSymbol[] = [];
  if (pyChanged.length === 0) return { before, after, files, symbols: otherSymbols, docsTouched };

  // Module names as the index gives them: the commit's own Python projects decide the source roots.
  const pyAt = async (sha: string) => {
    const all = await source.files(sha);
    return moduleNames(all.filter((p) => classifyFile(p) === 'python'), pythonSourceRoots(all));
  };
  const namesBefore = await pyAt(before);
  const namesAfter = await pyAt(after);

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
  return { before, after, files, symbols: [...symbols, ...otherSymbols], docsTouched };
}

/** TypeScript/JavaScript module names at a commit, from the package manifests there. */
async function tsNamesAt(source: DiffSource, sha: string): Promise<Map<string, TsModuleName>> {
  const all = await source.files(sha);
  const packages: NpmPackage[] = [];
  for (const path of all.filter((p) => /(^|\/)package\.json$/.test(p) && !/(^|\/)node_modules\//.test(p))) {
    const text = await source.read(sha, path);
    const pkg = text ? readManifest(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', text) : undefined;
    if (pkg) packages.push(pkg);
  }
  return tsModuleNames(all.filter((p) => classifyFile(p) === 'typescript'), packages);
}

async function diffTs(source: DiffSource, repo: string, before: string, after: string, changed: ChangedFile[]): Promise<ChangedSymbol[]> {
  const [namesBefore, namesAfter] = await Promise.all([tsNamesAt(source, before), tsNamesAt(source, after)]);
  const out: ChangedSymbol[] = [];
  for (const f of changed) {
    const oldPath = f.oldPath ?? f.path;
    const oldMeta = namesBefore.get(oldPath);
    const newMeta = namesAfter.get(f.path);
    if (!oldMeta && !newMeta) continue;
    const oldSrc = f.status.startsWith('A') || !oldMeta ? undefined : await source.read(before, oldPath);
    const newSrc = f.status.startsWith('D') || !newMeta ? undefined : await source.read(after, f.path);
    const tsx = (p: string) => !/\.(ts|mts|cts)$/.test(p);
    const oldMod = oldSrc !== undefined && oldMeta ? await extractTs(oldSrc, { module: oldMeta.module, path: oldPath, tsx: tsx(oldPath), resolve: relativeResolver(oldPath, namesBefore) }) : undefined;
    const newMod = newSrc !== undefined && newMeta ? await extractTs(newSrc, { module: newMeta.module, path: f.path, tsx: tsx(f.path), resolve: relativeResolver(f.path, namesAfter) }) : undefined;
    const hunks = oldMod && newMod ? await source.hunks(before, after, oldPath, f.path) : undefined;
    out.push(...compareModules(repo, oldMod, newMod, hunks, { old: oldSrc, new: newSrc }));
  }
  return out;
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * Go changes, by package: a package spans files, so a function moved to another file of
 * its package is not removed. Removed, renamed, re-signed and added symbols come from the
 * whole package before and after; `modified` from each changed file's own lines.
 */
async function diffGo(source: DiffSource, repo: string, before: string, after: string, changed: ChangedFile[]): Promise<ChangedSymbol[]> {
  const dirs = new Set(changed.flatMap((f) => [dirOf(f.path), ...(f.oldPath ? [dirOf(f.oldPath)] : [])]));
  const packagesAt = async (sha: string) => {
    const all = await source.files(sha);
    const files = all.filter((p) => classifyFile(p) === 'go' && dirs.has(dirOf(p)));
    const mods = await parseGoPackages((p) => source.read(sha, p), { files, all, repo }, extractGoFile);
    return new Map(mods.map((m) => [m.module, m]));
  };
  const [old, now] = await Promise.all([packagesAt(before), packagesAt(after)]);
  const out: ChangedSymbol[] = [];
  for (const module of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    const o = old.get(module);
    const n = now.get(module);
    const fileOf = new Map([...(o?.defs ?? []), ...(n?.defs ?? [])].map((d) => [d.qualname, d.file]));
    const found = compareModules(repo, o, n).map((c) => ({ ...c, path: (c.change === 'removed' || c.change === 'renamed' ? o : n)?.defs.find((d) => d.qualname === c.qualname)?.file ?? fileOf.get(c.qualname) ?? c.path }));
    const reported = new Set(found.map((c) => c.qualname));
    out.push(...found);
    if (!o || !n) continue;
    for (const f of changed) {
      const oldPath = f.oldPath ?? f.path;
      if (f.status.startsWith('A') || f.status.startsWith('D')) continue;
      const own = (m: typeof o, path: string) => ({ ...m, path, defs: [m.defs[0]!, ...m.defs.slice(1).filter((d) => d.file === path)] });
      const subOld = own(o, oldPath);
      const subNew = own(n, f.path);
      if (subOld.defs.length < 2 && subNew.defs.length < 2) continue;
      const hunks = await source.hunks(before, after, oldPath, f.path);
      const [oldSrc, newSrc] = await Promise.all([source.read(before, oldPath), source.read(after, f.path)]);
      for (const c of compareModules(repo, subOld, subNew, hunks, { old: oldSrc, new: newSrc })) {
        if (c.change === 'modified' && !reported.has(c.qualname)) {
          reported.add(c.qualname);
          out.push(c);
        }
      }
    }
  }
  return out;
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
      // TypeScript: only names the module exported (`export { X } from`) were part of its API. Go imports export nothing.
      if ((oldMod.lang === 'ts' && !imp.exported) || oldMod.lang === 'go') continue;
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
