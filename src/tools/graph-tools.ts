import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import * as Q from '../graph/queries.js';
import { ingestPullRequest } from '../pr/ingest.js';
import { knownMismatches, predictBreaks, type KnownMismatch, type PredictedBreak } from '../pr/predict.js';
import { parsePrUrl } from '../pr/github.js';
import { result, Tracer, type ToolContext, type ToolDef } from './types.js';

const exec = promisify(execFile);

export type Severity = 'breaking' | 'api' | 'behavior';

export function severityOf(change: string): Severity {
  if (change === 'removed' || change === 'renamed' || change === 'export-removed') return 'breaking';
  if (change === 'signature') return 'api';
  return 'behavior';
}

const SEVERITY_ORDER: Record<Severity, number> = { breaking: 0, api: 1, behavior: 2 };

export interface ImpactRow {
  changed: string;
  change: string;
  before: string;
  after: string;
  reached: string;
  kind: 'DocSection' | 'CodeExample';
  doc: string;
  repo: string;
  path: string;
  section: string;
  heading: string;
  url: string;
  hops: number;
  /** Node names along the path, changed symbol first, doc last. */
  evidence: string[];
  /** Resolution of each edge along the path. */
  resolution: string[];
}

export interface ImpactedSection {
  section: string;
  heading: string;
  repo: string;
  path: string;
  url: string;
  severity: Severity;
  /** Shortest evidence path: changed symbol → … → doc node. */
  evidence: string[];
  hops: number;
  /** `exact` when every edge on the evidence path was resolved through imports and types. */
  confidence: 'exact' | 'by-name' | 'late';
  changes: { symbol: string; change: string; before: string; after: string }[];
  examples: string[];
  crossRepo: boolean;
}

export interface ImpactData {
  pr: { url: string; title: string; repo: string; state: string; before: string; after: string; docsTouched: string[] };
  changed: { symbol: string; change: string; before?: string; after?: string; renamedTo?: string }[];
  sections: ImpactedSection[];
  totalSections: number;
  /** Index of the first returned section (paging). */
  offset: number;
  truncated: boolean;
  /** Severity counts over all impacted sections (not only the ones shown). */
  counts: Record<Severity, number>;
  /**
   * Examples whose calls the code after the pull request no longer accepts (removed or
   * renamed symbols, stopped exports, signatures that reject the call) — a static
   * prediction, before anything runs. Over every impacted section, not only this page.
   */
  predicted: PredictedBreak[];
  /** Impacted examples that already did not fit the code when the graph was indexed. */
  mismatched: KnownMismatch[];
}

export const MAX_SECTIONS = 40;

function predictedSentence(predicted: PredictedBreak[]): string {
  const examples = [...new Set(predicted.map((p) => p.example.split(':').slice(1).join(':')))];
  if (!examples.length) return '';
  const n = examples.length;
  return ` ${n} example${n === 1 ? ' is' : 's are'} predicted to break, the call no longer fitting the changed code (${examples.slice(0, 3).join(', ')}${n > 3 ? ', …' : ''}).`;
}

/** Ingest the PR once per check (idempotent anyway) and return its change set. */
async function ensureIngested(ctx: ToolContext, tracer: Tracer, prUrl: string) {
  const url = parsePrUrl(prUrl).url;
  const existing = await tracer.run<{ ingested: number | null; title: string }>(
    `MATCH (pr:PullRequest {url: $url}) RETURN pr.ingested_at AS ingested, pr.title AS title`,
    { url },
  );
  if (existing.rows[0]?.ingested) return url;
  ctx.log?.(`ingesting ${url}`);
  await ingestPullRequest(tracer.graph, ctx.config, url);
  return url;
}

function confidenceOf(resolution: string[]): ImpactedSection['confidence'] {
  if (resolution.includes('late')) return 'late';
  return resolution.every((r) => r === 'exact') ? 'exact' : 'by-name';
}

