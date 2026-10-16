import { z } from 'zod';
import * as Q from '../graph/queries.js';
import { knownMismatches, type KnownMismatch } from '../pr/predict.js';
import { groupImpact, type ImpactRow } from './graph-tools.js';
import { result, Tracer, type ToolDef } from './types.js';

export interface SymbolMatch {
  id: string;
  qualname: string;
  kind: string;
  repo: string;
  signature: string;
  url: string;
}

export interface DocsForSection {
  section: string;
  heading: string;
  repo: string;
  url: string;
  /** Shortest path: the symbol → … → doc node. */
  evidence: string[];
  hops: number;
  confidence: 'exact' | 'by-name' | 'late';
  examples: string[];
  /** Which of the looked-up symbols reach this section. */
  symbols: string[];
}

export interface DocsForData {
  query: string;
  symbols: SymbolMatch[];
  /** More symbols matched than were looked up (ambiguous name): narrow it with a qualified name or repos. */
  ambiguous: boolean;
  sections: DocsForSection[];
  /** Lines in those examples that already do not fit the code. */
  mismatched: KnownMismatch[];
}

const MAX_SYMBOLS = 5;

/**
 * Which docs reach a symbol — before you change it. The same walk as `impact`, started
 * from a name instead of a pull request: for a coding agent about to edit a function,
 * the doc sections and examples to update in the same change.
 */
export const docsForTool: ToolDef<{ symbol: string; repos?: string[] }, DocsForData> = {
  name: 'docs_for_symbol',
  description:
    'Which doc sections and code examples depend on a symbol, in any repository, with the evidence path for each: symbol ← up to 3 callers ← doc. ' +
    'Call it before changing a function, class or method to know which docs to update in the same change. ' +
    'The symbol can be an id (owner/repo:pkg.mod.Class.method), a qualified name, a dotted suffix like Graph.query, or a bare name.',
  input: z.object({
    symbol: z.string().min(1).describe('owner/repo:pkg.mod.Class.method, pkg.mod.Class.method, Class.method or method'),
    repos: z.array(z.string()).optional().describe('Only symbols defined in these repositories (owner/name)'),
  }),
  queries: [Q.docsForSymbol, Q.findSymbols, Q.mismatchesFor],
  async run(ctx, input) {
    const tracer = new Tracer(ctx.graph);
    const name = input.symbol.trim();
    const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    const found = (
      await tracer.run<SymbolMatch & { name: string; path: string; lineno: number }>(Q.findSymbols, {
        name,
        suffix: `.${bare}`,
        repos: input.repos ?? [],
      })
    ).rows;
    // Exact id or qualified name wins over suffix and bare-name matches.
    const exact = found.filter((s) => s.id === name || s.qualname === bare);
    const pool = exact.length ? exact : found;
    const picked = pool.slice(0, MAX_SYMBOLS);
    const symbols: SymbolMatch[] = picked.map((s) => ({
      id: s.id,
      qualname: s.qualname,
      kind: s.kind,
      repo: s.repo,
      signature: s.signature,
      url: `https://github.com/${s.repo}/blob/HEAD/${s.path}#L${s.lineno}`,
    }));
    if (!symbols.length) {
      return result('docs_for_symbol', tracer, `No live symbol in the "${ctx.graph.name}" graph is named ${name}.`, {
        query: name,
        symbols: [],
        ambiguous: false,
        sections: [],
        mismatched: [],
      });
    }
    const rows = (await tracer.run<ImpactRow>(Q.docsForSymbol, { ids: symbols.map((s) => s.id) })).rows;
    const bySection = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!bySection.has(r.section)) bySection.set(r.section, new Set());
      bySection.get(r.section)!.add(r.changed);
    }
    const sections: DocsForSection[] = groupImpact(rows).map((s) => ({
      section: s.section,
      heading: s.heading,
      repo: s.repo,
      url: s.url,
      evidence: s.evidence,
      hops: s.hops,
      confidence: s.confidence,
      examples: s.examples,
      symbols: [...(bySection.get(s.section) ?? [])],
    }));
    const mismatched = await knownMismatches(tracer, [...new Set(sections.flatMap((s) => s.examples))]);
    const ambiguous = pool.length > 1 && !exact.length;
    const direct = sections.filter((s) => s.hops <= 1).length;
    const who = symbols.length === 1 ? symbols[0]!.qualname : `${symbols.length} symbols named ${name}${pool.length > picked.length ? ` (of ${pool.length})` : ''}`;
    const summary =
      sections.length === 0
        ? `No doc section or example reaches ${who} within 3 call hops: changing it cannot make a doc false through the code.`
        : `${sections.length} doc section${sections.length === 1 ? '' : 's'} reach${sections.length === 1 ? 'es' : ''} ${who} ` +
          `(${direct} name or call it directly; ${new Set(sections.map((s) => s.repo)).size} repositor${new Set(sections.map((s) => s.repo)).size === 1 ? 'y' : 'ies'}).` +
          (mismatched.length ? ` ${mismatched.length} line(s) in those examples already do not fit the code.` : '') +
          (ambiguous ? ' The name is ambiguous: pass a qualified name or repos to narrow it.' : '');
    return result('docs_for_symbol', tracer, summary, { query: name, symbols, ambiguous, sections, mismatched });
  },
};
