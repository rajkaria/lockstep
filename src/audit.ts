import { z } from 'zod';
import * as Q from './graph/queries.js';
import type { MismatchKind } from './indexer/signature.js';
import { lineUrl } from './pr/predict.js';
import { INDEX_VERSION } from './indexer/index.js';
import { runExampleTool } from './tools/run-example.js';
import { result, Tracer, type ToolContext, type ToolDef, type ToolResult } from './tools/types.js';

/**
 * A docs audit: how true the docs are to the code right now, with no pull request.
 * Static checks of every example against the code (MISMATCH edges), API coverage
 * (public symbols no doc names or calls), and example runs at the indexed commits.
 */
export interface AuditMismatch {
  example: string;
  url: string;
  repo: string;
  path: string;
  heading: string;
  line: number;
  kind: MismatchKind;
  detail: string;
  call: string;
  symbol: string;
}

export interface UndocumentedSymbol {
  qualname: string;
  repo: string;
  kind: string;
  signature: string;
  url: string;
  /** Symbols that call it, and how many of those live in other repositories. */
  callers: number;
  crossRepoCallers: number;
}

export interface AuditRun {
  example: string;
  url: string;
  status: 'pass' | 'fail' | 'timeout' | 'skipped' | 'error';
  error: string;
  reason: string;
}

export interface Deduction {
  points: number;
  why: string;
}

export interface AuditData {
  org: string;
  repos: { name: string; sha: string; symbols: number; sections: number; indexVersion?: number }[];
  /** A repository was indexed by an older Staleproof: no example checks or export flags until it is indexed again. */
  outdatedIndex?: boolean;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  deductions: Deduction[];
  examples: { total: number; python: number; linked: number; mismatched: number };
  mismatches: AuditMismatch[];
  coverage: { api: number; documented: number; percent: number };
  /** Public API no doc names or calls, most used first (top `limit`). */
  undocumented: UndocumentedSymbol[];
  /** Latest recorded run of each example at the indexed commits. */
  runs: AuditRun[];
  runCounts: { pass: number; fail: number; skipped: number; error: number };
  generatedAt: number;
}

export interface AuditOptions {
  /** Repositories to audit (default: every repository in the graph). */
  repos?: string[];
  /** Run up to this many examples at the indexed commits first (needs a sandbox). */
  run?: number;
  /** How many undocumented symbols to list. */
  limit?: number;
}

/** Directories whose Python is not the library's API. */
const NOT_API = /(^|\/)(tests?|testing|benchmarks?|scripts|examples?|docs?|tools|ci|\.github|noxfile\.py|setup\.py|conftest\.py)(\/|$)/;

interface SymRow {
  id: string;
  qualname: string;
  name: string;
  kind: string;
  repo: string;
  path: string;
  lineno: number;
  signature: string;
  visibility: string;
  /** Exported by a public package's `__init__` (indexed since 0.3; absent on older graphs). */
  exported?: boolean | null;
  docs: number;
  callers: number;
  callerRepos: string[];
}

/**
 * The public API of a set of symbols: what a repository's packages export (names bound
 * in a public `__init__`, and the public methods of exported classes) when the graph
 * knows it, and always the way Python spells it: no `_` in any part of the qualified
 * name, not nested inside a function, not in tests/scripts/examples.
 */
export function publicApi(rows: SymRow[]): SymRow[] {
  // Repositories indexed with export information: their API is what their packages export.
  const withExports = new Set(rows.filter((r) => r.exported).map((r) => r.repo));
  const fnLike = new Set(rows.filter((r) => r.kind === 'function' || r.kind === 'method').map((r) => `${r.repo}:${r.qualname}`));
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.repo}:${r.qualname}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (r.visibility !== 'public' || NOT_API.test(r.path)) return false;
    const parts = r.qualname.split('.');
    // Exported names count wherever they are defined (`httpx._api.get` is `httpx.get`).
    if (withExports.has(r.repo)) {
      if (!r.exported) return false;
    } else if (parts.some((p) => p.startsWith('_') && !/^__.*__$/.test(p))) {
      return false;
    }
    for (let i = 1; i < parts.length; i++) {
      if (fnLike.has(`${r.repo}:${parts.slice(0, i).join('.')}`)) return false;
    }
    return true;
  });
}

/** Most used first: called from other repositories, classes, then by how many symbols call it. */
function importance(r: SymRow): number {
  const cross = r.callerRepos.filter((x) => x !== r.repo).length;
  return cross * 1000 + (r.kind === 'class' ? 100 : 0) + r.callers;
}

/**
 * 100 minus deductions: 8 per example that no longer fits the code (at most 50), 6 per
 * other example that fails when run (at most 30), 0.3 per missing percent of API coverage.
 * `failingOnly` counts failing runs of examples not already counted as mismatched.
 */