export function groupImpact(rows: ImpactRow[]): ImpactedSection[] {
  const bySection = new Map<string, ImpactedSection>();
  for (const r of rows) {
    const sev = severityOf(r.change);
    const conf = confidenceOf(r.resolution);
    let s = bySection.get(r.section);
    if (!s) {
      s = {
        section: r.section,
        heading: r.heading,
        repo: r.repo,
        path: r.path,
        url: r.url,
        severity: sev,
        evidence: r.evidence,
        hops: r.hops,
        confidence: conf,
        changes: [],
        examples: [],
        crossRepo: false,
      };
      bySection.set(r.section, s);
    }
    const better =
      SEVERITY_ORDER[sev] < SEVERITY_ORDER[s.severity] ||
      (SEVERITY_ORDER[sev] === SEVERITY_ORDER[s.severity] && (r.hops < s.hops || (r.hops === s.hops && conf === 'exact' && s.confidence !== 'exact')));
    if (better) {
      s.severity = sev;
      s.evidence = r.evidence;
      s.hops = r.hops;
      s.confidence = conf;
    }
    if (!s.changes.some((c) => c.symbol === r.changed)) s.changes.push({ symbol: r.changed, change: r.change, before: r.before, after: r.after });
    if (r.kind === 'CodeExample' && !s.examples.includes(r.doc)) s.examples.push(r.doc);
  }
  return [...bySection.values()].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.hops - b.hops || a.section.localeCompare(b.section),
  );
}

function withHops(cypher: string, maxHops: number): string {
  return cypher.replace('[:CALLS*0..3]', `[:CALLS*0..${maxHops}]`);
}

export const impactTool: ToolDef<{ pr_url: string; max_hops?: number; offset?: number }, ImpactData> = {
  name: 'impact',
  description:
    'Find every doc section and code example a pull request can falsify, in any repository of the organisation. ' +
    'Walks changed symbol ← callers (up to max_hops, across repositories) ← MENTIONS/USES ← doc. ' +
    'Returns impacted sections ordered by severity (breaking: removed/renamed; api: signature; behavior: body changed) with the evidence path for each. ' +
    `Call this first for a PR. At most ${MAX_SECTIONS} sections come back per call; when more are impacted, call again with offset to page.`,
  input: z.object({
    pr_url: z.string().describe('GitHub pull request URL, e.g. https://github.com/FalkorDB/falkordb-py/pull/262'),
    max_hops: z.number().int().min(0).max(5).optional().describe('Maximum call hops between the changed symbol and the doc (default 3)'),
    offset: z.number().int().min(0).optional().describe(`Skip this many sections (paging: ${MAX_SECTIONS} per call; default 0)`),
  }),
  queries: [Q.impact, Q.prChanges, Q.predictedCalls, Q.mismatchesFor, Q.upsertPullRequest, Q.upsertChangedIn, Q.upsertMissingSymbols, Q.lateLinkSections, Q.lateLinkExamples],
  async run(ctx, input) {
    const tracer = new Tracer(ctx.graph);
    const url = await ensureIngested(ctx, tracer, input.pr_url);
    const pr = (
      await tracer.run<{ title: string; repo: string; state: string; before: string; after: string; docs: string[] }>(
        `MATCH (pr:PullRequest {url: $url}) RETURN pr.title AS title, pr.repo AS repo, pr.state AS state, pr.before_sha AS before, pr.after_sha AS after, pr.docs_touched AS docs`,
        { url },
      )
    ).rows[0]!;
    const changes = await tracer.run<{ symbol: string; change: string; before: string; after: string; renamedTo: string }>(Q.prChanges, { pr: url });
    const maxHops = input.max_hops ?? 3;
    const rows = await tracer.run<ImpactRow>(
      maxHops === 3 ? Q.impact : { ...Q.impact, cypher: withHops(Q.impact.cypher, maxHops) },
      { pr: url },
    );
    const sections = groupImpact(rows.rows);
    const offset = input.offset ?? 0;
    const page = sections.slice(offset, offset + MAX_SECTIONS);
    for (const s of sections) s.crossRepo = s.repo !== pr.repo;
    const counts = { breaking: 0, api: 0, behavior: 0 } as Record<Severity, number>;
    for (const s of sections) counts[s.severity]++;
    const predicted = await predictBreaks(tracer, url);
    const predictedIds = new Set(predicted.map((p) => p.example));
    const mismatched = (await knownMismatches(tracer, [...new Set(sections.flatMap((s) => s.examples))])).filter(
      (m) => !predictedIds.has(m.example) || !predicted.some((p) => p.example === m.example && p.detail === m.detail),
    );
    const data: ImpactData = {
      pr: { url, title: pr.title, repo: pr.repo, state: pr.state, before: pr.before, after: pr.after, docsTouched: pr.docs ?? [] },
      changed: changes.rows.map((c) => ({ symbol: c.symbol, change: c.change, before: c.before || undefined, after: c.after || undefined, renamedTo: c.renamedTo || undefined })),
      sections: page,
      totalSections: sections.length,
      offset,
      truncated: sections.length > offset + page.length,
      counts,
      predicted,
      mismatched,
    };
    const crossRepo = sections.filter((s) => s.crossRepo).length;
    // Added symbols can't make an existing doc false; count them apart.
    const added = changes.rows.filter((c) => c.change === 'added').length;
    const changedCount = changes.rows.length - added;
    const summary =
      changes.rows.length === 0
        ? `${url} changed no Python symbols in ${pr.repo}; no docs can be falsified through code.`
        : `${changedCount} changed symbol${changedCount === 1 ? '' : 's'}${added ? ` (and ${added} added)` : ''} reach${changedCount === 1 ? 'es' : ''} ${sections.length} doc section${sections.length === 1 ? '' : 's'} ` +
          `(${counts.breaking} breaking, ${counts.api} signature, ${counts.behavior} behavior; ${crossRepo} in other repositories).` +
          predictedSentence(predicted) +
          (mismatched.length ? ` ${new Set(mismatched.map((m) => m.example)).size} impacted example(s) already did not fit the code before this pull request.` : '') +
          (sections.length > MAX_SECTIONS || offset > 0
            ? ` Showing ${page.length ? `${offset + 1}–${offset + page.length}` : 'none'} of ${sections.length}` +
              (data.truncated ? `; call impact again with offset=${offset + page.length} for the rest.` : '.')
            : '');
    return result('impact', tracer, summary, data);
  },
};

