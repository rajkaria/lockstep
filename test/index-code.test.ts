import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import * as Q from '../src/graph/queries.js';
import { buildSymbolTable, newRunId, parseRepo, writeCode, type RepoIndexReport } from '../src/indexer/index.js';
import { FIXTURE_REPOS, testGraph } from './helpers.js';

describe('writeCode (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let reports: RepoIndexReport[];

  beforeAll(async () => {
    ({ graph, done } = await testGraph('code'));
    const parsed = await Promise.all(FIXTURE_REPOS.map((c) => parseRepo(c)));
    reports = await writeCode(graph, parsed, buildSymbolTable(parsed), newRunId());
  });
  afterAll(async () => done());

  it('writes repositories, files and symbols', async () => {
    const r = await graph.run<{ qualname: string; kind: string }>(Q.repoSymbols, { repo: 'acme/mini-client' });
    expect(r.rows.map((x) => `${x.kind} ${x.qualname}`)).toContain('method miniclient.graph.Graph.query');
    const files = await graph.run<{ n: number }>(`MATCH (:File)-[:IN_REPO]->(:Repo {name: 'acme/mini-sdk'}) RETURN count(*) AS n`);
    expect(files.rows[0]!.n).toBe(4);
    expect(reports.find((x) => x.repo === 'acme/mini-client')!.symbols).toBeGreaterThan(10);
  });

  it('writes cross-repository CALLS edges that a variable-length path can follow', async () => {
    const r = await graph.run<{ path: string[] }>(`
      MATCH p = (a:Symbol {qualname: 'minisdk.rag.Rag.ask'})-[:CALLS*1..3]->(b:Symbol {qualname: 'miniclient.asyncio.client.AsyncGraph.query'})
      RETURN [n IN nodes(p) | n.id] AS path`);
    expect(r.rows[0]!.path).toEqual([
      'acme/mini-sdk:minisdk.rag.Rag.ask',
      'acme/mini-sdk:minisdk.connection.Connection.run',
      'acme/mini-client:miniclient.asyncio.client.AsyncGraph.query',
    ]);
    expect(reports.find((x) => x.repo === 'acme/mini-sdk')!.calls.crossRepo).toBe(4);
  });

  it('is idempotent and marks removed symbols gone instead of deleting them', async () => {
    const parsed = await Promise.all(FIXTURE_REPOS.map((c) => parseRepo(c)));
    const client = parsed.find((p) => p.checkout.repo === 'acme/mini-client')!;
    const graphMod = client.modules.find((m) => m.module === 'miniclient.graph')!;
    graphMod.defs = graphMod.defs.filter((d) => d.name !== 'delete');
    const again = await writeCode(graph, parsed, buildSymbolTable(parsed), newRunId());
    expect(again.find((x) => x.repo === 'acme/mini-client')!.gone).toBe(1);
    const r = await graph.run<{ status: string; n: number }>(`MATCH (s:Symbol) RETURN s.status AS status, count(s) AS n ORDER BY status`);
    expect(r.rows.find((x) => x.status === 'gone')!.n).toBe(1);
    const dupes = await graph.run<{ n: number }>(`MATCH (s:Symbol) WITH s.id AS id, count(*) AS c WHERE c > 1 RETURN count(id) AS n`);
    expect(dupes.rows[0]!.n).toBe(0);
  });
});
