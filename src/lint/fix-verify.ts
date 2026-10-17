import { existsSync } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { ParsedRepo } from '../indexer/index.js';
import { lintRepo, type LintOptions } from './engine.js';
import { applyTextEdits } from './fix-edits.js';
import type { LintTree } from './sources.js';
import type { Finding, Fix, LintResult, TextEdit } from './types.js';

/**
 * Verification (spec R3.2): a proposed fix is applied in memory and the repository linted
 * again; it is verified when its finding is gone and no new finding appeared. The edited
 * files live in a mirror of the tree (hard links, so nothing is copied and the original is
 * never written), linted twice: as it is (the baseline, in the same conditions) and edited.
 */

/** Binary files are listed but never linked: lint never reads them. */
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|whl|egg|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|mkv|webm|wav|ogg|flac|so|dylib|dll|exe|bin|dat|db|sqlite3?|parquet|arrow|npy|npz|pkl|pickle|pt|pth|onnx|h5|hdf5|ckpt|safetensors|wasm|class|o|a|lib|pyc|node)$/i;

/** Variables git exports to hooks: they would point the mirror's git commands at the user's index. */
const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE'];

export interface Mirror {
  /** The mirror's directory: lint it with `paths`. */
  dir: string;
  paths: string[];
  /** Replace a file's content in the mirror (the original is untouched). */
  write(path: string, content: string): Promise<void>;
  /** Put the original back. */
  restore(path: string): Promise<void>;
  dispose(): Promise<void>;
}

async function place(src: string, dst: string): Promise<void> {
  const s = await lstat(src);
  if (s.isSymbolicLink()) {
    await symlink(await readlink(src), dst);
    return;
  }
  if (!s.isFile()) return;
  try {
    await link(src, dst);
  } catch {
    await copyFile(src, dst);
  }
}

/**
 * A mirror of `tree`: every listed text file hard-linked (copied across devices) into a
 * temporary directory, and the tree's `.git` linked so history and ignore rules read the
 * same. Edited files are written as new files, never through a link.
 */
export async function mirrorTree(tree: LintTree, paths: string[]): Promise<Mirror> {
  const tmp = await mkdtemp(join(tmpdir(), 'staleproof-fix-'));
  const root = join(tmp, 'tree');
  await mkdir(root, { recursive: true });
  const made = new Set<string>([root]);
  const ensureDir = async (d: string) => {
    if (made.has(d)) return;
    await mkdir(d, { recursive: true });
    made.add(d);
  };
  try {
    if (existsSync(join(tree.dir, '.git'))) await symlink(join(tree.dir, '.git'), join(root, '.git'));
    const todo = paths.filter((p) => !BINARY.test(p) && !p.split('/').includes('..') && !p.startsWith('.git/'));
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const p = todo[next++]!;
        const dst = join(root, ...p.split('/'));
        await ensureDir(dirname(dst));
        await place(join(tree.dir, ...p.split('/')), dst).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: 32 }, worker));
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  const realRoot = await realpath(root);
  /** The mirror's own path for `path`; never through a link that leaves the mirror (the user's files). */
  const inside = async (path: string): Promise<string> => {
    const dst = join(root, ...path.split('/'));
    await ensureDir(dirname(dst));
    const rel = relative(realRoot, await realpath(dirname(dst)));
    if (rel.startsWith('..') || rel.startsWith('/')) throw new Error(`${path} is under a link out of the mirror`);
    return dst;
  };
  return {
    dir: root,
    paths,
    async write(path, content) {
      const dst = await inside(path);
      await rm(dst, { force: true });
      await writeFile(dst, content);
    },
    async restore(path) {
      const dst = await inside(path);
      await rm(dst, { force: true });
      await place(join(tree.dir, ...path.split('/')), dst).catch(() => undefined);
    },
    dispose: () => rm(tmp, { recursive: true, force: true }),
  };
}

/** Run `fn` with the git hook variables out of the environment (as `lintTree` does for temporary trees). */
async function withoutHookEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = REPO_VARS.filter((v) => process.env[v] !== undefined).map((v) => [v, process.env[v]!] as const);
  if (!saved.length) return fn();
  for (const [v] of saved) delete process.env[v];
  try {
    return await fn();
  } finally {
    for (const [v, value] of saved) process.env[v] = value;
  }
}

/** A finding as verification counts it: rule, file and subject (the occurrence is a count). */
export function findingKey(f: Pick<Finding, 'rule' | 'path' | 'subject'>): string {
  return `${f.rule}\0${f.path}\0${f.subject.trim().toLowerCase()}`;
}

function counts(findings: readonly Finding[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of findings) out.set(findingKey(f), (out.get(findingKey(f)) ?? 0) + 1);
  return out;
}

export interface Candidate {
  finding: Finding;
  fix: Fix;
}

export interface VerifyOptions {
  /** How the mirror is linted (the caller's lint options; `rules` and `files` are ignored: every rule is checked). */
  lint?: Omit<LintOptions, 'dir' | 'paths' | 'rules' | 'files'>;
  repo?: string;
  sha?: string;
  /** Files' original contents (default: read from the tree). */
  read: (path: string) => Promise<string | undefined>;
  /** At most this many fixes are re-checked one by one when a batch fails. */
  maxSingles?: number;
  /** No re-check starts after this time (ms since the epoch). */
  deadline?: number;
}