export interface ClearedSymbol {
  symbol: string;
  name: string;
  repo: string;
  change: string;
  visibility: string;
  /** Raw text occurrences of the name across indexed docs (git grep -w), for the reader to check. */
  textMatches: number;
  grep: string;
}

export const clearanceTool: ToolDef<{ pr_url: string }, { cleared: ClearedSymbol[]; docsRepos: string[] }> = {
  name: 'clearance',
  description:
    'Proof of absence: the changed symbols that reach no doc section or example within 3 call hops in any repository. ' +
    'Each comes with a git grep command and its raw text-match count so a human can check the claim.',
  input: z.object({ pr_url: z.string() }),
  queries: [Q.clearance],
  async run(ctx, input) {
    const tracer = new Tracer(ctx.graph);
    const url = await ensureIngested(ctx, tracer, input.pr_url);
    const rows = await tracer.run<Omit<ClearedSymbol, 'textMatches' | 'grep'>>(Q.clearance, { pr: url });
    const docsRepos = (
      await tracer.run<{ name: string }>(`MATCH (d:DocSection)-[:DEFINED_IN]->(:File)-[:IN_REPO]->(r:Repo) RETURN DISTINCT r.name AS name ORDER BY name`)
    ).rows.map((r) => r.name);
    const cleared: ClearedSymbol[] = [];
    for (const r of rows.rows) {
      const grep = `git grep -nw ${shellQuote(r.name)} -- '*.md' '*.mdx'`;
      let textMatches = 0;
      for (const repo of docsRepos) {
        const dir = join(ctx.config.home, 'repos', ...repo.split('/'));
        if (!existsSync(dir)) continue;
        textMatches += await countMatches(dir, r.name);
      }
      cleared.push({ ...r, textMatches, grep });
    }
    const quiet = cleared.filter((c) => c.textMatches === 0).length;
    const changedCount =
      (await tracer.run<{ n: number }>(`MATCH (:PullRequest {url: $pr})<-[c:CHANGED_IN]-() WHERE c.kind <> 'added' RETURN count(c) AS n`, { pr: url })).rows[0]?.n ?? 0;
    const summary =
      changedCount === 0
        ? 'The PR changed no existing symbols; there is nothing to clear.'
        : cleared.length === 0
        ? 'Every changed symbol reaches at least one doc; nothing is cleared.'
        : `${cleared.length} changed symbols reach no doc within 3 hops (${quiet} also have zero text matches in the docs; ` +
          `${cleared.length - quiet} share a name with text in the docs but no path resolves to them).`;
    return result('clearance', tracer, summary, { cleared, docsRepos });
  },
};

