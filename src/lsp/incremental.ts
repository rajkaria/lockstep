import type { PyModule } from '../indexer/python.js';
import { extractPython } from '../indexer/python.js';
import { extractTs } from '../indexer/typescript.js';
import { checkCli } from '../lint/check-cli.js';
import { checkCommands } from '../lint/check-commands.js';
import { checkDocstrings } from '../lint/check-docstrings.js';
import { checkEnv } from '../lint/check-env.js';
import { checkLinks, checkPaths, pathClaims } from '../lint/check-paths.js';
import { checkSymbols, HISTORY_LINE, HISTORY_PAGE } from '../lint/check-symbols.js';
import { fingerprint } from '../lint/engine.js';
import { exampleFinding, exampleMismatches } from '../lint/examples.js';
import type { CheckedPage, PageFinding } from '../lint/facts-docstrings.js';
import { docEnvClaims } from '../lint/facts-env.js';
import { RULE_BY_ID } from '../lint/rules.js';
import { isSuppressed, scanClaims } from '../lint/scan.js';
import type { Finding, RuleId, Severity, Surface } from '../lint/types.js';
import type { LintModel } from './model.js';

/**
 * Re-check one edited file against a workspace snapshot, the way `lintRepo` checks it, in
 * tens of milliseconds: a docs page runs every page rule (paths, links, anchors, commands,
 * CLI, examples, symbols) on its unsaved text; a code file re-reads its own docstrings.
 * Rules that need the whole repository re-read (`env-*`) run apart (`envFindings`), and
 * edits to code reach other files' findings at the next snapshot. Findings, fingerprints
 * included, are exactly what `staleproof lint` reports for the same text
 * (test/lsp-incremental.test.ts holds the two together).
 */

/** Rules the page pass recomputes. */
export const PAGE_RULES: ReadonlySet<RuleId> = new Set([
  'path-missing',
  'line-out-of-range',
  'link-broken',
  'anchor-missing',
  'command-missing',
  'cli-command-unknown',
  'cli-flag-unknown',
  'symbol-missing',
  'example-unknown-keyword',
  'example-too-many-arguments',
  'example-missing-argument',
  'example-missing-import',
  'example-missing-attribute',
  'example-removed',
] satisfies RuleId[]);

/** Rules the code pass recomputes. */
export const CODE_RULES: ReadonlySet<RuleId> = new Set(['docstring-param-unknown', 'docstring-param-undocumented'] satisfies RuleId[]);

/** Rules the environment pass recomputes for a docs page. */
export const ENV_PAGE_RULES: ReadonlySet<RuleId> = new Set(['env-unused'] satisfies RuleId[]);

function surfaceFor(rule: RuleId, page: Surface): Surface {
  if (rule.startsWith('example-')) return 'example';
  if (rule.startsWith('docstring-')) return 'docstring';
  return page;
}

