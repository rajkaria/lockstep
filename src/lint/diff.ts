import { git } from '../indexer/repo.js';
import type { TarballLimits } from '../indexer/tarball.js';
import type { LintOptions } from './engine.js';
import { commitTree, gitRoot, indexTree, lintTree, refTree, subdirOf, tarballTree, worktreeTree, type LintTree } from './sources.js';
import type { Finding, LintResult, LintSummary } from './types.js';

/**
 * Diff-aware findings: what a change *introduced*. Fingerprints are line-independent
 * (rule, path, subject, occurrence), so lines added above a reference do not make it
 * new, while a script renamed in `package.json` makes the untouched README's reference
 * to it a new finding.
 */

type Findings = readonly Finding[] | Pick<LintResult, 'findings'>;
const list = (x: Findings): readonly Finding[] => ('findings' in x ? x.findings : (x as readonly Finding[]));

/** Findings at `head` whose fingerprint is absent at `base`, in head's order (agent files first). */
export function newFindings(base: Findings, head: Findings): Finding[] {
  const seen = new Set(list(base).map((f) => f.fingerprint));
  return list(head).filter((f) => !seen.has(f.fingerprint));
}

/** Findings at `base` that `head` no longer has. */
export function fixedFindings(base: Findings, head: Findings): Finding[] {
  return newFindings(head, base);
}

export function summarize(findings: readonly Finding[], files: number, ms: number): LintSummary {
  const s: LintSummary = { errors: 0, warnings: 0, infos: 0, files, byRule: {}, bySurface: {}, ms };
  for (const f of findings) {
    if (f.severity === 'error') s.errors++;
    else if (f.severity === 'warning') s.warnings++;
    else s.infos++;
    s.byRule[f.rule] = (s.byRule[f.rule] ?? 0) + 1;
    s.bySurface[f.surface] = (s.bySurface[f.surface] ?? 0) + 1;
  }
  return s;
}

/** A lint result holding only the new findings, plus what they were compared with (JSON `version: 1`, additive fields). */
export interface LintDiff extends LintResult {
  base: { ref: string; sha?: string; label: string; why?: string };
  head: { label: string; sha?: string };
  /** Findings at the base that the head no longer has. */
  fixed: number;
}

export function diffResults(base: LintResult, head: LintResult, meta: { base: LintDiff['base']; head: LintDiff['head']; ms?: number }): LintDiff {
  const findings = newFindings(base, head);
  return {
    ...head,
    findings,
    summary: summarize(findings, head.summary.files, meta.ms ?? head.summary.ms),
    warnings: [...new Set([...head.warnings])],
    base: meta.base,
    head: meta.head,
    fixed: fixedFindings(base, head).length,
  };
}

/** The remote default branch as a local ref (`origin/main`), or a local `main`/`master`. */
export async function defaultBranch(root: string): Promise<string | undefined> {
  const head = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  if (head) return head;
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '')).trim()) return ref;
  }
  return undefined;
}

