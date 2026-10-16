import type { OrgGraph } from './graph/client.js';
import * as Q from './graph/queries.js';

export interface Facts {
  org: string;
  generatedAt: string;
  falkordb: string;
  nodes: Record<string, number>;
  edges: Record<string, number>;
  repos: { name: string; sha: string; packages: string[]; symbols: number; sections: number; examples: number; pythonExamples: number }[];
  calls: { exact: number; byName: number; crossRepo: number };
  uses: { exact: number; byName: number };
  dependsOn: { from: string; to: string; spec: string }[];
  crossRepoDocPaths: number;
  samplePaths: { symbol: string; doc: string; hops: number; path: string[] }[];
  impactQueryMs: { symbol: string; ms: number; rows: number }[];
  pullRequests: { url: string; title: string; changed: number; sections: number; otherRepos: number }[];
  runs: { example: string; url: string; side: string; status: string; error: string; reason: string; installed: string[]; pr: string | null }[];
  grepBaseline: GrepBaseline[];
}

export interface GrepBaseline {
  url: string;
  names: string[];
  /** Doc sections the impact traversal reaches. */
  reached: number;
  /** …of which a whole-word search for a changed name also finds. */
  grepFound: number;
  /** Sections the search matches that the traversal does not reach. */
  grepOutside: number;
}

/**
 * What a reviewer gets without the graph: a whole-word search of every doc section
 * for the names of the changed symbols, compared with what the traversal reaches.
 */
export function grepBaseline(url: string, names: string[], reached: string[], sections: { id: string; body: string | null }[]): GrepBaseline {
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = names.length ? new RegExp(`\\b(?:${names.map(esc).join('|')})\\b`) : null;
  const hits = new Set(re ? sections.filter((d) => re.test(d.body ?? '')).map((d) => d.id) : []);
  const reachedSet = new Set(reached);
  const grepFound = [...reachedSet].filter((id) => hits.has(id)).length;
  return { url, names, reached: reachedSet.size, grepFound, grepOutside: hits.size - grepFound };
}

/** Every number Staleproof's README quotes, computed from the live graph. */
export async function collectFacts(graph: OrgGraph, falkordbVersion = 'unknown'): Promise<Facts> {
  const nodes: Record<string, number> = {};
  for (const r of (await graph.run<{ label: string; n: number }>(Q.graphCounts)).rows) nodes[r.label] = r.n;
  const edges: Record<string, number> = {};
  for (const r of (await graph.run<{ type: string; n: number }>(Q.edgeCounts)).rows) edges[r.type] = r.n;

  const repos = (await graph.run<Facts['repos'][number]>(Q.factsRepos)).rows;
  const calls = (await graph.run<Facts['calls']>(Q.factsCalls)).rows[0] ?? { exact: 0, byName: 0, crossRepo: 0 };
  const uses = (await graph.run<Facts['uses']>(Q.factsUses)).rows[0] ?? { exact: 0, byName: 0 };
  const dependsOn = (await graph.run<Facts['dependsOn'][number]>(Q.factsDependsOn)).rows;
  const cross = (await graph.run<{ n: number }>(Q.factsCrossRepoDocPaths)).rows[0]?.n ?? 0;
  const samplePaths = (await graph.run<Facts['samplePaths'][number]>(Q.factsSamplePaths)).rows;

  const impactQueryMs: Facts['impactQueryMs'] = [];
  for (const s of samplePaths.slice(0, 3)) {
    const r = await graph.run(Q.impactFromSymbol, { qualname: s.symbol, maxHops: 3 });
    impactQueryMs.push({ symbol: s.symbol, ms: r.ms, rows: r.rows.length });
  }

  const pullRequests = (await graph.run<Facts['pullRequests'][number]>(Q.factsPullRequests)).rows;
  const runs = (await graph.run<Facts['runs'][number]>(Q.factsRuns)).rows;
  const bodies = (await graph.run<{ id: string; body: string | null }>(Q.factsSectionBodies)).rows;
  const grep = (await graph.run<{ url: string; names: string[]; reached: string[] }>(Q.factsGrepBaseline)).rows.map((r) =>
    grepBaseline(r.url, r.names, r.reached, bodies),
  );

  return {
    pullRequests,
    runs,
    grepBaseline: grep,
    org: graph.name,
    generatedAt: new Date().toISOString(),
    falkordb: falkordbVersion,
    nodes,
    edges,
    repos,
    calls,
    uses,
    dependsOn,
    crossRepoDocPaths: cross,
    samplePaths,
    impactQueryMs,
  };
}

