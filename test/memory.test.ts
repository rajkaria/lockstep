import { execFileSync } from 'node:child_process';
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

  it('builds the same patch without a clone, reading the file from GitHub at the indexed commit (serverless)', async () => {
    const withGit = await buildDocsPatch(ctx, PR.url);
    const urls: string[] = [];
    const docs = checkouts.find((c) => c.repo === 'acme/mini-docs')!;
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const m = /raw\.githubusercontent\.com\/acme\/mini-docs\/(\w+)\/(.+)$/.exec(url);
      return m ? new Response(execFileSync('git', ['show', `${m[1]}:${decodeURIComponent(m[2]!)}`], { cwd: docs.dir, encoding: 'utf8' })) : new Response('', { status: 404 });
    }) as typeof fetch;
    const noClone = { ...ctx, checkouts: {}, config: { ...ctx.config, home: join(root, 'no-such-home') } };
    const patch = await buildDocsPatch(noClone, PR.url, { fetchImpl });
    expect(urls).toEqual([expect.stringMatching(/^https:\/\/raw\.githubusercontent\.com\/acme\/mini-docs\/\w{40}\/docs\/getting-started\.mdx$/)]);
    expect(patch.diff).toBe(withGit.diff);
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
    expect(opened).toEqual([{ repo: 'me/mini-docs', url: 'https://github.com/me/mini-docs/pull/1', target: 'fork', branch: 'staleproof/acme-mini-client-7' }]);
    expect(calls).toContain('POST /repos/me/mini-docs/pulls');
    expect(calls).not.toContain('POST /repos/acme/mini-docs/pulls');
    expect(calls).toContain('PUT /repos/me/mini-docs/contents/docs/getting-started.mdx');
    await expect(openDocsPr(patch, { token: '', target: 'fork', fetchImpl })).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('opens the docs PR in the repository itself for CI tokens: no fork, no user, into the given branch', async () => {
    const patch = await buildDocsPatch(ctx, PR.url);
    const file = patch.files[0]!;
    /** A GitHub whose `feature` branch has `onBranch` at the patched path; it records the calls and the files written. */
    const github = (onBranch: string | undefined) => {
      const calls: string[] = [];
      const written = new Map<string, string>();
      const posted: { body: string }[] = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const path = url.replace('https://api.github.com', '');
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${path}`);
        if (path.includes('/contents/') && method === 'GET' && onBranch === undefined) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        if (path.includes('/contents/') && method === 'PUT') {
          const b = JSON.parse(String(init!.body)) as { content: string; sha: string };
          written.set(decodeURIComponent(path.split('/contents/')[1]!), Buffer.from(b.content, 'base64').toString('utf8'));
        }
        if (path.endsWith('/pulls') && method === 'POST') posted.push(JSON.parse(String(init!.body)) as { body: string });
        const body =
          path === '/repos/acme/mini-docs' ? { default_branch: 'main' }
          : path.startsWith('/repos/acme/mini-docs/git/ref/heads/') ? { object: { sha: 'feature-sha' } }
          : path.includes('/contents/') && method === 'GET' ? { sha: 'blob', encoding: 'base64', content: Buffer.from(onBranch!, 'utf8').toString('base64') }
          : path.includes('/pulls?') ? []
          : path.endsWith('/pulls') ? { html_url: 'https://github.com/acme/mini-docs/pull/9' }
          : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch;
      return { calls, written, posted, fetchImpl };
    };
    const same = github(file.before);
    const opened = await openDocsPr(patch, { token: 't', target: 'same-repo', base: 'feature', only: ['ACME/mini-docs'], fetchImpl: same.fetchImpl });
    expect(opened).toEqual([{ repo: 'acme/mini-docs', url: 'https://github.com/acme/mini-docs/pull/9', target: 'same-repo', branch: 'staleproof/docs-acme-mini-client-7' }]);
    const calls = same.calls;
    expect(calls).not.toContain('GET /user');
    expect(calls.some((c) => c.includes('/forks'))).toBe(false);
    expect(calls).toContain('GET /repos/acme/mini-docs/git/ref/heads/feature');
    // The file is read at the branch's commit, before the docs branch is made from it.
    expect(calls).toContain('GET /repos/acme/mini-docs/contents/docs/getting-started.mdx?ref=feature-sha');
    const create = calls.indexOf('POST /repos/acme/mini-docs/pulls');
    expect(create).toBeGreaterThan(calls.indexOf('PUT /repos/acme/mini-docs/contents/docs/getting-started.mdx'));
    expect(same.written.get('docs/getting-started.mdx')).toBe(file.after);
    expect(await openDocsPr(patch, { token: 't', target: 'same-repo', only: ['acme/other'], fetchImpl: same.fetchImpl })).toEqual([]);

    // Found on rajkaria/staleproof-action-test#6: the edit was written against the default branch and the file was
    // written whole onto the pull request's branch, reverting what the pull request itself had changed in that file.
    // The pull request's branch changed the file away from the edit: the edit is applied on top, the change kept.
    const elsewhere = `> Note added by the pull request.\n\n${file.before}`;
    const merged = github(elsewhere);
    const kept = await openDocsPr(patch, { token: 't', target: 'same-repo', base: 'feature', only: ['acme/mini-docs'], fetchImpl: merged.fetchImpl });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.skipped).toBeUndefined();
    expect(merged.written.get('docs/getting-started.mdx')).toBe(`> Note added by the pull request.\n\n${file.after}`);
    // It changed the lines the edit replaces: the file is left out, nothing is overwritten, no pull request is opened.
    const removed = file.diff.split('\n').find((l) => l.startsWith('-') && !l.startsWith('---'))!.slice(1);
    const conflicting = github(file.before.replace(removed, `${removed} (changed by the pull request)`));
    const logs: string[] = [];
    await expect(openDocsPr(patch, { token: 't', target: 'same-repo', base: 'feature', only: ['acme/mini-docs'], fetchImpl: conflicting.fetchImpl, log: (m) => logs.push(m) })).rejects.toThrow(
      /^the docs fix was not opened: the target branch has other text where each edit applies \(acme\/mini-docs: docs\/getting-started\.mdx \(feature has other text where the edit applies \(the edit was written against \w{7}\)\)\)/,
    );
    expect(conflicting.written.size).toBe(0);
    expect(conflicting.calls.some((c) => c.startsWith('POST /repos/acme/mini-docs/git/refs') || c.startsWith('POST /repos/acme/mini-docs/pulls'))).toBe(false);
    expect(logs).toEqual([expect.stringMatching(/^no pull request in acme\/mini-docs: docs\/getting-started\.mdx: feature has other text where the edit applies/)]);
    // The file is not on the branch at all (the pull request moved it): left out the same way.
    await expect(openDocsPr(patch, { token: 't', target: 'same-repo', base: 'feature', only: ['acme/mini-docs'], fetchImpl: github(undefined).fetchImpl })).rejects.toThrow(/docs\/getting-started\.mdx \(not on feature\)/);

    // A repository that does not let GitHub Actions create pull requests (GitHub's default): say what to change.
    const refused = (async (url: string, init?: RequestInit) =>
      url.endsWith('/pulls') && init?.method === 'POST'
        ? new Response(JSON.stringify({ message: 'GitHub Actions is not permitted to create or approve pull requests.', status: '403' }), { status: 403 })
        : same.fetchImpl(url, init)) as typeof fetch;
    await expect(openDocsPr(patch, { token: 't', target: 'same-repo', base: 'feature', only: ['acme/mini-docs'], fetchImpl: refused })).rejects.toThrow(
      /^GitHub Actions may not open pull requests in acme\/mini-docs, so the docs fix waits on the branch staleproof\/docs-acme-mini-client-7: turn on "Allow GitHub Actions to create and approve pull requests".*https:\/\/github\.com\/acme\/mini-docs\/compare\/feature\.\.\.staleproof\/docs-acme-mini-client-7\?expand=1$/,
    );
  });

  it('summarises what changed since the last check', async () => {
    const s = await sinceLastCheck(ctx, started);
    expect(s.prs.map((p) => p.url)).toEqual([PR.url]);
    expect(s.verdicts).toBe(2);
    expect(s.stale).toBe(1);
    expect(s.decisions).toHaveLength(2);
  });
});