/** Uncommitted work: staged, unstaged or new (not ignored) files. Reads the index without writing it. */
export async function isDirty(root: string): Promise<boolean> {
  const out = await git(root, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']).catch(() => '');
  return out.trim().length > 0;
}

/**
 * What `lint --new` compares with when no `--base` is given: `HEAD` for staged content or
 * a dirty tree (what the uncommitted work introduces), else the merge base with the
 * default branch (what the branch introduces).
 */
export async function defaultBase(dir: string, opts: { staged?: boolean } = {}): Promise<{ ref: string; why: string }> {
  const root = (await gitRoot(dir)) ?? dir;
  if (opts.staged) return { ref: 'HEAD', why: 'the staged changes against the last commit' };
  if (await isDirty(root)) return { ref: 'HEAD', why: 'the uncommitted changes against the last commit' };
  const branch = await defaultBranch(root);
  if (branch) {
    const mb = (await git(root, ['merge-base', 'HEAD', branch]).catch(() => '')).trim();
    if (mb) return { ref: mb, why: `this branch against ${branch}` };
  }
  return { ref: 'HEAD', why: 'the last commit (no default branch to compare with)' };
}

export interface LintNewOptions extends LintOptions {
  /** The commit to compare with (default: see `defaultBase`). */
  base?: string;
  /** The head is the git index instead of the working tree. */
  staged?: boolean;
}

function tempOpts(opts: LintOptions): LintOptions {
  // A parse cache opened by path would land in the temporary tree; a shared instance is fine.
  return { ...opts, cache: typeof opts.cache === 'object' ? opts.cache : undefined };
}

/** `staleproof lint --staged`: the content of the git index (the next commit), not the files on disk. */
export async function lintStaged(opts: LintOptions): Promise<LintResult> {
  const root = await gitRoot(opts.dir);
  if (!root) throw new Error(`--staged needs a git checkout; ${opts.dir} is not in one`);
  const tree = await indexTree(root, { subdir: subdirOf(root, opts.dir) });
  try {
    return await lintTree(tree, tempOpts(opts));
  } finally {
    await tree.dispose();
  }
}

/**
 * `staleproof lint --new`: findings the working tree (or, with `staged`, the index) has
 * and the base commit does not. The base is extracted from the local clone, never fetched.
 */
export async function lintNew(opts: LintNewOptions): Promise<LintDiff> {
  const started = Date.now();
  const root = await gitRoot(opts.dir);
  if (!root) throw new Error(`--new needs a git checkout to compare with; ${opts.dir} is not in one`);
  const subdir = subdirOf(root, opts.dir);
  const chosen = opts.base ? { ref: opts.base, why: 'the given base' } : await defaultBase(root, { staged: opts.staged });
  const head: LintTree = opts.staged ? await indexTree(root, { subdir }) : worktreeTree(opts.dir);
  let base: LintTree | undefined;
  try {
    const headResult = await lintTree(head, head.temporary ? tempOpts(opts) : opts);
    base = await refTree(root, chosen.ref, { subdir });
    const baseResult = await lintTree(base, { ...tempOpts(opts), repo: headResult.repo });
    return diffResults(baseResult, headResult, {
      base: { ref: chosen.ref, sha: base.sha, label: base.label, why: chosen.why },
      head: { label: head.label, ...(headResult.sha ? { sha: headResult.sha } : {}) },
      ms: Date.now() - started,
    });
  } finally {
    await head.dispose();
    await base?.dispose();
  }
}

export interface CommitLintOptions {
  /** Where clones and downloads live (`config.home`). */
  home: string;
  /** A local clone that has both commits (else the tarballs are downloaded). */
  clone?: string;
  /** For private repositories when there is no clone. */
  token?: string;
  fetchImpl?: typeof fetch;
  limits?: TarballLimits;
  signal?: AbortSignal;
  lint?: Omit<LintOptions, 'dir' | 'paths' | 'sha' | 'repo'>;
}

/** Lint results by commit: a commit's findings never change, and many pull requests share a base. */
const byCommit = new Map<string, Promise<LintResult>>();
const BY_COMMIT_MAX = 32;

/** The lint result of one commit of a GitHub repository (local clone, else tarball), cached by commit. */
export async function lintCommit(repo: string, sha: string, opts: CommitLintOptions): Promise<LintResult> {
  const key = `${repo.toLowerCase()}@${sha}|${JSON.stringify({ r: opts.lint?.rules ?? null, d: opts.lint?.disable ?? null, e: opts.lint?.examples ?? true })}`;
  let hit = byCommit.get(key);
  if (!hit) {
    hit = (async () => {
      const tree = await commitTree(repo, sha, opts);
      try {
        return await lintTree(tree, { ...tempOpts({ dir: tree.dir, ...opts.lint }), repo });
      } finally {
        await tree.dispose();
      }
    })();
    byCommit.set(key, hit);
    hit.catch(() => byCommit.delete(key));
    while (byCommit.size > BY_COMMIT_MAX) byCommit.delete(byCommit.keys().next().value!);
  }
  return hit;
}

/** New findings between two commits of a GitHub repository: what a pull request makes wrong. */
export async function lintCommits(repo: string, base: string, head: string, opts: CommitLintOptions): Promise<LintDiff> {
  const started = Date.now();
  const [b, h] = await Promise.all([lintCommit(repo, base, opts), lintCommit(repo, head, opts)]);
  return diffResults(b, h, { base: { ref: base, sha: base, label: base.slice(0, 7) }, head: { label: head.slice(0, 7), sha: head }, ms: Date.now() - started });
}

/** Lint results of a repository at a ref (`HEAD` moves), for the hosted endpoint and `lint_docs`. */
const byRef = new Map<string, { at: number; result: Promise<LintResult> }>();
const BY_REF_MAX = 64;
export const REMOTE_LINT_TTL_MS = 10 * 60_000;

function refKey(repo: string, ref: string, lint: CommitLintOptions['lint']): string {
  return `${repo.toLowerCase()}@${ref}|${JSON.stringify({ r: lint?.rules ?? null, d: lint?.disable ?? null, e: lint?.examples ?? true, f: lint?.files ?? null })}`;
}

/** Whether `lintGitHubRepo` would answer from its cache (so the caller can rate-limit downloads only). */
export function hasFreshRemoteLint(repo: string, opts: { ref?: string; ttlMs?: number; lint?: CommitLintOptions['lint'] }): boolean {
  const hit = byRef.get(refKey(repo, opts.ref ?? 'HEAD', opts.lint));
  return !!hit && Date.now() - hit.at < (opts.ttlMs ?? REMOTE_LINT_TTL_MS);
}

/**
 * Lint a GitHub repository at `ref` from its tarball (graph-free, no clone): what
 * `GET /api/lint` and the MCP tool `lint_docs` answer. Results are kept `ttlMs` (default 10
 * minutes); `cached` says whether this answer came from there.
 */
export async function lintGitHubRepo(
  repo: string,
  opts: Omit<CommitLintOptions, 'clone'> & { ref?: string; ttlMs?: number; fresh?: boolean },
): Promise<LintResult & { cached: boolean }> {
  const ref = opts.ref ?? 'HEAD';
  const key = refKey(repo, ref, opts.lint);
  const hit = byRef.get(key);
  if (hit && !opts.fresh && Date.now() - hit.at < (opts.ttlMs ?? REMOTE_LINT_TTL_MS)) return { ...(await hit.result), cached: true };
  const result = (async () => {
    const tree = await tarballTree(opts.home, repo, ref, opts);
    try {
      return await lintTree(tree, { ...tempOpts({ dir: tree.dir, ...opts.lint }), repo });
    } finally {
      await tree.dispose();
    }
  })();
  byRef.delete(key);
  byRef.set(key, { at: Date.now(), result });
  result.catch(() => byRef.delete(key));
  while (byRef.size > BY_REF_MAX) byRef.delete(byRef.keys().next().value!);
  return { ...(await result), cached: false };
}
