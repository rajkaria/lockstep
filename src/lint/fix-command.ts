import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { cacheEnabled, ParseCache } from './cache.js';
import { defaultBase, newFindings, summarize } from './diff.js';
import { lintRepo, workingFiles, type LintOptions } from './engine.js';
import { applyFixes, addFixes } from './fixes.js';
import { findingKey, mirrorTree } from './fix-verify.js';
import { lintExitCode } from './format.js';
import { gitRoot, lintTree, refTree, subdirOf, worktreeTree, type LintTree } from './sources.js';
import type { Finding, LintResult, RuleId, Severity } from './types.js';

/**
 * `staleproof fix [dir]`: apply every verified fix to the files on disk (`--dry-run`
 * prints the unified diff instead). Renames are detected against the base `lint --new`
 * uses (the last commit with uncommitted work, else the merge base with the default
 * branch); `--new` fixes only what the changes introduced. A second run has nothing to do.
 */

export interface FixCommandOptions {
  dir: string;
  /** Print the diff, write nothing. */
  dryRun?: boolean;
  /** Only findings of these rules (`--rule`). */
  rules?: RuleId[];
  disable?: RuleId[];
  /** Only findings the changes introduced since the base (`--new`). */
  new?: boolean;
  /** The base commit (default: as `lint --new`). */
  base?: string;
  with?: string[];
  examples?: boolean;
  repo?: string;
  /** The parse cache: an instance, `true` for the checkout's own (default), `false` for none. */
  cache?: ParseCache | boolean;
  /** Exit 1 when a finding at or above this is left (default `error`, like lint). */
  failOn?: Severity | 'never';
  format?: 'text' | 'json';
}

