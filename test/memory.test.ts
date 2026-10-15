import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import type { Checkout } from '../src/indexer/repo.js';
import { buildDocsPatch } from '../src/patch.js';
import type { PrDiff } from '../src/pr/changes.js';
import { recordPullRequest } from '../src/pr/ingest.js';
import { openDocsPr } from '../src/pr/open-pr.js';
import { decisionsForTool, proposeEditTool, recordVerdictTool, reviewVerdict, sinceLastCheck, writeDecisionTool } from '../src/tools/memory-tools.js';
import type { ToolContext } from '../src/tools/types.js';
import { fakePr, gitIn, makeGitOrg, testConfig, testGraph } from './helpers.js';

const PR = fakePr();
const DIFF: PrDiff = {
  before: 'before',
  after: 'after',
  files: [],
  docsTouched: [],
  symbols: [
    { repo: 'acme/mini-client', qualname: 'miniclient.asyncio.client.AsyncGraph.query', name: 'query', kind: 'method', change: 'signature', before: 'async def query(self, q: str, params=None)', after: 'async def query(self, q: str, *, timeout: float)', path: 'miniclient/asyncio/client.py', lineno: 5, endLineno: 6 },
    { repo: 'acme/mini-client', qualname: 'miniclient.client.Client.graph_names', name: 'graph_names', kind: 'method', change: 'removed', before: 'def graph_names(self)', path: 'miniclient/client.py', lineno: 20, endLineno: 21 },
  ],
};
const LISTING = 'acme/mini-docs:docs/getting-started.mdx#listing-graphs';
const READONLY = 'acme/mini-docs:docs/getting-started.mdx#read-only-queries';
const ASK = 'acme/mini-docs:docs/rag.mdx#ask-a-question';

