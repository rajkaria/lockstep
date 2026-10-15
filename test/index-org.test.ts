import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg, type IndexReport } from '../src/indexer/index.js';
import { FIXTURE_REPOS, testGraph } from './helpers.js';

describe('indexOrg (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let report: IndexReport;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('org'));
    report = await indexOrg(graph, FIXTURE_REPOS);
  });
  afterAll(async () => done());

  const rows = async <T>(cypher: string, params = {}) => (await graph.run<T>(cypher, params)).rows;

  it('indexes doc sections and examples with stable ids', async () => {
    const sections = await rows<{ id: string; hp: string }>(
      `MATCH (d:DocSection {repo: 'acme/mini-docs'}) RETURN d.id AS id, d.heading_path AS hp ORDER BY id`,
    );
    expect(sections.map((s) => s.id)).toEqual([
      'acme/mini-docs:docs/getting-started.mdx#connect',
      'acme/mini-docs:docs/getting-started.mdx#getting-started',
      'acme/mini-docs:docs/getting-started.mdx#listing-graphs',
      'acme/mini-docs:docs/getting-started.mdx#read-only-queries',
      'acme/mini-docs:docs/rag.mdx#ask-a-question',
      'acme/mini-docs:docs/rag.mdx#configuration',
      'acme/mini-docs:docs/rag.mdx#rag-with-minisdk',
    ]);
    const ex = await rows<{ id: string; lang: string; section: string }>(
      `MATCH (e:CodeExample)-[:IN_SECTION]->(d:DocSection) RETURN e.id AS id, e.lang AS lang, d.anchor AS section ORDER BY id`,
    );
    expect(ex).toEqual([
      { id: 'acme/mini-docs:docs/getting-started.mdx:0', lang: 'python', section: 'connect' },
      { id: 'acme/mini-docs:docs/getting-started.mdx:1', lang: 'python', section: 'read-only-queries' },
      { id: 'acme/mini-docs:docs/rag.mdx:0', lang: 'python', section: 'ask-a-question' },
      { id: 'acme/mini-docs:docs/rag.mdx:1', lang: 'bash', section: 'configuration' },
    ]);
  });

  it('links examples to the symbols they call, resolving variables across blocks on a page', async () => {
    const uses = await rows<{ ex: string; sym: string; resolved: string }>(
      `MATCH (e:CodeExample)-[u:USES]->(s:Symbol) RETURN e.id AS ex, s.qualname AS sym, u.resolved AS resolved ORDER BY ex, sym`,
    );
    const fmt = uses.map((u) => `${u.ex.replace('acme/', '')} -> ${u.sym} [${u.resolved}]`);
    expect(fmt).toEqual([
      'mini-docs:docs/getting-started.mdx:0 -> miniclient.client.Client [exact]',
      'mini-docs:docs/getting-started.mdx:0 -> miniclient.client.Client.__init__ [exact]',
      'mini-docs:docs/getting-started.mdx:0 -> miniclient.client.Client.select_graph [exact]',
      'mini-docs:docs/getting-started.mdx:0 -> miniclient.graph.Graph.query [exact]',
      'mini-docs:docs/getting-started.mdx:1 -> miniclient.graph.Graph.ro_query [exact]',
      'mini-docs:docs/rag.mdx:0 -> minisdk.rag.Rag [exact]',
      'mini-docs:docs/rag.mdx:0 -> minisdk.rag.Rag.__init__ [exact]',
      'mini-docs:docs/rag.mdx:0 -> minisdk.rag.Rag.ask [exact]',
      'mini-sdk:minisdk/examples/quickstart.py:0 -> minisdk.rag.Rag [exact]',
      'mini-sdk:minisdk/examples/quickstart.py:0 -> minisdk.rag.Rag.__init__ [exact]',
      'mini-sdk:minisdk/examples/quickstart.py:0 -> minisdk.rag.Rag.ask [exact]',
      'mini-sdk:minisdk/examples/quickstart.py:0 -> minisdk.rag.Rag.ingest [exact]',
    ]);
  });

  it('links prose mentions in inline code to symbols', async () => {
    const m = await rows<{ sec: string; sym: string; span: string }>(
      `MATCH (d:DocSection)-[m:MENTIONS]->(s:Symbol) RETURN d.anchor AS sec, s.qualname AS sym, m.span AS span ORDER BY sec, sym`,
    );
    // `select_graph()` is ambiguous (sync and async clients); the page's examples use the sync
    // Client exactly, so only that one is linked.
    expect(m.map((x) => `${x.sec}: ${x.span} -> ${x.sym}`)).toEqual([
      'connect: Client -> miniclient.client.Client',
      'connect: select_graph() -> miniclient.client.Client.select_graph',
      'listing-graphs: list_graphs() -> miniclient.client.Client.list_graphs',
      'read-only-queries: Graph.ro_query -> miniclient.graph.Graph.ro_query',
    ]);
  });

  it('links sections that hyperlink each other and records repo dependencies', async () => {
    const links = await rows<{ a: string; b: string }>(
      `MATCH (a:DocSection)-[:LINKS_TO]->(b:DocSection) RETURN a.anchor AS a, b.anchor AS b ORDER BY a`,
    );
    expect(links).toEqual([
      { a: 'rag-with-minisdk', b: 'connect' },
      { a: 'read-only-queries', b: 'connect' },
    ]);
    expect(report.dependsOn.map((d) => `${d.from} -> ${d.to} (${d.spec})`).sort()).toEqual([
      'acme/mini-docs -> acme/mini-client (examples import miniclient)',
      'acme/mini-docs -> acme/mini-sdk (examples import minisdk)',
      'acme/mini-sdk -> acme/mini-client (declares miniclient)',
    ]);
  });

  it('answers the cross-repo impact question: which docs reach a changed client method', async () => {
    const r = await graph.run<{ kind: string; repo: string; heading: string; hops: number; path: string[] }>(`
      MATCH (s:Symbol {qualname: 'miniclient.asyncio.client.AsyncGraph.query'})
      MATCH p = (s)<-[:CALLS*0..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
      WHERE d:DocSection OR d:CodeExample
      RETURN labels(d)[0] AS kind, d.repo AS repo, coalesce(d.heading_path, d.path) AS heading, length(p) AS hops,
             [n IN nodes(p) | coalesce(n.qualname, n.id)] AS path
      ORDER BY hops, d.repo`);
    expect(r.rows.map((x) => `${x.kind} ${x.repo} ${x.heading} hops=${x.hops}`)).toEqual([
      'CodeExample acme/mini-docs docs/rag.mdx hops=3',
      'CodeExample acme/mini-sdk minisdk/examples/quickstart.py hops=3',
      'CodeExample acme/mini-sdk minisdk/examples/quickstart.py hops=3',
    ]);
    expect(r.rows[0]!.path).toEqual([
      'miniclient.asyncio.client.AsyncGraph.query',
      'minisdk.connection.Connection.run',
      'minisdk.rag.Rag.ask',
      'acme/mini-docs:docs/rag.mdx:0',
    ]);
    expect(r.ms).toBeLessThan(1000);
  });

  it('stores identifiers on sections for linking symbols that no longer exist', async () => {
    const r = await rows<{ idents: string[] }>(`MATCH (d:DocSection {anchor: 'connect'}) RETURN d.idents AS idents`);
    expect(r[0]!.idents).toEqual(['Client', 'select_graph']);
  });
});
