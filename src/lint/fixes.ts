import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadRepoConfig } from '../indexer/repo-config.js';
import { cacheEnabled, ParseCache } from './cache.js';
import { workingFiles, type LintOptions } from './engine.js';
import { applyFixes as applyFixesImpl, applyTextEdits as applyTextEditsImpl } from './fix-edits.js';
import { FIXABLE, NEEDS_CODE, proposeFixes } from './fix-propose.js';
import { detectRenames } from './fix-renames.js';
import { verifier, type Candidate } from './fix-verify.js';
import type { LintTree } from './sources.js';
import type { Finding, Fix, LintResult, RuleId, TextEdit } from './types.js';

/**
 * Fixes: the edit that makes a finding go away, attached to the finding only when the
 * answer is unambiguous, and marked `verified` only when re-linting the edited files in
 * memory shows the finding gone and nothing new. `staleproof fix`, PR suggestions, the
 * docs fix PR, the editor's quick fixes and the GitHub App all read `Finding.fix`.
 */

/** Apply single-file edits (1-based lines/columns, endColumn exclusive, the Finding convention). Throws on overlap. */
export function applyTextEdits(content: string, edits: readonly TextEdit[]): string {
  return applyTextEditsImpl(content, edits);
}

/** Apply every edit of the given fixes to in-memory file contents keyed by repo-relative path; returns changed files. */
export function applyFixes(files: ReadonlyMap<string, string>, fixes: readonly Fix[]): Map<string, string> {
  return applyFixesImpl(files, fixes);
}

export interface AddFixesOptions {
  /** An earlier state of the repository (the PR base, the last commit): enables rename detection. */
  baseTree?: LintTree;
  /**
   * How `result` was linted (`with`, `config`, `examples`, `disable`): verification lints the
   * mirror the same way, with every rule (a fix must not add a finding of any rule).
   */
  lint?: Omit<LintOptions, 'dir' | 'paths' | 'rules' | 'files'>;
  /** The parse cache the verification lints share: an instance, or `true` for the tree's own. Default: a temporary one. */
  cache?: ParseCache | boolean;
  /** Only findings of these rules get a fix. */
  rules?: RuleId[];
  /** Only findings this accepts get a fix (`staleproof fix --new`: the new ones). */
  only?: (f: Finding) => boolean;
  /** Skip verification: proposals are attached as hints (`verified: false`). */
  verify?: boolean;
  /**
   * A soft time limit (ms since the epoch) for the coding-agent hooks: past it, no further
   * lint starts; proposals not verified by then are attached as hints, and nothing is left behind.
   */
  deadline?: number;
}

/** `a` starts before `b` ends and ends after `b` starts (positions as [line, column]). */
function overlaps(a: TextEdit, b: TextEdit): boolean {
  if (a.path !== b.path) return false;
  const before = (l1: number, c1: number, l2: number, c2: number) => l1 < l2 || (l1 === l2 && c1 < c2);
  const touchPoint = a.line === a.endLine && a.column === a.endColumn && b.line === b.endLine && b.column === b.endColumn && a.line === b.line && a.column === b.column;
  return touchPoint || (before(a.line, a.column, b.endLine, b.endColumn) && before(b.line, b.column, a.endLine, a.endColumn));
}

/**
 * Attach `fix` to the findings it can fix, verified per spec R3.2 by re-linting the edited
 * files in an overlay of `tree`. `baseTree` (optional) enables rename detection against an
 * earlier state. Works on any LintTree: the working tree (CLI), a tarball or commit tree
 * (App), an overlay holding unsaved editor buffers (LSP).
 */
export async function addFixes(result: LintResult, tree: LintTree, opts: AddFixesOptions = {}): Promise<LintResult> {
  const todo = result.findings.filter((f) => FIXABLE.has(f.rule) && !f.fix && (!opts.rules?.length || opts.rules.includes(f.rule)) && (!opts.only || opts.only(f)));
  if (!todo.length) return result;
  const late = () => opts.deadline !== undefined && Date.now() > opts.deadline;
  if (late()) return result;
  const paths = tree.paths ?? (await workingFiles(tree.dir));
  const config = opts.lint?.config ?? (await loadRepoConfig(tree.dir).catch(() => undefined));
  const renames = opts.baseTree ? await detectRenames(opts.baseTree, tree).catch(() => undefined) : undefined;
  let cacheDir: string | undefined;
  let cache: ParseCache;
  if (opts.cache instanceof ParseCache) cache = opts.cache;
  else if (opts.cache === true && !tree.temporary && cacheEnabled()) cache = await ParseCache.open(tree.dir);
  else {
    cacheDir = await mkdtemp(join(tmpdir(), 'staleproof-fix-cache-'));
    cache = await ParseCache.open(tree.dir, { dir: cacheDir });
  }
  const read = (p: string) => readFile(join(tree.dir, ...p.split('/')), 'utf8').catch(() => undefined);
  const repo = result.repo ?? tree.repo;
  const sha = result.sha ?? tree.sha;
  const context = { dir: tree.dir, repo: repo ?? basename(tree.dir), paths, onDisk: !tree.paths, config, renames, cache };
  try {
    // Fixes that need no parsed code first: with none, and no finding that needs the code, nothing is linted again.
    const textual = todo.filter((f) => !NEEDS_CODE.has(f.rule));
    const coded = todo.filter((f) => NEEDS_CODE.has(f.rule));
    const proposals = await proposeFixes(textual, context);
    if (!proposals.size && !coded.length) return result;
    const v = await verifier(tree, paths, { lint: { ...opts.lint, config, cache }, ...(repo ? { repo } : {}), ...(sha ? { sha } : {}), read, ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}) });
    try {
      // The code the baseline lint parsed serves the symbol, docstring and example fixes.
      if (coded.length) for (const [k, fix] of await proposeFixes(coded, { ...context, parsed: v.parsed })) proposals.set(k, fix);
      if (!proposals.size) return result;
      // Two proposals editing the same text cannot both be applied: the first one wins.
      const accepted: TextEdit[] = [];
      const candidates: Candidate[] = [];
      for (const f of todo) {
        const fix = proposals.get(f.fingerprint);
        if (!fix) continue;
        if (fix.edits.some((e) => accepted.some((a) => overlaps(a, e)))) {
          proposals.delete(f.fingerprint);
          continue;
        }
        accepted.push(...fix.edits);
        candidates.push({ finding: f, fix });
      }
      const verified = opts.verify === false || late() ? new Set<string>() : await v.verify(candidates);
      return {
        ...result,
        findings: result.findings.map((f) => {
          const fix = proposals.get(f.fingerprint);
          return fix ? { ...f, fix: { ...fix, verified: verified.has(f.fingerprint) } } : f;
        }),
      };
    } finally {
      await v.dispose();
    }
  } finally {
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  }
}

/** The verified fixes of a result, in finding order. */
export function verifiedFixes(result: Pick<LintResult, 'findings'>): Finding[] {
  return result.findings.filter((f) => f.fix?.verified);
}