describe('decisions, verdicts and memory (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let ctx: ToolContext;
  let root: string;
  let checkouts: Checkout[];
  const started = Date.now() - 1;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('memory'));
    ({ root, checkouts } = await makeGitOrg());
    await indexOrg(graph, checkouts);
    await recordPullRequest(graph, PR, DIFF);
    ctx = { graph, config: testConfig(), prUrl: PR.url, checkouts: Object.fromEntries(checkouts.map((c) => [c.repo, c.dir])), checkId: 'chk-test' };
  });
  afterAll(async () => {
    await done();
    await rm(root, { recursive: true, force: true });
  });

  it('finds a decision that governs a symbol two call hops below a section, and follows SUPERSEDES', async () => {
    const a = await writeDecisionTool.run(ctx, {
      text: 'Graph._send keeps its positional signature until 2.0',
      governs: ['acme/mini-client:miniclient.graph.Graph._send'],
      source_url: 'https://github.com/acme/mini-client/issues/1',
      author: 'maintainer',
    });
    const r1 = await decisionsForTool.run(ctx, { target_id: READONLY });
    // read-only-queries MENTIONS Graph.ro_query -CALLS-> Graph.query -CALLS-> Graph._send
    expect(r1.data.decisions.map((d) => [d.id, d.via])).toEqual([[a.data.id, 'miniclient.graph.Graph._send']]);

    const b = await writeDecisionTool.run(ctx, {
      text: 'Graph._send may take keyword arguments from 1.5',
      governs: ['acme/mini-client:miniclient.graph.Graph._send'],
      supersedes: a.data.id,
    });
    const r2 = await decisionsForTool.run(ctx, { target_id: READONLY });
    expect(r2.data.decisions.map((d) => [d.id, d.matched])).toEqual([[b.data.id, b.data.id]]);
    expect(r2.summary).toContain('Graph._send may take keyword arguments');
    const symbolSide = await decisionsForTool.run(ctx, { target_id: 'acme/mini-client:miniclient.graph.Graph.ro_query' });
    expect(symbolSide.data.decisions.map((d) => d.id)).toEqual([b.data.id]);
  });

  it('refuses an edit with no path from the PR, accepts one with a path, and records verdicts with evidence', async () => {
    await expect(
      proposeEditTool.run(ctx, { section_id: 'acme/mini-docs:docs/getting-started.mdx#connect', new_text: '## Connect\n\nNew.', reason: 'x' }),
    ).rejects.toThrow(/never edits a paragraph without a path/);

    const edit = await proposeEditTool.run(ctx, {
      section_id: LISTING,
      new_text: '## Listing graphs\n\n`list_graphs()` returns every graph name.',
      reason: 'graph_names() was removed in this PR; the section still names it.',
    });
    expect(edit.data.evidence).toEqual(['miniclient.client.Client.graph_names', 'acme/mini-docs:docs/getting-started.mdx#listing-graphs']);

    const ok = await recordVerdictTool.run(ctx, { section_id: ASK, verdict: 'ok', reason: 'Rag.ask passes a query string only; the new keyword-only timeout has a default in practice.' });
    expect(ok.data.evidence[ASK]![0]).toBe('miniclient.asyncio.client.AsyncGraph.query');
    await expect(recordVerdictTool.run(ctx, { section_id: ASK, verdict: 'governed', reason: 'x' })).rejects.toThrow(/must cite/);
  });

  it('remembers verdicts: the next look at a section shows what was concluded before', async () => {
    const r = await decisionsForTool.run(ctx, { target_id: LISTING });
    expect(r.data.history.map((h) => `${h.verdict} ${h.status} ${h.pr}`)).toEqual([`stale proposed ${PR.url}`]);
    expect(await reviewVerdict(ctx, r.data.history[0]!.id, 'accepted', 'maintainer')).toBe(true);
    const again = await decisionsForTool.run(ctx, { target_id: LISTING });
    expect(again.summary).toContain('stale (accepted)');
  });

  it('builds a git-apply-able docs patch with the evidence path per section', async () => {
    const patch = await buildDocsPatch(ctx, PR.url);
    expect(patch.files.map((f) => `${f.repo}:${f.path}`)).toEqual(['acme/mini-docs:docs/getting-started.mdx']);
    expect(patch.diff).toContain('-`list_graphs()` returns every graph name. Older releases called it `graph_names()`.');
    expect(patch.diff).toContain('+`list_graphs()` returns every graph name.');
    expect(patch.body).toContain('Path: `miniclient.client.Client.graph_names` ← `acme/mini-docs:docs/getting-started.mdx#listing-graphs`');
    expect(patch.body).toContain('**ok** [RAG with minisdk > Ask a question]');
    const docs = checkouts.find((c) => c.repo === 'acme/mini-docs')!;
    await writeFile(join(root, 'docs.patch'), patch.diff);
    expect(() => gitIn(docs.dir, 'apply', '--check', join(root, 'docs.patch'))).not.toThrow();
  });

  it('opens the docs PR inside the fork unless upstream is explicitly requested', async () => {
    const patch = await buildDocsPatch(ctx, PR.url);
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = url.replace('https://api.github.com', '');
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      const body =
        path === '/user' ? { login: 'me' }
        : path.endsWith('/forks') ? { full_name: 'me/mini-docs', default_branch: 'main' }
        : path === '/repos/acme/mini-docs' || path === '/repos/me/mini-docs' ? { default_branch: 'main' }
        : path.includes('/contents/') && (init?.method ?? 'GET') === 'GET' ? { sha: 'blob' }
        : path.endsWith('/pulls') ? { html_url: 'https://github.com/me/mini-docs/pull/1' }
        : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const opened = await openDocsPr(patch, { token: 't', target: 'fork', fetchImpl, pollMs: 1 });
    expect(opened).toEqual([{ repo: 'me/mini-docs', url: 'https://github.com/me/mini-docs/pull/1', target: 'fork', branch: 'lockstep/acme-mini-client-7' }]);
    expect(calls).toContain('POST /repos/me/mini-docs/pulls');
    expect(calls).not.toContain('POST /repos/acme/mini-docs/pulls');
    expect(calls).toContain('PUT /repos/me/mini-docs/contents/docs/getting-started.mdx');
    await expect(openDocsPr(patch, { token: '', target: 'fork', fetchImpl })).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('summarises what changed since the last check', async () => {
    const s = await sinceLastCheck(ctx, started);
    expect(s.prs.map((p) => p.url)).toEqual([PR.url]);
    expect(s.verdicts).toBe(2);
    expect(s.stale).toBe(1);
    expect(s.decisions).toHaveLength(2);
  });
});
