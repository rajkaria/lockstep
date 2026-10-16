import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentCheck } from '../src/agent/loop.js';
import type { ModelMessageParam } from '../src/agent/model.js';
import { lastToolResults, ScriptedModel, type ScriptedTurn } from '../src/agent/scripted.js';
import type { OrgGraph } from '../src/graph/client.js';
import * as Q from '../src/graph/queries.js';
import { indexOrg } from '../src/indexer/index.js';
import type { PrDiff } from '../src/pr/changes.js';
import { recordPullRequest } from '../src/pr/ingest.js';
import { modelTools } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { fakePr, FIXTURE_REPOS, testConfig, testGraph } from './helpers.js';

const PR_REMOVE = fakePr({ number: 11, url: 'https://github.com/acme/mini-client/pull/11', title: 'Drop graph_names' });
const PR_SIG = fakePr({ number: 12, url: 'https://github.com/acme/mini-client/pull/12', title: 'Keyword-only timeout on AsyncGraph.query' });
const LISTING = 'acme/mini-docs:docs/getting-started.mdx#listing-graphs';
const ASK = 'acme/mini-docs:docs/rag.mdx#ask-a-question';

const diff = (symbols: PrDiff['symbols']): PrDiff => ({ before: 'b', after: 'a', files: [], docsTouched: [], symbols });

/** Script for a breaking change: read what the impact found, then fix it. */
function breakingScript(history: ModelMessageParam[], turn: number): ScriptedTurn {
  if (turn === 0) return { thinking: 'Start from what the PR reaches.', calls: [{ name: 'impact', input: {} }] };
  const results = lastToolResults(history);
  if (turn === 1) {
    const impact = results[0]!.content as { data: { sections: { section: string; severity: string }[] } };
    const breaking = impact.data.sections.filter((s) => s.severity === 'breaking');
    return { thinking: 'A removed method is still named in the docs; read that section.', calls: breaking.map((s) => ({ name: 'read_section', input: { section_id: s.section } })) };
  }
  if (turn === 2) {
    const section = results[0]!.content as { data: { id: string; body: string } };
    return {
      calls: [
        { name: 'propose_edit', input: { section_id: section.data.id, new_text: section.data.body.replace(' Older releases called it `graph_names()`.', ''), reason: 'graph_names() no longer exists.' } },
      ],
    };
  }
  return { text: 'Removed the reference to graph_names() from Listing graphs.' };
}

/** Script for a signature change: check decisions and clearance, then close the section as ok. */
function signatureScript(history: ModelMessageParam[], turn: number): ScriptedTurn {
  if (turn === 0) return { calls: [{ name: 'impact', input: {} }, { name: 'clearance', input: {} }] };
  if (turn === 1) return { thinking: 'Only an SDK page reaches this; is there a decision?', calls: [{ name: 'decisions_for', input: { target_id: ASK } }] };
  if (turn === 2) return { text: 'Done.' }; // forgets the verdict: the loop must nudge
  if (turn === 3) {
    const nudge = history[history.length - 1]!;
    expect(typeof nudge.content === 'string' && nudge.content).toContain(ASK);
    return { calls: [{ name: 'record_verdict', input: { section_ids: [ASK], verdict: 'ok', reason: 'Rag.ask passes a query only; timeout has a default.' } }] };
  }
  return { text: 'The SDK wrapper is unaffected; no doc edits.' };
}