export function factsMarkdown(f: Facts): string {
  const lines: string[] = [];
  lines.push(`# FACTS`, '');
  lines.push(
    `Generated from the \`${f.org}\` graph by \`staleproof facts\` at ${f.generatedAt} (FalkorDB ${f.falkordb}).`,
    'Every number in the README comes from this file. Regenerate it; never edit it by hand.',
    '',
  );
  lines.push('## Repositories', '', '| Repository | Commit | Symbols | Doc sections | Code examples (Python) |', '|---|---|---:|---:|---:|');
  for (const r of f.repos) {
    lines.push(`| [${r.name}](https://github.com/${r.name}) | \`${String(r.sha).slice(0, 7)}\` | ${r.symbols} | ${r.sections} | ${r.examples} (${r.pythonExamples}) |`);
  }
  lines.push('', '## Graph', '', '| Nodes (live) | Count |', '|---|---:|');
  for (const [k, v] of Object.entries(f.nodes)) lines.push(`| ${k} | ${v} |`);
  lines.push('', '| Edges | Count |', '|---|---:|');
  for (const [k, v] of Object.entries(f.edges)) lines.push(`| ${k} | ${v} |`);
  lines.push(
    '',
    '## Resolution quality',
    '',
    `- CALLS edges: ${f.calls.exact + f.calls.byName} (${f.calls.exact} exact through imports and types, ${f.calls.byName} by name inside an imported repository)`,
    `- CALLS edges that cross a repository boundary: ${f.calls.crossRepo}`,
    `- USES edges from code examples: ${f.uses.exact + f.uses.byName} (${f.uses.exact} exact, ${f.uses.byName} by name)`,
    `- Symbol → doc paths (≤ 3 call hops) that cross a repository boundary: ${f.crossRepoDocPaths}`,
    '',
    '## Repository dependencies',
    '',
  );
  for (const d of f.dependsOn) lines.push(`- ${d.from} → ${d.to} (${d.spec})`);
  lines.push('', '## Sample cross-repository paths', '');
  for (const p of f.samplePaths) lines.push(`- ${p.hops} hops: ${p.path.map((x) => `\`${x}\``).join(' ← ')}`);
  lines.push('', '## Pull requests checked', '', '| Pull request | Changed symbols | Doc sections reached (≤ 3 hops) | …in other repositories |', '|---|---:|---:|---:|');
  for (const p of f.pullRequests) lines.push(`| [${p.title.replace(/\|/g, '\\|')}](${p.url}) | ${p.changed} | ${p.sections} | ${p.otherRepos} |`);
  if (f.grepBaseline.length) {
    const sum = (k: 'reached' | 'grepFound' | 'grepOutside') => f.grepBaseline.reduce((n, g) => n + g[k], 0);
    lines.push(
      '',
      '## Without the graph: grep for the changed names',
      '',
      'For each pull request, a whole-word search of every live doc section for the names of the symbols it changed',
      '(what a reviewer can do without the graph), next to the sections the impact traversal reaches.',
      '',
      '| Pull request | Changed names | Reached by the graph | …that grep also finds | grep matches outside them |',
      '|---|---|---:|---:|---:|',
    );
    for (const g of f.grepBaseline) {
      lines.push(`| ${g.url.replace('https://github.com/', '')} | ${g.names.map((n) => `\`${n}\``).join(', ')} | ${g.reached} | ${g.grepFound} | ${g.grepOutside} |`);
    }
    lines.push('', `Total: the graph reaches ${sum('reached')} sections; grep finds ${sum('grepFound')} of them and matches ${sum('grepOutside')} others.`);
  }
  lines.push('', '## Example runs (sandbox)', '');
  const byStatus = new Map<string, number>();
  for (const r of f.runs) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  lines.push(`${f.runs.length} recorded runs: ${[...byStatus].map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}.`, '');
  if (f.runs.length) {
    lines.push('| Example | Side | Status | Error / reason | Installed |', '|---|---|---|---|---|');
    for (const r of f.runs) {
      const why = (r.error || r.reason || '').replace(/\|/g, '\\|').slice(0, 120);
      lines.push(`| [${r.example}](${r.url}) | ${r.side}${r.pr ? ` of ${r.pr.replace('https://github.com/', '')}` : ''} | ${r.status} | ${why} | ${r.installed.map((i) => i.replace(/@(\w{7})\w+/, '@$1')).join(', ')} |`);
    }
  }
  lines.push('', '## Impact query timing (server-side, FalkorDB)', '', '| Changed symbol | Rows | ms |', '|---|---:|---:|');
  for (const t of f.impactQueryMs) lines.push(`| \`${t.symbol}\` | ${t.rows} | ${t.ms.toFixed(2)} |`);
  lines.push('');
  return lines.join('\n');
}
