import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { buildSymbolTable, parseRepo, type ParsedRepo } from '../indexer/index.js';
import { git } from '../indexer/repo.js';
import { trackedOrWalked } from '../indexer/files.js';
import { loadRepoConfig, type RepoConfig } from '../indexer/repo-config.js';
import { cacheEnabled, loadHistoryCached, ParseCache } from './cache.js';
import { checkCli } from './check-cli.js';
import { checkCommands } from './check-commands.js';
import { checkDocstrings } from './check-docstrings.js';
import { checkEnv } from './check-env.js';
import { checkLinks, checkPaths, pathClaims } from './check-paths.js';
import { checkSymbols } from './check-symbols.js';
import { exampleFinding, exampleMismatches } from './examples.js';
import { RepoFacts } from './facts.js';
import { lintTargets, type LintTarget } from './files.js';
import { RULE_BY_ID } from './rules.js';
import { isSuppressed, scanClaims, type ScannedDoc, type Span } from './scan.js';
import type { Finding, LintResult, RuleId, Severity, Surface } from './types.js';

/** A finding as a check produces it, before severity, suppression and fingerprints. */
export interface RawFinding {
  rule: RuleId;
  span: Span;
  subject: string;
  message: string;
  /** Where Staleproof looked. */
  looked: string;
  /** The file or symbol the claim points at (for `--files` and fixes). */
  target?: string;
  /** Names that do exist there (fix candidates). */
  candidates?: string[];
}

export interface LintOptions {
  /** The checkout to lint. */
  dir: string;
  /** `owner/name`, default from the origin remote. */
  repo?: string;
  sha?: string;
  /** Other local checkouts whose code the docs' examples may call (a docs repo's SDKs). */
  with?: string[];
  /** Only these rules. */
  rules?: RuleId[];
  disable?: RuleId[];
  /** Report only findings in these files or about them. */
  files?: string[];
  /** Run the static example checks (parses the code; default true). */
  examples?: boolean;
  config?: RepoConfig;
  /** File list instead of `git ls-files` (a tarball listing). */
  paths?: string[];
  /** The local parse cache (`src/lint/cache.ts`): `true` opens the checkout's own; default none. */
  cache?: ParseCache | boolean;
  /** Receives the parsed code when a check parsed it (the coding-agent hooks reuse it). */
  onParsed?: (parsed: ParsedRepo[]) => void;
}

const SURFACE_ORDER: Record<Surface, number> = { agent: 0, readme: 1, docs: 2, example: 3, docstring: 4, config: 5 };

