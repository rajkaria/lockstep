import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSymbolTable, parseRepo, type ParsedRepo } from '../indexer/index.js';
import { loadRepoConfig, type RepoConfig } from '../indexer/repo-config.js';
import type { SymbolTable } from '../indexer/resolve.js';
import { loadHistoryCached, type ParseCache } from '../lint/cache.js';
import { pathClaims } from '../lint/check-paths.js';
import { lintRepo, workingFiles } from '../lint/engine.js';
import type { CheckedPage } from '../lint/facts-docstrings.js';
import { lintTargets, type LintTarget } from '../lint/files.js';
import { RULE_BY_ID } from '../lint/rules.js';
import { scanClaims } from '../lint/scan.js';
import type { LintResult, RuleId } from '../lint/types.js';
import { BufferFacts } from './facts.js';

/**
 * One snapshot of a workspace as the language server knows it: the full lint of the files
 * on disk (the same `lintRepo` as `staleproof lint`), and what the per-file checks need to
 * re-check one edited buffer without linting the repository again: the file list, config,
 * parsed code and symbol table, every docs page scanned, and the repository facts.
 */
export interface LintModel {
  root: string;
  repo: string;
  sha?: string;
  paths: string[];
  config?: RepoConfig;
  /** Docs pages, READMEs and agent files lint reads, by repository-relative path. */
  targets: Map<string, LintTarget>;
  parsed: ParsedRepo[];
  table: SymbolTable;
  /** Repositories whose code was parsed (example findings are kept only for these). */
  codeRepos: Set<string>;
  cache?: ParseCache;
  facts: BufferFacts;
  /** Every docs page as it is on disk. */
  pages: Map<string, CheckedPage>;
  /** The lint of the files on disk. */
  result: LintResult;
  enabled(rule: RuleId): boolean;
  /** Any `example-*` rule is on. */
  wantExamples: boolean;
  builtAt: number;
  ms: number;
}

export interface BuildOptions {
  cache?: ParseCache;
  /** Unsaved buffers by repository-relative path (the facts read them; the full lint reads the disk). */
  buffers: ReadonlyMap<string, string>;
  /** The snapshot this one replaces: its git history is reused when the refs have not moved. */
  previous?: LintModel;
}

export function ruleSwitch(config: RepoConfig | undefined): (rule: RuleId) => boolean {
  return (rule) => config?.rules?.[rule] !== 'off' && !RULE_BY_ID.get(rule)?.planned;
}

/** Lint the workspace on disk and keep what the per-file checks need. */
export async function buildModel(root: string, opts: BuildOptions): Promise<LintModel> {
  const started = Date.now();
  let config: RepoConfig | undefined;
  const warnings: string[] = [];
  try {
    config = await loadRepoConfig(root);
  } catch (err) {
    warnings.push((err as Error).message);
  }
  let parsed: ParsedRepo[] = [];
  const [result, paths] = await Promise.all([
    lintRepo({ dir: root, cache: opts.cache, ...(config ? { config } : {}), onParsed: (p) => (parsed = p) }),
    workingFiles(root),
  ]);
  result.warnings.unshift(...warnings);
  const repo = result.repo ?? root;
  // Hover and code lenses need the code even when every code rule is off.
  if (!parsed.length) parsed = [await parseRepo({ repo, dir: root, sha: result.sha ?? 'worktree' }, { memo: opts.cache })];
  const table = buildSymbolTable(parsed);
  const codeRepos = new Set(parsed.filter((p) => p.modules.length).map((p) => p.checkout.repo));
  const enabled = ruleSwitch(config);

  const targets = new Map(lintTargets(paths, config).map((t) => [t.path, t]));
  const pages = new Map<string, CheckedPage>();
  await Promise.all(
    [...targets.values()].map(async (target) => {
      const text = await readFile(join(root, target.path), 'utf8').catch(() => undefined);
      if (text !== undefined) pages.set(target.path, { target, doc: scanClaims(target.path, text), text });
    }),
  );

  const facts = new BufferFacts(root, new Set(paths), opts.buffers);
  // As lint does: one `git check-ignore` for every path the pages name, and git history for moved files.
  await facts.loadIgnored([...pages.values()].flatMap((p) => pathClaims(p.doc, facts).flatMap((c) => c.candidates)));
  if (opts.previous && opts.previous.sha === result.sha && opts.previous.root === root) facts.adoptHistory(opts.previous.facts);
  else await loadHistoryCached(facts, opts.cache);

  return {
    root,
    repo,
    ...(result.sha ? { sha: result.sha } : {}),
    paths,
    ...(config ? { config } : {}),
    targets,
    parsed,
    table,
    codeRepos,
    ...(opts.cache ? { cache: opts.cache } : {}),
    facts,
    pages,
    result,
    enabled,
    wantExamples: [...RULE_BY_ID.keys()].some((r) => r.startsWith('example-') && enabled(r)),
    builtAt: Date.now(),
    ms: Date.now() - started,
  };
}