export function scoreAudit(
  a: Pick<AuditData, 'examples' | 'coverage' | 'runCounts'> & { failingOnly?: number },
): { score: number; grade: AuditData['grade']; deductions: Deduction[] } {
  const failing = a.failingOnly ?? a.runCounts.fail;
  const deductions: Deduction[] = [];
  if (a.examples.mismatched) {
    deductions.push({
      points: Math.min(50, a.examples.mismatched * 8),
      why: `${a.examples.mismatched} example${a.examples.mismatched === 1 ? '' : 's'} call${a.examples.mismatched === 1 ? 's' : ''} the code in a way it no longer accepts (8 each, at most 50)`,
    });
  }
  if (failing) {
    deductions.push({
      points: Math.min(30, failing * 6),
      why: `${failing} ${a.examples.mismatched ? 'more ' : ''}example${failing === 1 ? '' : 's'} fail${failing === 1 ? 's' : ''} when run (6 each, at most 30)`,
    });
  }
  if (a.coverage.api > 0 && a.coverage.percent < 100) {
    const pts = Math.round((100 - a.coverage.percent) * 0.3);
    if (pts > 0) deductions.push({ points: pts, why: `${a.coverage.api - a.coverage.documented} of ${a.coverage.api} public symbols are named or called by no doc (0.3 per missing percent)` });
  }
  const score = Math.max(0, 100 - deductions.reduce((s, d) => s + d.points, 0));
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  return { score, grade, deductions };
}

export function auditSummary(d: AuditData): string {
  const scope = d.repos.length === 1 ? d.repos[0]!.name : `${d.repos.length} repositories`;
  const parts = [
    `Docs health ${d.score}/100 (${d.grade}) for ${scope}.`,
    d.examples.mismatched
      ? `${d.examples.mismatched} of ${d.examples.linked} examples that call the code no longer fit it (${d.mismatches.length} line${d.mismatches.length === 1 ? '' : 's'}).`
      : `All ${d.examples.linked} examples that call the code fit it.`,
    `${d.coverage.documented} of ${d.coverage.api} public symbols (${d.coverage.percent}%) are named or called by a doc.`,
  ];
  const ran = d.runCounts.pass + d.runCounts.fail;
  if (ran) parts.push(`${d.runCounts.fail} of ${ran} examples run at the indexed commits fail.`);
  if (d.outdatedIndex) parts.push('Indexed by an older Staleproof: examples are not checked against the code until the repositories are indexed again (staleproof index).');
  return parts.join(' ');
}

export const auditTool: ToolDef<{ repos?: string[]; limit?: number }, AuditData> = {
  name: 'audit_docs',
  description:
    'Audit the docs of indexed repositories with no pull request: a 0-100 health score, every example line that no longer fits the code it calls ' +
    '(unknown keywords, wrong argument counts, names that no longer exist, found statically across repositories), API coverage (public symbols no doc names or calls, most used first) ' +
    'and the latest example runs at the indexed commits.',
  input: z.object({
    repos: z.array(z.string()).optional().describe('Repositories to audit as owner/name (default: every repository in the graph)'),
    limit: z.number().int().min(0).max(200).optional().describe('How many undocumented symbols to list (default 25)'),
  }),
  queries: [Q.auditRepos, Q.auditExamples, Q.auditMismatches, Q.auditRuns, Q.auditSymbols],
  run: (ctx, input) => auditDocs(ctx, { repos: input.repos, limit: input.limit }),
};