describe('agent loop (scripted model, FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let ctx: ToolContext;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('agent'));
    await indexOrg(graph, FIXTURE_REPOS);
    await recordPullRequest(graph, PR_REMOVE, diff([
      { repo: 'acme/mini-client', qualname: 'miniclient.client.Client.graph_names', name: 'graph_names', kind: 'method', change: 'removed', before: 'def graph_names(self)', path: 'miniclient/client.py', lineno: 20, endLineno: 21 },
    ]));
    await recordPullRequest(graph, PR_SIG, diff([
      { repo: 'acme/mini-client', qualname: 'miniclient.asyncio.client.AsyncGraph.query', name: 'query', kind: 'method', change: 'signature', before: 'async def query(self, q: str, params=None)', after: 'async def query(self, q: str, params=None, *, timeout: float = 5)', path: 'miniclient/asyncio/client.py', lineno: 5, endLineno: 6 },
    ]));
    ctx = { graph, config: testConfig() };
  });
  afterAll(async () => done());

  it('exposes every agent tool to the model with a JSON schema', () => {
    const tools = modelTools();
    expect(tools.map((t) => t.name)).toEqual(['impact', 'clearance', 'read_section', 'run_example', 'decisions_for', 'rank_sections', 'propose_edit', 'record_verdict']);
    expect(tools[0]!.input_schema).toMatchObject({ type: 'object', required: ['pr_url'] });
  });

  it('lets the model choose: a breaking PR reads and edits; the trace and Check node record every call and its Cypher', async () => {
    const events: string[] = [];
    const r = await runAgentCheck(ctx, new ScriptedModel(breakingScript), PR_REMOVE.url, { onEvent: (e) => events.push(e.type) });
    expect(r.status).toBe('done');
    expect(r.toolOrder).toEqual(['impact', 'read_section', 'propose_edit']);
    expect(r.impacted).toEqual([LISTING]);
    expect(r.summary).toBe('Removed the reference to graph_names() from Listing graphs.');
    const impactResult = r.events.find((e) => e.type === 'tool_result' && e.name === 'impact');
    expect(impactResult?.type === 'tool_result' && impactResult.queries.some((q) => q.name === 'impact' && q.cypher.includes('[:CALLS*0..3]'))).toBe(true);
    expect(events[0]).toBe('check_started');
    expect(events.at(-1)).toBe('check_finished');
    const check = (await graph.run<{ status: string; order: string[]; verdicts: number; trace: string }>(
      `MATCH (c:Check {id: $id})-[:FOR]->(:PullRequest {url: $pr}) RETURN c.status AS status, c.tool_order AS order, c.verdicts AS verdicts, c.trace AS trace`,
      { id: r.checkId, pr: PR_REMOVE.url },
    )).rows[0]!;
    expect(check).toMatchObject({ status: 'done', order: ['impact', 'read_section', 'propose_edit'], verdicts: 1 });
    expect(JSON.parse(check.trace).at(-1).type).toBe('check_finished');
  });

  it('a different PR produces a different tool order, and the loop nudges until every impacted section has a verdict', async () => {
    const r = await runAgentCheck(ctx, new ScriptedModel(signatureScript), PR_SIG.url);
    expect(r.toolOrder).toEqual(['impact', 'clearance', 'decisions_for', 'record_verdict']);
    expect(r.events.filter((e) => e.type === 'nudge')).toHaveLength(1);
    expect(r.status).toBe('done');
    expect(r.missing).toEqual([]);
    // Memory: this check knows what the previous one did.
    expect(r.since?.verdicts).toBe(1);
    expect(r.events[0]).toMatchObject({ type: 'check_started' });
    expect((r.events[0] as { since?: string }).since).toMatch(/1 verdict\(s\), 1 of them stale/);
  });

  it('returns tool errors to the model instead of crashing, and reports an incomplete check honestly', async () => {
    const model = new ScriptedModel((history, turn) =>
      turn === 0 ? { calls: [{ name: 'impact', input: {} }, { name: 'propose_edit', input: { section_id: 'acme/mini-docs:docs/getting-started.mdx#connect', new_text: 'x', reason: 'nope' } }] }
      : turn === 1 ? (expect(lastToolResults(history)[1]!.content).toMatchObject({ text: expect.stringMatching(/never edits a paragraph without a path/) }), { calls: [{ name: 'impact', input: { max_hops: 99 } }] })
      : { text: 'Giving up.' },
    );
    const r = await runAgentCheck(ctx, model, PR_REMOVE.url, { maxNudges: 0 });
    const errors = r.events.filter((e) => e.type === 'tool_result' && e.isError);
    expect(errors).toHaveLength(2);
    expect(r.status).toBe('incomplete');
    expect(r.missing).toEqual([LISTING]);
    const checks = await graph.run<{ n: number }>(Q.recentChecks, { limit: 10 });
    expect(checks.rows.length).toBe(3);
  });

  it('stops at its time budget before the next model turn and reports the open sections', async () => {
    const scripted = new ScriptedModel(() => ({ calls: [{ name: 'impact', input: {} }] }));
    // The first turn starts inside the budget and outlasts it; the second must not start.
    const slow = { name: 'slow', turn: async (...a: Parameters<ScriptedModel['turn']>) => (await new Promise((r) => setTimeout(r, 400)), scripted.turn(...a)) };
    const r = await runAgentCheck(ctx, slow, PR_REMOVE.url, { budgetMs: 200 });
    expect(r.status).toBe('incomplete');
    expect(r.summary).toMatch(/^Stopped at this server's 0 s time limit after 1 model turns with 1 impacted section\(s\) still open/);
    expect(r.missing).toEqual([LISTING]);
  });

  it('rejects a parameter a tool does not have, naming the ones it does, instead of silently answering the same', async () => {
    // Found on the first real run: paging past 40 sections, the model invented limit/offset/repo and got page one again.
    const model = new ScriptedModel((history, turn) =>
      turn === 0 ? { calls: [{ name: 'impact', input: { limit: 5 } }] }
      : (turn === 1 && expect(lastToolResults(history)[0]!.content).toMatchObject({ text: expect.stringMatching(/^impact has no parameter limit; its parameters are pr_url, max_hops, offset/) }), { text: 'Done.' }),
    );
    const r = await runAgentCheck(ctx, model, PR_REMOVE.url, { maxNudges: 0 });
    expect(r.events.filter((e) => e.type === 'tool_result' && e.isError)).toHaveLength(1);
  });
});

describe('allImpactedSections', () => {
  it('collects every page so the stop condition covers sections the model never paged to', async () => {
    const { allImpactedSections } = await import('../src/agent/loop.js');
    const ids = Array.from({ length: 43 }, (_, i) => `r:doc.md#s${i}`);
    const page = (offset: number) =>
      ({ sections: ids.slice(offset, offset + 40).map((section) => ({ section })), totalSections: 43, offset, truncated: offset + 40 < 43 }) as never;
    const fetched: number[] = [];
    const all = await allImpactedSections(page(0), async (o) => (fetched.push(o), page(o)));
    expect(all).toHaveLength(43);
    expect(fetched).toEqual([40]);
    // The model asked for page 2 first: page 1 is fetched, page 2 isn't fetched twice.
    fetched.length = 0;
    expect(await allImpactedSections(page(40), async (o) => (fetched.push(o), page(o)))).toHaveLength(43);
    expect(fetched).toEqual([0]);
  });
});
