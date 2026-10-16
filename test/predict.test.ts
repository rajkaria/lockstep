import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import type { PrDiff } from '../src/pr/changes.js';
import { recordPullRequest } from '../src/pr/ingest.js';
import { importsName } from '../src/pr/predict.js';
import { checkMarkdown } from '../src/format/markdown.js';
import { impactTool } from '../src/tools/graph-tools.js';
import type { ToolContext } from '../src/tools/types.js';
import { fakePr, FIXTURE_REPOS, STALE_DOCS, testConfig, testGraph } from './helpers.js';

const PR = fakePr({ number: 9, url: 'https://github.com/acme/mini-client/pull/9', title: 'Connect with a URL' });

const sym = (qualname: string, change: PrDiff['symbols'][number]['change'], before: string, after?: string, extra: Partial<PrDiff['symbols'][number]> = {}) => ({
  repo: 'acme/mini-client',
  qualname,
  name: qualname.split('.').pop()!,
  kind: 'method' as const,
  change,
  before,
  after,
  path: 'miniclient/client.py',
  lineno: 1,
  endLineno: 2,
  ...extra,
});

const DIFF: PrDiff = {
  before: 'before',
  after: 'after',
  files: [{ status: 'M', path: 'miniclient/client.py' }],
  docsTouched: [],
  symbols: [
    sym('miniclient.client.Client.__init__', 'signature', 'def __init__(self, host: str = "localhost", port: int = 6379)', 'def __init__(self, url: str = "falkor://localhost")'),
    sym('miniclient.graph.Graph.query', 'signature', 'def query(self, q: str, params=None)', 'def query(self, q: str, params=None, *, timeout: float)'),
    sym('miniclient.graph.Graph.ro_query', 'removed', 'def ro_query(self, q: str)'),
    sym('miniclient.Client', 'export-removed', 'from miniclient import Client', undefined, { kind: 'module', exportTarget: 'miniclient.client.Client', path: 'miniclient/__init__.py' }),
    // A change the examples still fit: a new optional parameter.
    sym('miniclient.client.Client.select_graph', 'signature', 'def select_graph(self, name: str) -> Graph', 'def select_graph(self, name: str, readonly: bool = False) -> Graph'),
  ],
};

describe('predicted breaks', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let ctx: ToolContext;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('predict'));
    await indexOrg(graph, [...FIXTURE_REPOS, STALE_DOCS]);
    await recordPullRequest(graph, PR, DIFF);
    ctx = { graph, config: testConfig() };
  });
  afterAll(async () => done());

  it('lists examples whose calls the changed code no longer accepts, with the doc line', async () => {
    const r = await impactTool.run(ctx, { pr_url: PR.url });
    expect(r.data.predicted.map((p) => `${p.example.split(':').slice(1).join(':')} L${p.line} ${p.kind} [${p.confidence}] ${p.call}: ${p.detail}`)).toEqual([
      'docs/getting-started.mdx:0 L14 missing-import [exact] from miniclient import Client: imports `Client` from `miniclient`, which this pull request stops exporting',
      'docs/getting-started.mdx:0 L16 unknown-keyword [exact] Client: `Client` has no parameter `host`',
      'docs/getting-started.mdx:0 L16 unknown-keyword [exact] Client: `Client` has no parameter `port`',
      'docs/getting-started.mdx:0 L18 missing-argument [exact] g.query: `Graph.query` requires `timeout`, which the example does not pass',
      'docs/getting-started.mdx:1 L30 removed [exact] g.ro_query: calls `Graph.ro_query`, which this pull request removes',
      // stale.md's `Client(hostname=...)` and `g.query(q, {}, 30)` never fit: already broken, not predicted.
      'docs/stale.md:0 L8 missing-import [exact] from miniclient import Client: imports `Client` from `miniclient`, which this pull request stops exporting',
    ]);
    expect(r.data.predicted[1]!.url).toBe('https://github.com/acme/mini-docs/blob/fixture/docs/getting-started.mdx#L16');
    expect(r.summary).toContain('3 examples are predicted to break');
  });

  it('lists impacted examples that already did not fit the code', async () => {
    const r = await impactTool.run(ctx, { pr_url: PR.url });
    expect(r.data.mismatched.map((m) => `${m.example.split(':').slice(1).join(':')} L${m.line} ${m.kind}`)).toEqual([
      'docs/stale.md:0 L8 missing-import',
      'docs/stale.md:0 L10 unknown-keyword',
      'docs/stale.md:1 L19 too-many-arguments',
      'docs/stale.md:1 L20 missing-attribute',
    ]);
    expect(r.summary).toContain('2 impacted example(s) already did not fit the code');
  });

  it('puts them at the top of the pull request comment', async () => {
    const r = await impactTool.run(ctx, { pr_url: PR.url });
    const md = checkMarkdown({ impact: r.data, summary: r.summary, cleared: [], org: 'acme' });
    expect(md).toContain('### Staleproof: this pull request is predicted to break 3 docs examples');
    expect(md).toContain('| [docs/getting-started.mdx:1](https://github.com/acme/mini-docs/blob/fixture/docs/getting-started.mdx#L30) | `g.ro_query` | calls `Graph.ro_query`, which this pull request removes |');
    expect(md).toContain('<details><summary>4 impacted example line(s) already did not fit the code before this pull request</summary>');
  });
});