export interface FixCommandResult {
  exitCode: number;
  /** The findings fixed (or, with `dryRun`, that would be). */
  applied: Finding[];
  /** Files written (or that would be). */
  files: string[];
  /** Files skipped because they changed on disk while Staleproof worked. */
  skipped: string[];
  /** The unified diff of every change. */
  diff: string;
  /** Findings left after the fixes, as lint reports them (`--new`: the new ones left). */
  remaining: LintResult;
  /** What the command prints. */
  output: string;
  /** The base renames were detected against, when there was one. */
  base?: { ref: string; label: string; why: string };
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The base for rename detection (and `--new`): undefined outside git or without commits. */
async function baseTreeFor(dir: string, opts: FixCommandOptions): Promise<{ tree: LintTree; why: string; ref: string } | undefined> {
  const root = await gitRoot(dir);
  if (!root) {
    if (opts.new || opts.base) throw new Error(`--new needs a git checkout to compare with; ${dir} is not in one`);
    return undefined;
  }
  const chosen = opts.base ? { ref: opts.base, why: 'the given base' } : await defaultBase(root);
  try {
    // `/var` and `/private/var` are one folder on macOS: the subfolder is computed on real paths.
    const subdir = subdirOf(await realpath(root).catch(() => root), await realpath(dir).catch(() => dir));
    const tree = await refTree(root, chosen.ref, { subdir: subdir.startsWith('..') ? '' : subdir });
    return { tree, why: chosen.why, ref: chosen.ref };
  } catch (err) {
    if (opts.new || opts.base) throw err;
    return undefined; // no commit yet: no renames to detect
  }
}

/**
 * The findings left once `changed` is applied, linted in a mirror of the tree (nothing is
 * written). Verified fixes add no finding, so only findings the first lint had are kept.
 */
async function lintAfter(dir: string, result: LintResult, changed: ReadonlyMap<string, string>, lintOpts: Omit<LintOptions, 'dir'>): Promise<Finding[]> {
  if (!changed.size) return result.findings;
  const paths = await workingFiles(dir);
  const mirror = await mirrorTree(worktreeTree(dir), paths);
  try {
    for (const [p, text] of changed) await mirror.write(p, text);
    const after = await lintRepo({ ...lintOpts, dir: mirror.dir, paths, ...(result.repo ? { repo: result.repo } : {}), ...(result.sha ? { sha: result.sha } : {}) });
    const budget = new Map<string, number>();
    for (const f of result.findings) budget.set(findingKey(f), (budget.get(findingKey(f)) ?? 0) + 1);
    return after.findings.filter((f) => {
      const n = budget.get(findingKey(f)) ?? 0;
      budget.set(findingKey(f), n - 1);
      return n > 0;
    });
  } finally {
    await mirror.dispose();
  }
}

/**
 * Files that are links to one another (`CLAUDE.md` → `AGENTS.md`) are one file: the edits are
 * made once, on the file the links point to, and a link is never replaced by a copy. `changed`
 * is keyed by repository path; the result is keyed by the path to write.
 */
export async function mergeLinkedFiles(
  dir: string,
  changed: ReadonlyMap<string, string>,
): Promise<{ changed: Map<string, string>; linked: Map<string, string>; conflicts: string[] }> {
  const root = await realpath(dir).catch(() => resolve(dir));
  const byReal = new Map<string, string[]>();
  for (const p of changed.keys()) {
    const real = await realpath(join(dir, ...p.split('/'))).catch(() => join(root, ...p.split('/')));
    const rel = relative(root, real).split('\\').join('/');
    const key = rel.startsWith('..') ? `\0${p}` : rel;
    byReal.set(key, [...(byReal.get(key) ?? []), p]);
  }
  const out = new Map<string, string>();
  const linked = new Map<string, string>();
  const conflicts: string[] = [];
  for (const [real, paths] of byReal) {
    if (real.startsWith('\0')) {
      // A link out of the repository: not ours to write.
      conflicts.push(...paths);
      continue;
    }
    const isLink = async (p: string) => (await lstat(join(dir, ...p.split('/'))).catch(() => undefined))?.isSymbolicLink() ?? false;
    const primary = (await Promise.all(paths.map(async (p) => ((await isLink(p)) ? undefined : p)))).find(Boolean) ?? paths[0]!;
    const text = changed.get(primary)!;
    out.set(real, text);
    for (const p of paths) {
      if (p === primary) continue;
      if (changed.get(p) === text) linked.set(p, real);
      else conflicts.push(p);
    }
    if (primary !== real) linked.set(primary, real);
  }
  return { changed: out, linked, conflicts };
}

function describe(f: Finding): string {
  return `${f.path}:${f.line}:${f.column}  ${f.rule}  ${f.fix!.description}`;
}

export async function runFixCommand(opts: FixCommandOptions): Promise<FixCommandResult> {
  const dir = resolve(opts.dir);
  const cache = opts.cache instanceof ParseCache ? opts.cache : opts.cache !== false && cacheEnabled() ? await ParseCache.open(dir) : undefined;
  const lintOpts: Omit<LintOptions, 'dir'> = {
    ...(opts.disable ? { disable: opts.disable } : {}),
    ...(opts.with ? { with: opts.with } : {}),
    ...(opts.examples === false ? { examples: false } : {}),
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(cache ? { cache } : {}),
  };
  const result = await lintRepo({ ...lintOpts, dir });
  const base = await baseTreeFor(dir, opts);
  try {
    let scope: Set<string> | undefined;
    let atBase: LintResult | undefined;
    if (opts.new && base) {
      atBase = await lintTree(base.tree, { ...lintOpts, repo: result.repo });
      scope = new Set(newFindings(atBase, result).map((f) => f.fingerprint));
    }
    const fixed = await addFixes(result, worktreeTree(dir, result.repo), {
      ...(base ? { baseTree: base.tree } : {}),
      lint: lintOpts,
      ...(cache ? { cache } : {}),
      ...(opts.rules?.length ? { rules: opts.rules } : {}),
      ...(scope ? { only: (f: Finding) => scope!.has(f.fingerprint) } : {}),
    });
    const inScope = (f: Finding) => (!scope || scope.has(f.fingerprint)) && (!opts.rules?.length || opts.rules.includes(f.rule));
    const verified = fixed.findings.filter((f) => f.fix?.verified && inScope(f));

    // New contents, from the files as they were linted.
    const paths = [...new Set(verified.flatMap((f) => f.fix!.edits.map((e) => e.path)))];
    const originals = new Map<string, string>();
    for (const p of paths) {
      const text = await readFile(join(dir, ...p.split('/')), 'utf8').catch(() => undefined);
      if (text !== undefined) originals.set(p, text);
    }
    const usable = verified.filter((f) => f.fix!.edits.every((e) => originals.has(e.path)));
    const edited = applyFixes(originals, usable.map((f) => f.fix!));
    // `CLAUDE.md` linked to `AGENTS.md` is one file: changed once, under its real name.
    const merged = await mergeLinkedFiles(dir, edited);
    const changed = merged.changed;
    for (const [p, text] of changed) if (!originals.has(p)) originals.set(p, (await readFile(join(dir, ...p.split('/')), 'utf8').catch(() => undefined)) ?? text);
    const diff = [...changed].map(([p, after]) => createTwoFilesPatch(`a/${p}`, `b/${p}`, originals.get(p)!, after, '', '', { context: 3 }).replace(/^(Index:.*\n)?=+\n/, '').replace(/^(---|\+\+\+) (\S+)\t.*$/gm, '$1 $2')).join('');

    const skipped: string[] = [];
    if (!opts.dryRun) {
      for (const [p, after] of changed) {
        // A file edited since it was linted keeps the user's edit; the next run fixes it.
        const now = await readFile(join(dir, ...p.split('/')), 'utf8').catch(() => undefined);
        if (now === undefined || sha1(now) !== sha1(originals.get(p)!)) {
          skipped.push(p);
          continue;
        }
        await writeFile(join(dir, ...p.split('/')), after);
      }
    }
    const written = [...changed.keys()].filter((p) => !skipped.includes(p));
    const landed = (p: string) => written.includes(merged.linked.get(p) ?? p) && !merged.conflicts.includes(p);
    const applied = usable.filter((f) => f.fix!.edits.every((e) => landed(e.path)));
    skipped.push(...merged.conflicts);
    const gone = new Set(applied.map((f) => f.fingerprint));
    // What is left, as lint will report it: the edited tree linted again (in a mirror, so a dry run writes nothing).
    const writtenChanges = new Map([...changed].filter(([p]) => written.includes(p)));
    let afterAll: Finding[];
    try {
      afterAll = await lintAfter(dir, fixed, writtenChanges, lintOpts);
    } catch {
      afterAll = fixed.findings.filter((f) => !gone.has(f.fingerprint));
    }
    // An unapplied hint stays on its finding (same rule, file, subject and line).
    const unfixed = fixed.findings.filter((f) => f.fix && !gone.has(f.fingerprint));
    const withHints = afterAll.map((f) => {
      const was = unfixed.find((u) => findingKey(u) === findingKey(f) && u.line === f.line);
      return was?.fix && !f.fix ? { ...f, fix: was.fix } : f;
    });
    const left = atBase ? newFindings(atBase, withHints) : withHints;
    const remaining: LintResult = { ...fixed, findings: left, summary: summarize(left, fixed.summary.files, fixed.summary.ms) };
    const exitCode = lintExitCode(remaining, opts.failOn ?? 'error');

    const hints = left.filter((f) => f.fix && !f.fix.verified && (!opts.rules?.length || opts.rules.includes(f.rule)));
    const lines: string[] = [];
    if (opts.format === 'json') {
      lines.push(
        JSON.stringify(
          {
            version: 1,
            dryRun: !!opts.dryRun,
            ...(base ? { base: { ref: base.ref, label: base.tree.label, why: base.why } } : {}),
            applied,
            files: written,
            skipped,
            remaining: remaining.findings,
            summary: remaining.summary,
          },
          null,
          2,
        ),
      );
    } else {
      if (opts.dryRun && diff) lines.push(diff.trimEnd(), '');
      for (const f of applied) lines.push(`${opts.dryRun ? 'would fix' : 'fixed'}  ${describe(f)}`);
      for (const f of hints) lines.push(`hint   ${f.path}:${f.line}:${f.column}  ${f.rule}  ${f.fix!.description} (not applied: the fix did not pass re-checking)`);
      for (const p of skipped) lines.push(merged.conflicts.includes(p) ? `skipped ${p}: it is a link to a file with other fixes, or to a file outside the repository` : `skipped ${p}: it changed while Staleproof was checking it; run staleproof fix again`);
      if (!applied.length && !skipped.length) {
        lines.push(left.length ? `Nothing to fix automatically; ${plural(left.length, 'finding')} left (run staleproof lint to see them).` : 'Nothing to fix.');
      } else {
        const what = `${plural(applied.length, 'finding')} in ${plural(new Set(applied.flatMap((f) => f.fix!.edits.map((e) => e.path))).size, 'file')}`;
        lines.push(`${opts.dryRun ? `Would fix ${what} (dry run: nothing written)` : `Fixed ${what}`}; ${plural(left.length, 'finding')} left.`);
      }
    }
    return {
      exitCode,
      applied,
      files: written,
      skipped,
      diff,
      remaining,
      output: lines.join('\n'),
      ...(base ? { base: { ref: base.ref, label: base.tree.label, why: base.why } } : {}),
    };
  } finally {
    await base?.tree.dispose();
  }
}
