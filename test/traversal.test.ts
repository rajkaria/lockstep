import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import * as Q from '../src/graph/queries.js';
import { testGraph } from './helpers.js';

/**
 * FalkorDB 4.18.3 (the falkordblite build `lockstep-docs db start` runs) can miss nodes in a variable-length
 * pattern that binds no path variable when a node is reachable along two routes of different length: here
 * `search` calls `err` directly and through `validate`, so callers above `search` drop out of
 * `(err)<-[:CALLS*0..3]-(t)`. `WHERE NOT (pattern)` then "proves" an absence that isn't there. The shape is the
 * one found in GraphRAG-SDK (RetrieverError ← RetrievalStrategy.search / ._validate ← GraphRAG.retrieve ←
 * GraphRAG.completion ← the docs' quickstart). Every product query must give the true answer on it.
 */
describe('variable-length traversals (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  const PR = 'https://github.com/acme/lib/pull/1';
  const id = (name: string) => `acme/lib:${name}`;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('traversal'));
    const names = ['err', 'validate', 'search', 'retrieve', 'completion', 'retrieve_sync'];
    await graph.run(`UNWIND $names AS n CREATE (:Symbol {id: 'acme/lib:' + n, qualname: n, name: n, repo: 'acme/lib', status: 'live'})`, { names });
    // Insertion order matters to the bug: the longer route (through `validate`) must be walked first.
    const calls = [
      ['search', 'validate'], ['search', 'err'], ['validate', 'err'], ['retrieve', 'search'],
      ['completion', 'retrieve'], ['retrieve_sync', 'retrieve'],
    ];
    for (const [a, b] of calls) {
      await graph.run(`MATCH (a:Symbol {qualname: $a}), (b:Symbol {qualname: $b}) CREATE (a)-[:CALLS]->(b)`, { a, b });
    }
    await graph.run(`
      CREATE (e:CodeExample {id: 'acme/docs:quickstart.py:0', repo: 'acme/docs', path: 'quickstart.py', status: 'live'})
      WITH e MATCH (s:Symbol {qualname: 'completion'}) CREATE (e)-[:USES]->(s)`);
    await graph.run(`
      CREATE (pr:PullRequest {url: $pr, repo: 'acme/lib', title: 'Reword RetrieverError'})
      WITH pr MATCH (s:Symbol {qualname: 'err'}) CREATE (s)-[:CHANGED_IN {kind: 'modified'}]->(pr)`, { pr: PR });
    await graph.run(`
      CREATE (d:Decision {id: 'dec-1', text: 'Error messages are part of the public API', status: 'active', created_at: 1})
      WITH d MATCH (s:Symbol {qualname: 'err'}) CREATE (d)-[:GOVERNS]->(s)`);
  });
  afterAll(async () => done());

  it('clearance does not clear a symbol whose doc is three calls away along the shorter route', async () => {
    expect((await graph.run(Q.clearance, { pr: PR })).rows).toEqual([]);
  });

  it('impact reaches the example through err ← search ← retrieve ← completion', async () => {
    const rows = (await graph.run<{ doc: string; hops: number; evidence: string[] }>(Q.impact, { pr: PR })).rows;
    expect(rows.map((r) => [r.doc, r.hops, r.evidence])).toEqual([
      ['acme/docs:quickstart.py:0', 4, ['err', 'search', 'retrieve', 'completion', 'acme/docs:quickstart.py:0']],
    ]);
  });

  it('counts every symbol → doc pair (err, validate, search, retrieve, completion)', async () => {
    expect((await graph.run<{ n: number }>(Q.factsCrossRepoDocPaths)).rows[0]!.n).toBe(5);
  });

  it('counts the pull request’s reached sections', async () => {
    const [row] = (await graph.run<{ sections: number; otherRepos: number }>(Q.factsPullRequests)).rows;
    expect(row).toMatchObject({ sections: 1, otherRepos: 1 });
  });

  it('every variable-length pattern binds a path variable and none is a WHERE predicate', () => {
    const unbound = Q.ALL_QUERIES.flatMap((q) =>
      q.cypher.split('\n').filter((l) => /\*\d*\.\./.test(l) && !/\b\w+ = \(/.test(l)).map((l) => `${q.name}: ${l.trim()}`),
    );
    expect(unbound).toEqual([]);
  });

  it('finds a decision governing a symbol two calls below (retrieve → search → err)', async () => {
    const rows = (await graph.run<{ id: string; via: string }>(Q.decisionsForSymbol, { id: id('retrieve') })).rows;
    expect(rows.map((r) => [r.id, r.via])).toEqual([['dec-1', 'err']]);
  });
});