/** Severity, suppression comments and fingerprints, as `lintRepo` applies them. */
export function finish(model: LintModel, raw: PageFinding[]): Finding[] {
  const out: Finding[] = [];
  const occurrences = new Map<string, number>();
  const { repo, sha } = model;
  for (const { page, f } of raw) {
    if (!model.enabled(f.rule) || isSuppressed(page.doc, f.span.line, f.rule)) continue;
    const setting = model.config?.rules?.[f.rule];
    const severity: Severity = setting && setting !== 'off' ? setting : RULE_BY_ID.get(f.rule)!.severity;
    const key = `${f.rule}\0${page.target.path}\0${f.subject}`;
    const n = occurrences.get(key) ?? 0;
    occurrences.set(key, n + 1);
    out.push({
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
  return out;
}

/** A docs page as the checks read it. */
export function checkedPage(model: LintModel, path: string, text: string): CheckedPage | undefined {
  const target = model.targets.get(path);
  if (!target) return undefined;
  const disk = model.pages.get(path);
  if (disk && disk.text === text) return disk;
  return { target, doc: scanClaims(path, text), text };
}

/**
 * The docs pages of the workspace with the edited ones as their buffers hold them. `stub`
 * keeps only what other pages contribute to one page's checks (the names their examples
 * bind), so `checkSymbols` judges the edited page alone.
 */
export function workspacePages(model: LintModel, buffers: ReadonlyMap<string, CheckedPage>, opts: { only?: string } = {}): CheckedPage[] {
  const out: CheckedPage[] = [];
  for (const [path, disk] of model.pages) {
    const page = buffers.get(path) ?? disk;
    if (!opts.only || path === opts.only) out.push(page);
    else out.push({ target: page.target, doc: { ...page.doc, spans: [], links: [], lines: [] }, text: '' });
  }
  for (const [path, page] of buffers) if (!model.pages.has(path) && model.targets.has(path)) out.push(page);
  return out;
}

/**
 * Every page rule for one docs page (the env rules excepted): what `lintRepo` reports for
 * this page if its text were `page.text`.
 */
export async function lintPage(model: LintModel, page: CheckedPage, others: ReadonlyMap<string, CheckedPage> = new Map()): Promise<Finding[]> {
  const { facts, repo } = model;
  const { doc, target } = page;
  const on = (r: RuleId) => model.enabled(r);
  const raw: PageFinding[] = [];
  const push = (fs: PageFinding['f'][]) => {
    for (const f of fs) raw.push({ page, f });
  };

  const claims = pathClaims(doc, facts);
  await facts.loadIgnored(claims.flatMap((c) => c.candidates));
  if (on('path-missing') || on('line-out-of-range')) {
    const surface = target.surface === 'agent' || target.surface === 'readme' ? target.surface : 'docs';
    push(await checkPaths(doc, facts, claims, surface));
  }
  if (on('link-broken') || on('anchor-missing')) push(await checkLinks(doc, facts));
  if (on('command-missing')) push(await checkCommands(doc, { facts, repo, surface: target.surface }));
  if (on('cli-command-unknown') || on('cli-flag-unknown')) push(await checkCli(doc, { facts, repo, surface: target.surface }));

  const main = model.parsed[0];
  if (main && model.wantExamples && (target.surface !== 'agent' || /\.mdx?$/i.test(target.path))) {
    for (const e of await exampleMismatches(main, [{ path: target.path, text: page.text }], model.table, model.codeRepos, model.cache)) {
      raw.push({ page, f: exampleFinding(e, doc.lines) });
    }
  }
  if (main && on('symbol-missing')) {
    const pages = workspacePages(model, new Map([...others, [target.path, page]]), { only: target.path });
    raw.push(...(await checkSymbols(pages, model.table, model.parsed)).filter((x) => x.page.target.path === target.path));
  }
  return finish(model, raw);
}

/**
 * `env-unused` for one docs page: the variables it documents that no code reads. The token
 * search reads the whole repository, so this runs apart from `lintPage`, and only when the
 * page's variables change.
 */
export async function envFindings(model: LintModel, page: CheckedPage, others: ReadonlyMap<string, CheckedPage> = new Map()): Promise<Finding[]> {
  if (!model.enabled('env-unused')) return [];
  const pages = workspacePages(model, new Map([...others, [page.target.path, page]]));
  const raw = await checkEnv({ dir: model.root, repo: model.repo, paths: model.paths, pages, config: model.config, unused: true, undocumented: false });
  return finish(
    model,
    raw.filter((x) => x.page.target.path === page.target.path && x.f.rule === 'env-unused'),
  );
}

/** The variables a page documents, in order: when they change, `envFindings` runs again. */
export function envClaimNames(page: CheckedPage): string[] {
  if (HISTORY_PAGE.test(page.target.path)) return [];
  return docEnvClaims(page.doc)
    .filter((c) => !HISTORY_LINE.test(page.doc.lines[c.span.line - 1] ?? ''))
    .map((c) => c.name);
}

/** The module of a code file the snapshot parsed (Python or TypeScript/JavaScript library code). */
export function parsedModule(model: LintModel, path: string): PyModule | undefined {
  return model.parsed[0]?.modules.find((m) => m.path === path && m.lang !== 'go');
}

/** Parse a code file's buffer as the snapshot parsed the file. */
export async function parseBuffer(model: LintModel, path: string, text: string): Promise<PyModule | undefined> {
  const was = parsedModule(model, path);
  if (!was) return undefined;
  try {
    if (was.lang === 'ts') return await extractTs(text, { module: was.module, path, tsx: !/\.(ts|mts|cts)$/.test(path) });
    return await extractPython(text, { module: was.module, path, isPackage: /(^|\/)__init__\.py$/.test(path) });
  } catch {
    return undefined;
  }
}

/** The docstring rules for one code file, from its buffer. */
export async function lintCode(model: LintModel, path: string, text: string, mod?: PyModule): Promise<Finding[]> {
  const main = model.parsed[0];
  if (!main || !(model.enabled('docstring-param-unknown') || model.enabled('docstring-param-undocumented'))) return [];
  const m = mod ?? (await parseBuffer(model, path, text));
  if (!m) return [];
  const raw = await checkDocstrings({ ...main, modules: [m] }, async (p) => (p === path ? text : model.facts.text(p)));
  return finish(
    model,
    raw.filter((x) => x.page.target.path === path),
  );
}
