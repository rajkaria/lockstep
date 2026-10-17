import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParsedRepo } from '../indexer/index.js';
import { EMPTY_CONFIG, loadRepoConfig, type RepoConfig } from '../indexer/repo-config.js';
import { cacheEnabled, ParseCache } from '../lint/cache.js';
import { lintRepo } from '../lint/engine.js';
import { gitRoot, lintTree, refTree, resolveCommit } from '../lint/sources.js';
import type { Finding, LintResult } from '../lint/types.js';

/** The working tree linted against HEAD: every finding, and the ones HEAD does not have. */
export interface DiffLint {
  /** The top of the checkout. */
  root: string;
  /** HEAD, when the repository has a commit. */
  sha?: string;
  config: RepoConfig;
  head: LintResult;
  /** Findings of the working tree whose fingerprint HEAD's findings do not have. */
  fresh: Finding[];
  /** The checkout's parse cache, also where hook state is kept. */
  cache: ParseCache;
  /** The working tree's code as the lint parsed it (absent when no check needed it). */
  parsed?: ParsedRepo;
}

/** Baselines kept per checkout (one per commit linted against). */
const KEEP_BASELINES = 20;

function configKey(config: RepoConfig): string {
  const { warnings: _w, ...rest } = config;
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 10);
}

/** Drop all but the newest `keep` files named `<prefix>*.json` in the cache directory. */
export async function pruneRecords(cache: ParseCache, prefix: string, keep: number): Promise<void> {
  try {
    const names = (await readdir(cache.dir)).filter((n) => n.startsWith(prefix) && n.endsWith('.json'));
    if (names.length <= keep) return;
    const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(cache.dir, n)).catch(() => undefined))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => b.t - a.t);
    for (const { n } of dated.slice(keep)) await rm(join(cache.dir, n), { force: true });
  } catch {
    // Nothing to prune.
  }
}

/**
 * Fingerprints of the findings at a commit, linted from a temporary tree of that commit
 * with the working tree's config, and kept in the cache by commit: the first hook after a
 * commit pays for it, every later one reads it.
 */
export async function baselineFingerprints(root: string, sha: string, cache: ParseCache, config: RepoConfig, repo?: string): Promise<Set<string>> {
  const name = `baseline-${sha.slice(0, 12)}-${configKey(config)}`;
  const known = await cache.readJson<string[]>(name);
  if (known) return new Set(known);
  const tree = await refTree(root, sha, { repo });
  try {
    const r = await lintTree(tree, { config, ...(cacheEnabled() ? { cache } : {}), ...(repo ? { repo } : {}) });
    const prints = r.findings.map((f) => f.fingerprint);
    await cache.writeJson(name, prints);
    await pruneRecords(cache, 'baseline-', KEEP_BASELINES);
    return new Set(prints);
  } finally {
    await tree.dispose();
  }
}

/**
 * Lint the checkout `dir` is in and compare with HEAD by fingerprint: what the hooks
 * report. Undefined outside git. Reads only local files and git objects; nothing is
 * fetched or sent anywhere.
 */
export async function lintAgainstHead(dir: string, opts: { cache?: ParseCache } = {}): Promise<DiffLint | undefined> {
  const root = await gitRoot(dir);
  if (!root) return undefined;
  let config: RepoConfig;
  try {
    config = await loadRepoConfig(root);
  } catch {
    config = EMPTY_CONFIG;
  }
  // The hooks keep their state next to the parse cache, so they open it even when parsing skips it.
  const cache = opts.cache ?? (await ParseCache.open(root));
  let parsed: ParsedRepo | undefined;
  const head = await lintRepo({ dir: root, config, ...(cacheEnabled() ? { cache } : {}), onParsed: (p) => (parsed = p[0]) });
  const sha = await resolveCommit(root, 'HEAD').catch(() => undefined);
  if (!sha) return { root, config, head, fresh: head.findings, cache, ...(parsed ? { parsed } : {}) };
  const base = await baselineFingerprints(root, sha, cache, config, head.repo);
  return { root, sha, config, head, fresh: head.findings.filter((f) => !base.has(f.fingerprint)), cache, ...(parsed ? { parsed } : {}) };
}