async function repoName(dir: string): Promise<string | undefined> {
  // Only a repository root names itself: a folder inside another checkout is not that repository.
  if (!existsSync(join(dir, '.git'))) return undefined;
  const url = (await git(dir, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

async function headSha(dir: string): Promise<string | undefined> {
  if (!existsSync(join(dir, '.git'))) return undefined;
  return (await git(dir, ['rev-parse', 'HEAD']).catch(() => '')).trim() || undefined;
}

/**
 * The files of a working tree as lint sees them: tracked and new (not ignored) files,
 * minus tracked files deleted on disk. Outside git, every non-hidden file.
 */
export async function workingFiles(dir: string): Promise<string[]> {
  if (!existsSync(join(dir, '.git'))) return trackedOrWalked(dir);
  const list = async (args: string[]) => (await git(dir, ['ls-files', '-z', ...args])).split('\0').filter(Boolean);
  const [all, deleted] = await Promise.all([list(['--cached', '--others', '--exclude-standard']), list(['--deleted'])]);
  const gone = new Set(deleted);
  return [...new Set(all.filter((p) => !gone.has(p)))].sort();
}

export function fingerprint(rule: string, path: string, subject: string, occurrence: number): string {
  return createHash('sha1').update(`${rule}\0${path}\0${subject.trim().toLowerCase()}\0${occurrence}`).digest('hex').slice(0, 16);
}

/** Which surface a rule's finding belongs to on a page of the given surface. */
function surfaceFor(rule: RuleId, page: Surface): Surface {
  if (rule.startsWith('example-')) return 'example';
  if (rule.startsWith('docstring-')) return 'docstring';
  return page;
}

/**
 * Lint a checkout: every claim its docs, READMEs and agent instruction files make
 * about the repository, checked against the repository itself. No graph, no network.
 */
export async function lintRepo(opts: LintOptions): Promise<LintResult> {
  const started = Date.now();
  const dir = resolve(opts.dir);
  const warnings: string[] = [];
  let config = opts.config;
  if (!config) {
    try {
      config = await loadRepoConfig(dir);
    } catch (err) {
      warnings.push((err as Error).message);
    }
  }
  warnings.push(...(config?.warnings ?? []));
  const repo = opts.repo ?? (await repoName(dir)) ?? basename(dir);
  const sha = opts.sha ?? (await headSha(dir));
  const paths = opts.paths ?? (await workingFiles(dir));
  const facts = new RepoFacts(dir, new Set(paths), !opts.paths);
  const targets = lintTargets(paths, config);

  // Warm runs read unchanged files' parses (code, docs examples) from the local cache (src/lint/cache.ts).
  const cache = opts.cache === true ? (cacheEnabled() ? await ParseCache.open(dir) : undefined) : opts.cache || undefined;

  const enabled = (rule: RuleId): boolean => {
    if (opts.rules?.length && !opts.rules.includes(rule)) return false;
    if (opts.disable?.includes(rule)) return false;
    if (config?.rules?.[rule] === 'off') return false;
    return !RULE_BY_ID.get(rule)?.planned;
  };

  const scanned: { target: LintTarget; doc: ScannedDoc; text: string }[] = [];
  for (const target of targets) {
    const text = await readFile(join(dir, target.path), 'utf8').catch(() => undefined);
    if (text === undefined) {
      warnings.push(`could not read ${target.path}`);
      continue;
    }
    scanned.push({ target, doc: scanClaims(target.path, text), text });
  }

  // One `git check-ignore` for every path a page names that is not in the file list, and the git
  // history only when a named path is missing: both serve the path rules alone (seconds on big repositories).
  const wantPaths = enabled('path-missing') || enabled('line-out-of-range');
  const claimsByPage = scanned.map((s) => (wantPaths ? pathClaims(s.doc, facts) : []));
  if (wantPaths) {
    await facts.loadIgnored(claimsByPage.flatMap((cs) => cs.flatMap((c) => c.candidates)));
    if (claimsByPage.some((cs) => cs.some((c) => !c.candidates.some((x) => facts.exists(x))))) await loadHistoryCached(facts, cache);
  }

  const raw: { page: (typeof scanned)[number]; f: RawFinding }[] = [];
  for (const [i, page] of scanned.entries()) {
    if (wantPaths) {
      const surface = page.target.surface === 'agent' || page.target.surface === 'readme' ? page.target.surface : 'docs';
      for (const f of await checkPaths(page.doc, facts, claimsByPage[i]!, surface)) raw.push({ page, f });
    }
    if (enabled('link-broken') || enabled('anchor-missing')) {
      for (const f of await checkLinks(page.doc, facts)) raw.push({ page, f });
    }
    if (enabled('command-missing')) {
      for (const f of await checkCommands(page.doc, { facts, repo, surface: page.target.surface })) raw.push({ page, f });
    }
    if (enabled('cli-command-unknown') || enabled('cli-flag-unknown')) {
      for (const f of await checkCli(page.doc, { facts, repo, surface: page.target.surface })) raw.push({ page, f });
    }
  }

  // The code is parsed once, for the example checks and for the symbol and docstring rules.
  const wantExamples = opts.examples !== false && [...RULE_BY_ID.keys()].some((r) => r.startsWith('example-') && enabled(r));
  const wantDocstrings = enabled('docstring-param-unknown') || enabled('docstring-param-undocumented');
  if (wantExamples || enabled('symbol-missing') || wantDocstrings) {
    const checkouts = [{ repo, dir, sha: sha ?? 'worktree' }];
    for (const w of opts.with ?? []) {
      const wd = resolve(w);
      checkouts.push({ repo: (await repoName(wd)) ?? basename(wd), dir: wd, sha: (await headSha(wd)) ?? 'worktree' });
    }
    // Go code matters to lint only through Go examples (the symbol and docstring rules read Python and JS/TS).
    const go = scanned.some((s) => s.doc.fences.some((f) => f.lang === 'go' || f.lang === 'golang'));
    const parsed: ParsedRepo[] = [];
    for (const c of checkouts) parsed.push(await parseRepo(c, { memo: cache, go }));
    opts.onParsed?.(parsed);
    const table = buildSymbolTable(parsed);
    const codeRepos = new Set(parsed.filter((p) => p.modules.length).map((p) => p.checkout.repo));
    const pages = scanned.filter((s) => s.target.surface !== 'agent' || /\.mdx?$/i.test(s.target.path)).map((s) => ({ path: s.target.path, text: s.text }));
    for (const e of wantExamples ? await exampleMismatches(parsed[0]!, pages, table, codeRepos, cache) : []) {
      const page = scanned.find((s) => s.target.path === e.path)!;
      raw.push({ page, f: exampleFinding(e, page.doc.lines) });
    }
    if (enabled('symbol-missing')) raw.push(...(await checkSymbols(scanned, table, parsed)));
    if (wantDocstrings) raw.push(...(await checkDocstrings(parsed[0]!, (p) => facts.text(p))));
  }
  if (enabled('env-unused') || enabled('env-undocumented')) {
    raw.push(...(await checkEnv({ dir, repo, paths, pages: scanned, config, cache, unused: enabled('env-unused'), undocumented: enabled('env-undocumented') })));
  }

  await cache?.save();

  const findings: Finding[] = [];
  const occurrences = new Map<string, number>();
  for (const { page, f } of raw) {
    if (!enabled(f.rule) || isSuppressed(page.doc, f.span.line, f.rule)) continue;
    if (opts.files?.length && !opts.files.includes(page.target.path) && !(f.target && opts.files.includes(f.target))) continue;
    const setting = config?.rules?.[f.rule];
    const severity: Severity = setting && setting !== 'off' ? setting : RULE_BY_ID.get(f.rule)!.severity;
    const key = `${f.rule}\0${page.target.path}\0${f.subject}`;
    const n = occurrences.get(key) ?? 0;
    occurrences.set(key, n + 1);
    findings.push({
      rule: f.rule,
      severity,
      message: f.message,
      repo,
      path: page.target.path,
      line: f.span.line,
      column: f.span.column,
      endLine: f.span.line,
      endColumn: f.span.endColumn,
      surface: surfaceFor(f.rule, page.target.surface),
      subject: f.subject,
      evidence: {
        looked: f.looked,
        ...(sha && repo.includes('/') ? { url: `https://github.com/${repo}/blob/${sha}/${page.target.path}#L${f.span.line}` } : {}),
      },
      fingerprint: fingerprint(f.rule, page.target.path, f.subject, n),
    });
  }
  const pageSurface = new Map(targets.map((t) => [t.path, t.surface]));
  const surfaceForPage = (f: Finding): Surface => pageSurface.get(f.path) ?? f.surface;
  findings.sort(
    (a, b) =>
      SURFACE_ORDER[surfaceForPage(a)] - SURFACE_ORDER[surfaceForPage(b)] ||
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column,
  );

  const summary: LintResult['summary'] = { errors: 0, warnings: 0, infos: 0, files: scanned.length, byRule: {}, bySurface: {}, ms: 0 };
  for (const f of findings) {
    if (f.severity === 'error') summary.errors++;
    else if (f.severity === 'warning') summary.warnings++;
    else summary.infos++;
    summary.byRule[f.rule] = (summary.byRule[f.rule] ?? 0) + 1;
    summary.bySurface[f.surface] = (summary.bySurface[f.surface] ?? 0) + 1;
  }
  summary.ms = Date.now() - started;
  return { version: 1, repo, ...(sha ? { sha } : {}), findings, summary, warnings };
}
