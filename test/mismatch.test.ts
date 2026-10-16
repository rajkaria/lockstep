import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg, type IndexReport } from '../src/indexer/index.js';
import { FIXTURES, FIXTURE_REPOS, testGraph } from './helpers.js';

export const STALE_DOCS = { repo: 'acme/stale-docs', dir: join(FIXTURES, 'drift', 'stale-docs'), sha: 'fixture' };

describe('MISMATCH edges (index time)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let report: IndexReport;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('mismatch'));
    report = await indexOrg(graph, [...FIXTURE_REPOS.slice(0, 2), STALE_DOCS]);
  });
  afterAll(async () => done());

  it('records every example line that no longer fits the code, with the doc line', async () => {
    const rows = (
      await graph.run<{ ex: string; kind: string; sym: string; line: number; detail: string }>(
        `MATCH (e:CodeExample)-[m:MISMATCH]->(s:Symbol)
         RETURN e.id AS ex, m.kind AS kind, s.qualname AS sym, m.line AS line, m.detail AS detail ORDER BY line, kind`,
      )
    ).rows;
    expect(rows.map((r) => `${r.ex.replace('acme/stale-docs:docs/stale.md:', '#')} L${r.line} ${r.kind} → ${r.sym}: ${r.detail}`)).toEqual([
      '#0 L8 missing-import → miniclient: `miniclient` has no `connect`',
      '#0 L10 unknown-keyword → miniclient.client.Client.__init__: `Client` has no parameter `hostname`',
      '#1 L19 too-many-arguments → miniclient.graph.Graph.query: `Graph.query` takes at most 2 positional arguments; the example passes 3',
      '#1 L20 missing-attribute → miniclient.graph.Graph: `Graph` has no attribute `read_only`',
      '#2 L31 unknown-keyword → minisdk.rag.Rag.ask: `Rag.ask` has no parameter `top_k`',
    ]);
    expect(report.docs.find((d) => d.repo === 'acme/stale-docs')!.mismatches).toBe(5);
  });

  it('finds none in the consistent fixture docs', async () => {
    const { graph: g2, done: d2 } = await testGraph('mismatch-clean');
    try {
      const r = await indexOrg(g2, FIXTURE_REPOS);
      expect(r.docs.map((d) => d.mismatches)).toEqual(r.docs.map(() => 0));
    } finally {
      await d2();
    }
  });
});
