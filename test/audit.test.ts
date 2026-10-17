import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditDocs, auditTool, publicApi, scoreAudit } from '../src/audit.js';
import { auditMarkdown, auditText } from '../src/format/audit.js';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg, INDEX_VERSION } from '../src/indexer/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { FIXTURE_REPOS, STALE_DOCS, testConfig, testGraph } from './helpers.js';

describe('docs audit (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let ctx: ToolContext;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('audit'));
    await indexOrg(graph, [...FIXTURE_REPOS, STALE_DOCS]);
    ctx = { graph, config: testConfig() };
  });
  afterAll(async () => done());

  it('scores the whole graph: mismatched examples, coverage, deductions', async () => {
    const r = await auditDocs(ctx);
    expect(r.data.repos.map((x) => x.name)).toEqual(['acme/mini-client', 'acme/mini-docs', 'acme/mini-sdk', 'acme/stale-docs']);
    expect(r.data.examples).toEqual({ total: 9, python: 8, linked: 8, mismatched: 3 });
    expect(r.data.mismatches.map((m) => `${m.example.split(':').slice(1).join(':')} L${m.line} ${m.kind}`)).toEqual([
      'docs/stale.md:0 L8 missing-import',
      'docs/stale.md:0 L10 unknown-keyword',
      'docs/stale.md:1 L19 too-many-arguments',
      'docs/stale.md:1 L20 missing-attribute',
      'docs/stale.md:2 L31 unknown-keyword',
    ]);
    expect(r.data.mismatches[0]).toMatchObject({ heading: 'Upgrading guide > Connect', url: 'https://github.com/acme/stale-docs/blob/fixture/docs/stale.md#L8' });
    expect(r.data.coverage).toEqual({ api: 14, documented: 10, percent: 71.4 });
    // The API is what the packages export (minisdk exports only Rag, so Connection is internal).
    // Called from another repository first (minisdk uses the async client), then classes, then by callers.
    expect(r.data.undocumented.map((u) => `${u.qualname} ${u.crossRepoCallers}/${u.callers}`)).toEqual([
      'miniclient.asyncio.client.AsyncClient 1/1',
      'miniclient.asyncio.client.AsyncClient.select_graph 1/1',
      'miniclient.asyncio.client.AsyncGraph.query 1/1',
      'miniclient.asyncio.client.AsyncGraph 0/1',
    ]);
    expect(r.data.deductions.map((d) => d.points)).toEqual([24, 9]);
    expect(r.data).toMatchObject({ score: 67, grade: 'D' });
    expect(r.summary).toBe(
      'Docs health 67/100 (D) for 4 repositories. 3 of 8 examples that call the code no longer fit it (5 lines). 10 of 14 public symbols (71.4%) are named or called by a doc.',
    );
    expect(r.queries.map((q) => q.name)).toEqual(['auditRepos', 'auditExamples', 'auditMismatches', 'auditRuns', 'auditSymbols', 'auditFindings']);
    // The fixtures are plain folders, not git checkouts or tarball listings: their docs references were not linted.
    expect(r.data.findings).toEqual([]);
    expect(r.data.repos.every((x) => x.findingsChecked === false)).toBe(true);
  });

  it('scopes to repositories: their docs, and examples elsewhere that call their code', async () => {
    const r = await auditTool.run(ctx, { repos: ['acme/mini-sdk'] });
    expect(r.data.repos.map((x) => x.name)).toEqual(['acme/mini-sdk']);
    // quickstart.py in mini-sdk, rag.mdx (mini-docs) and stale.md:2 (stale-docs) call minisdk.
    expect(r.data.examples).toMatchObject({ total: 3, mismatched: 1 });
    expect(r.data.mismatches.map((m) => m.detail)).toEqual(['`Rag.ask` has no parameter `top_k`']);
    await expect(auditTool.run(ctx, { repos: ['acme/nope'] })).rejects.toThrow('not indexed in the');
  });

  it('says when a repository was indexed by an older Staleproof', async () => {
    expect((await auditDocs(ctx, { repos: ['acme/mini-sdk'] })).data.outdatedIndex).toBe(false);
    await graph.run(`MATCH (r:Repo {name: 'acme/mini-sdk'}) REMOVE r.index_version`);
    try {
      const r = await auditDocs(ctx, { repos: ['acme/mini-sdk'] });
      expect(r.data.outdatedIndex).toBe(true);
      expect(r.summary).toContain('Indexed by an older Staleproof');
    } finally {
      await graph.run(`MATCH (r:Repo {name: 'acme/mini-sdk'}) SET r.index_version = $v`, { v: INDEX_VERSION });
    }
  });

  it('renders text and markdown with the badge for a single repository', async () => {
    const r = await auditDocs(ctx, { repos: ['acme/mini-client'] });
    const md = auditMarkdown(r.data, r.summary);
    expect(md.startsWith('<!-- staleproof-audit -->\n### Staleproof docs audit: ')).toBe(true);
    expect(md).toContain('| [docs/stale.md:1 line 20](https://github.com/acme/stale-docs/blob/fixture/docs/stale.md#L20) | Upgrading guide > Query | `g.read_only` | `Graph` has no attribute `read_only` |');
    expect(md).toContain('[![docs health](https://staleproof.dev/api/badge/acme/mini-client.svg)](https://staleproof.dev/#/audit?repo=acme%2Fmini-client)');
    expect(md).toMatch(/<!-- staleproof:audit score=\d+ mismatched=2 failing=0 coverage=[\d.]+ -->$/);
    expect(auditText(r.data, r.summary)).toContain('`Client` has no parameter `hostname`');
  });
});

describe('publicApi and scoreAudit', () => {
  const row = (qualname: string, kind = 'function', path = 'pkg/mod.py') => ({
    id: `r:${qualname}`, qualname, name: qualname.split('.').pop()!, kind, repo: 'r', path, lineno: 1, signature: '', docs: 0, callers: 0, callerRepos: [],
    visibility: qualname.split('.').pop()!.startsWith('_') ? 'private' : 'public',
  });

  it('keeps Python-public names only', () => {
    const api = publicApi([
      row('pkg.mod.run'),
      row('pkg.mod._helper'),
      row('pkg._internal.run'),
      row('pkg.mod.run.inner'),
      row('pkg.mod.Graph', 'class'),
      row('pkg.mod.Graph.query', 'method'),
      row('pkg.mod.Graph._send', 'method'),
      row('tests.test_mod.test_run', 'function', 'tests/test_mod.py'),
    ]);
    expect(api.map((a) => a.qualname)).toEqual(['pkg.mod.run', 'pkg.mod.Graph', 'pkg.mod.Graph.query']);
  });

  it('scores 100 for fitting examples and full coverage, with capped deductions', () => {
    expect(scoreAudit({ examples: { total: 1, python: 1, linked: 1, mismatched: 0 }, coverage: { api: 4, documented: 4, percent: 100 }, runCounts: { pass: 1, fail: 0, skipped: 0, error: 0 } })).toEqual({
      score: 100,
      grade: 'A',
      deductions: [],
    });
    const bad = scoreAudit({ examples: { total: 20, python: 20, linked: 20, mismatched: 10 }, coverage: { api: 10, documented: 0, percent: 0 }, runCounts: { pass: 0, fail: 9, skipped: 0, error: 0 } });
    expect(bad.deductions.map((d) => d.points)).toEqual([50, 30, 30]);
    expect(bad).toMatchObject({ score: 0, grade: 'F' });
  });
});