async function countMatches(dir: string, name: string): Promise<number> {
  try {
    const { stdout } = await exec('git', ['grep', '-cw', name, '--', '*.md', '*.mdx'], { cwd: dir });
    return stdout
      .split('\n')
      .filter(Boolean)
      .reduce((n, line) => n + Number(line.split(':').pop() ?? 0), 0);
  } catch {
    return 0; // git grep exits 1 when nothing matches
  }
}

function shellQuote(s: string): string {
  return /^[\w.-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RankedSection {
  id: string;
  heading: string;
  page: string;
  pageScore: number;
  score: number;
}

export const rankSectionsTool: ToolDef<{ section_ids: string[] }, { ranked: RankedSection[]; method: 'pagerank' | 'in-degree' }> = {
  name: 'rank_sections',
  description:
    'Order doc sections by how central their page is in the docs (PageRank over LINKS_TO, summed per page), ' +
    'so the most-read stale page is fixed first.',
  input: z.object({ section_ids: z.array(z.string()).min(1).describe('DocSection ids from impact') }),
  queries: [Q.rankSections, Q.rankSectionsByLinks],
  async run(ctx, input) {
    const tracer = new Tracer(ctx.graph);
    let method: 'pagerank' | 'in-degree' = 'pagerank';
    let rows: RankedSection[];
    try {
      rows = (await tracer.run<RankedSection>(Q.rankSections, { ids: input.section_ids })).rows;
    } catch {
      method = 'in-degree';
      rows = (await tracer.run<RankedSection>(Q.rankSectionsByLinks, { ids: input.section_ids })).rows;
    }
    const top = rows[0];
    const summary = top
      ? `Ranked ${rows.length} sections by ${method === 'pagerank' ? 'PageRank of their page' : 'inbound links'}; most central: ${top.heading} (${top.page}).`
      : 'None of these ids are doc sections.';
    return result('rank_sections', tracer, summary, { ranked: rows, method });
  },
};

export interface SectionText {
  id: string;
  repo: string;
  path: string;
  heading: string;
  body: string;
  url: string;
  lineno: number;
  endLineno: number;
  examples: { id: string; lang: string; code: string; lineno: number }[];
}

export const readSectionTool: ToolDef<{ section_id: string }, SectionText | null> = {
  name: 'read_section',
  description: 'Read the current Markdown of a doc section and its code examples, before deciding whether and how to edit it.',
  input: z.object({ section_id: z.string() }),
  queries: [Q.readSection],
  async run(ctx, input) {
    const tracer = new Tracer(ctx.graph);
    const row = (await tracer.run<SectionText>(Q.readSection, { id: input.section_id })).rows[0];
    if (!row) return result('read_section', tracer, `No doc section ${input.section_id}.`, null);
    row.examples = (row.examples ?? []).filter(Boolean);
    return result('read_section', tracer, `${row.heading} (${row.path}, lines ${row.lineno}-${row.endLineno}, ${row.examples.length} examples).`, row);
  },
};