describe('importsName', () => {
  it('matches single, listed and parenthesised imports, not other modules', () => {
    expect(importsName('from acme import Client', 'acme', 'Client')).toBe(true);
    expect(importsName('from acme import Graph, Client as C', 'acme', 'Client')).toBe(true);
    expect(importsName('from acme import (\n  Graph,\n  Client,\n)', 'acme', 'Client')).toBe(true);
    expect(importsName('from acme.sub import Client', 'acme', 'Client')).toBe(false);
    expect(importsName('from acme import ClientPool', 'acme', 'Client')).toBe(false);
  });
});

describe('open pull requests that moved', () => {
  it('drops the old diff when the head changed, keeps it otherwise, and ignores lookup failures', async () => {
    const { refreshIfMoved, recordPullRequest: record } = await import('../src/pr/ingest.js');
    const { graph, done } = await testGraph('refresh');
    try {
      const pr = fakePr({ number: 77, url: 'https://github.com/acme/mini-client/pull/77', state: 'open', mergedAt: null, mergeSha: null, headSha: 'head-1' });
      await graph.run(`CREATE (:Symbol {id: 'acme/mini-client:pkg.f', status: 'live'})`);
      await record(graph, pr, { before: 'b', after: 'a', files: [], docsTouched: [], symbols: [{ repo: 'acme/mini-client', qualname: 'pkg.f', name: 'f', kind: 'function', change: 'modified', before: 'def f()', after: 'def f()', path: 'pkg.py', lineno: 1, endLineno: 2 }] });
      const gh = (head: string) => (async () => new Response(JSON.stringify({ number: 77, title: 't', body: '', user: { login: 'u' }, state: 'open', merged_at: null, merge_commit_sha: null, base: { sha: 'b', ref: 'main' }, head: { sha: head, ref: 'f' } }))) as unknown as typeof fetch;
      const config = testConfig();
      expect(await refreshIfMoved(graph, config, pr.url, { fetchImpl: gh('head-1') })).toBe(false);
      expect(await refreshIfMoved(graph, config, pr.url, { fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch })).toBe(false);
      expect(await refreshIfMoved(graph, config, pr.url, { fetchImpl: gh('head-2') })).toBe(true);
      const row = (await graph.run<{ ingested: number | null; n: number }>(`MATCH (p:PullRequest {url: $url}) OPTIONAL MATCH (p)<-[c:CHANGED_IN]-() RETURN p.ingested_at AS ingested, count(c) AS n`, { url: pr.url })).rows[0]!;
      expect(row).toEqual({ ingested: null, n: 0 });
    } finally {
      await done();
    }
  });
});