export async function auditDocs(ctx: ToolContext, opts: AuditOptions = {}): Promise<ToolResult<AuditData>> {
  const tracer = new Tracer(ctx.graph);
  const repoRows = (await tracer.run<{ name: string; sha: string; symbols: number; sections: number; indexVersion: number }>(Q.auditRepos, { repos: opts.repos ?? [] })).rows;
  if (opts.repos?.length) {
    const have = new Set(repoRows.map((r) => r.name.toLowerCase()));
    const missing = opts.repos.filter((r) => !have.has(r.toLowerCase()));
    if (missing.length) throw new Error(`not indexed in the "${ctx.graph.name}" graph: ${missing.join(', ')}`);
  }
  const repos = repoRows.map((r) => r.name);
  const shas = new Map(repoRows.map((r) => [r.name, r.sha]));

  const examples = (await tracer.run<{ id: string; lang: string; url: string; repo: string; directive: string; uses: number }>(Q.auditExamples, { repos })).rows;
  const exampleIds = [...new Set(examples.map((e) => e.id))];

  const mismatches = (await tracer.run<AuditMismatch & { symbolRepo: string }>(Q.auditMismatches, { repos })).rows.map(({ symbolRepo: _, ...m }) => ({
    ...m,
    url: lineUrl(m.url, m.line),
  }));

  if (opts.run && opts.run > 0) {
    const mismatched = new Set(mismatches.map((m) => m.example));
    const candidates = examples
      .filter((e) => e.lang === 'python' && e.uses > 0 && !e.directive)
      .sort((a, b) => Number(mismatched.has(b.id)) - Number(mismatched.has(a.id)) || b.uses - a.uses)
      .slice(0, opts.run);
    for (const [i, e] of candidates.entries()) {
      ctx.log?.(`run ${i + 1}/${candidates.length}  ${e.id}`);
      try {
        await runExampleTool.run(ctx, { example_id: e.id });
      } catch (err) {
        ctx.log?.(`  ${(err as Error).message}`);
      }
    }
  }

  const runRows = (
    await tracer.run<{ example: string; url: string; status: AuditRun['status']; error: string | null; reason: string | null; installed: string[] | null }>(Q.auditRuns, {
      ids: exampleIds,
    })
  ).rows;
  // Only runs against the commits the graph holds now; the latest attempt per example wins.
  const current = (installed: string[] | null) =>
    (installed ?? []).every((x) => {
      const at = x.lastIndexOf('@');
      const sha = shas.get(x.slice(0, at));
      return sha === undefined || sha === x.slice(at + 1);
    });
  const latest = new Map<string, AuditRun>();
  for (const r of runRows) {
    if (!current(r.installed)) continue;
    latest.set(r.example, { example: r.example, url: r.url, status: r.status, error: r.error ?? '', reason: r.reason ?? '' });
  }
  const runs = [...latest.values()].sort((a, b) => a.example.localeCompare(b.example));
  const runCounts = { pass: 0, fail: 0, skipped: 0, error: 0 };
  for (const r of runs) {
    if (r.status === 'pass') runCounts.pass++;
    else if (r.status === 'fail' || r.status === 'timeout') runCounts.fail++;
    else if (r.status === 'skipped') runCounts.skipped++;
    else runCounts.error++;
  }

  const symbols = (await tracer.run<SymRow>(Q.auditSymbols, { repos })).rows;
  const api = publicApi(symbols);
  // A class is documented when the docs name it or call any of its methods (`g.query(...)` documents `Graph`).
  const withDocumentedMembers = new Set(
    symbols.filter((s) => s.docs > 0 && s.kind === 'method').map((s) => `${s.repo}:${s.qualname.slice(0, s.qualname.lastIndexOf('.'))}`),
  );
  for (const s of api) if (s.docs === 0 && s.kind === 'class' && withDocumentedMembers.has(`${s.repo}:${s.qualname}`)) s.docs = 1;
  const documented = api.filter((s) => s.docs > 0).length;
  const coverage = { api: api.length, documented, percent: api.length ? Math.round((documented / api.length) * 1000) / 10 : 100 };
  const blob = (r: SymRow) => `https://github.com/${r.repo}/blob/${shas.get(r.repo) ?? 'HEAD'}/${r.path}#L${r.lineno}`;
  const undocumented = api
    .filter((s) => s.docs === 0)
    .sort((a, b) => importance(b) - importance(a) || a.qualname.localeCompare(b.qualname))
    .slice(0, opts.limit ?? 25)
    .map((s) => ({
      qualname: s.qualname,
      repo: s.repo,
      kind: s.kind,
      signature: s.signature,
      url: blob(s),
      callers: s.callers,
      crossRepoCallers: s.callerRepos.filter((x) => x !== s.repo).length,
    }));

  const examplesSummary = {
    total: exampleIds.length,
    python: new Set(examples.filter((e) => e.lang === 'python').map((e) => e.id)).size,
    linked: new Set(examples.filter((e) => e.uses > 0).map((e) => e.id)).size,
    mismatched: new Set(mismatches.map((m) => m.example)).size,
  };
  const mismatchedIds = new Set(mismatches.map((m) => m.example));
  const failingOnly = runs.filter((r) => (r.status === 'fail' || r.status === 'timeout') && !mismatchedIds.has(r.example)).length;
  const { score, grade, deductions } = scoreAudit({ examples: examplesSummary, coverage, runCounts, failingOnly });
  const data: AuditData = {
    org: ctx.graph.name,
    repos: repoRows,
    outdatedIndex: repoRows.some((r) => (r.indexVersion ?? 0) < INDEX_VERSION),
    score,
    grade,
    deductions,
    examples: examplesSummary,
    mismatches,
    coverage,
    undocumented,
    runs,
    runCounts,
    generatedAt: Date.now(),
  };
  return result('audit_docs', tracer, auditSummary(data), data);
}
