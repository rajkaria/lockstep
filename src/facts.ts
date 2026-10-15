import type { OrgGraph } from './graph/client.js';
import * as Q from './graph/queries.js';

export interface Facts {
  org: string;
  generatedAt: string;
  falkordb: string;
  nodes: Record<string, number>;
  edges: Record<string, number>;
  repos: { name: string; sha: string; symbols: number; sections: number; examples: number; pythonExamples: number }[];
  calls: { exact: number; byName: number; crossRepo: number };
  uses: { exact: number; byName: number };
  dependsOn: { from: string; to: string; spec: string }[];
  crossRepoDocPaths: number;
  samplePaths: { symbol: string; doc: string; hops: number; path: string[] }[];
  impactQueryMs: { symbol: string; ms: number; rows: number }[];
}

/** Every number Lockstep's README quotes, computed from the live graph. */
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

  return {
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
    `Generated from the \`${f.org}\` graph by \`lockstep-docs facts\` at ${f.generatedAt} (FalkorDB ${f.falkordb}).`,
    'Every number in the README comes from this file. Regenerate it; never edit it by hand.',
    '',
  );
  lines.push('## Repositories', '', '| Repository | Commit | Symbols | Doc sections | Code examples (Python) |', '|---|---|---:|---:|---:|');
  for (const r of f.repos) {
    lines.push(`| [${r.name}](https://github.com/${r.name}) | \`${String(r.sha).slice(0, 7)}\` | ${r.symbols} | ${r.sections} | ${r.examples} (${r.pythonExamples}) |`);
  }
  lines.push('', '## Graph', '', '| Nodes | Count |', '|---|---:|');
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
  lines.push('', '## Impact query timing (server-side, FalkorDB)', '', '| Changed symbol | Rows | ms |', '|---|---:|---:|');
  for (const t of f.impactQueryMs) lines.push(`| \`${t.symbol}\` | ${t.rows} | ${t.ms.toFixed(2)} |`);
  lines.push('');
  return lines.join('\n');
}