export interface Verifier {
  /** The mirror's lint before any edit. */
  baseline: LintResult;
  /** The code the baseline lint parsed (symbol, docstring and example proposals use it). */
  parsed?: ParsedRepo[];
  /** Mark each candidate verified or not; returns the verified ones' fingerprints. */
  verify(candidates: readonly Candidate[]): Promise<Set<string>>;
  dispose(): Promise<void>;
}

/** A mirror of `tree` and its baseline lint, ready to verify fixes. */
export async function verifier(tree: LintTree, paths: string[], opts: VerifyOptions): Promise<Verifier> {
  const mirror = await mirrorTree(tree, paths);
  let parsed: ParsedRepo[] | undefined;
  const lint = (capture = false) =>
    withoutHookEnv(() =>
      lintRepo({
        ...opts.lint,
        dir: mirror.dir,
        paths,
        ...(opts.repo ? { repo: opts.repo } : {}),
        ...(opts.sha ? { sha: opts.sha } : {}),
        ...(capture
          ? {
              onParsed: (p: ParsedRepo[]) => {
                parsed = p;
                opts.lint?.onParsed?.(p);
              },
            }
          : {}),
      }),
    );
  let baseline: LintResult;
  try {
    baseline = await lint(true);
  } catch (err) {
    await mirror.dispose();
    throw err;
  }
  const before = counts(baseline.findings);

  /** Apply a set of fixes in the mirror, lint, put the files back; what went wrong, by file. */
  const round = async (set: readonly Candidate[]) => {
    const byPath = new Map<string, TextEdit[]>();
    for (const c of set) for (const e of c.fix.edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
    const written: string[] = [];
    try {
      for (const [path, edits] of byPath) {
        const content = await opts.read(path);
        if (content === undefined) throw new Error(`cannot read ${path}`);
        await mirror.write(path, applyTextEdits(content, edits));
        written.push(path);
      }
      const after = counts((await lint()).findings);
      const expected = new Map<string, number>();
      for (const c of set) expected.set(findingKey(c.finding), (expected.get(findingKey(c.finding)) ?? 0) + 1);
      const grew = new Set<string>();
      for (const [k, n] of after) if (n > (before.get(k) ?? 0)) grew.add(k.split('\0')[1]!);
      const stayed = new Set<string>();
      for (const c of set) {
        const k = findingKey(c.finding);
        if ((after.get(k) ?? 0) > (before.get(k) ?? 0) - expected.get(k)!) stayed.add(c.finding.fingerprint);
      }
      return { grew, stayed, edited: new Set(byPath.keys()) };
    } finally {
      for (const p of written) await mirror.restore(p);
    }
  };

  const ok = (r: Awaited<ReturnType<typeof round>>, c: Candidate) => {
    if (r.stayed.has(c.finding.fingerprint)) return false;
    for (const p of r.grew) if (!r.edited.has(p) || c.fix.edits.some((e) => e.path === p)) return false;
    return true;
  };

  return {
    baseline,
    get parsed() {
      return parsed;
    },
    async verify(candidates) {
      const verified = new Set<string>();
      // Only findings the baseline has can be seen to go away.
      const present = candidates.filter((c) => (before.get(findingKey(c.finding)) ?? 0) > 0);
      if (!present.length) return verified;
      let first: Awaited<ReturnType<typeof round>>;
      try {
        first = await round(present);
      } catch {
        return verified;
      }
      const unattributed = [...first.grew].some((p) => !first.edited.has(p));
      const suspects: Candidate[] = [];
      for (const c of present) {
        if (!unattributed && ok(first, c)) verified.add(c.finding.fingerprint);
        else suspects.push(c);
      }
      if (!suspects.length) return verified;
      // Some fixes in the batch went wrong: re-check those one by one.
      let singles = 0;
      for (const c of suspects) {
        if (singles++ >= (opts.maxSingles ?? 40) || (opts.deadline !== undefined && Date.now() > opts.deadline)) break;
        try {
          const r = await round([c]);
          if (!r.stayed.size && !r.grew.size) verified.add(c.finding.fingerprint);
        } catch {
          // not verified
        }
      }
      // Fixes verified one by one are re-checked with the batch's, together: what `staleproof fix` applies.
      if (suspects.some((c) => verified.has(c.finding.fingerprint))) {
        if (opts.deadline !== undefined && Date.now() > opts.deadline) {
          // No time for that: keep the batch's own verdicts only.
          for (const c of suspects) verified.delete(c.finding.fingerprint);
          return verified;
        }
        const together = present.filter((c) => verified.has(c.finding.fingerprint));
        try {
          const r = await round(together);
          const bad = [...r.grew].some((p) => !r.edited.has(p));
          for (const c of together) if (bad || !ok(r, c)) verified.delete(c.finding.fingerprint);
        } catch {
          verified.clear();
        }
      }
      return verified;
    },
    dispose: () => mirror.dispose(),
  };
}
