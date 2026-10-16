import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import { classifyFile } from '../src/indexer/repo.js';
import { looksLikePython, scanRst } from '../src/indexer/rst.js';
import { FIXTURES, FIXTURE_REPOS, testGraph } from './helpers.js';

const RST_DOCS = { repo: 'acme/rst-docs', dir: join(FIXTURES, 'rst-docs'), sha: 'fixture' };

describe('reStructuredText scanner', () => {
  it('reads titles, code blocks of every kind, literals, API roles and links', async () => {
    const doc = scanRst('docs/quickstart.rst', await readFile(join(RST_DOCS.dir, 'docs', 'quickstart.rst'), 'utf8'));
    expect(doc.title).toBe('Quickstart');
    expect(doc.sections.map((s) => `${s.level} ${s.anchor} ${s.headingPath.join(' > ')}`)).toEqual([
      '1 quickstart Quickstart',
      '2 connect Quickstart > Connect',
      '2 read-only-queries Quickstart > Read-only queries',
      '3 doctests Quickstart > Read-only queries > Doctests',
    ]);
    expect(doc.sections[1]!.inlineCode.map((c) => c.text)).toEqual(['miniclient.Client', 'Client.select_graph()']);
    expect(doc.sections[2]!.links.map((l) => l.target)).toEqual(['#quickstart', '/advanced']);
    expect(doc.examples.map((e) => `${e.lang} ${e.meta || '-'} L${e.lineno}-${e.endLineno} ${e.directive ?? ''}`.trim())).toEqual([
      'python literal L16-18',
      'python - L26-26',
      'python doctest L33-34',
      'python - L40-40 skip',
      'bash literal L44-44',
    ]);
    expect(doc.examples[0]!.code).toBe('from miniclient import Client\ndb = Client(host="localhost")\ng = db.select_graph("social")');
  });

  it('tells Python literal blocks from other text, and treats .rst as docs', () => {
    expect(looksLikePython('>>> 1 + 1\n2')).toBe(true);
    expect(looksLikePython('client = Client()')).toBe(true);
    expect(looksLikePython('Some plain text\nover lines')).toBe(false);
    expect(classifyFile('docs/user/quickstart.rst')).toBe('markdown');
    expect(classifyFile('CHANGES.rst')).toBeUndefined();
  });
});

describe('Sphinx docs on the graph (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('rst'));
    await indexOrg(graph, [FIXTURE_REPOS[0]!, RST_DOCS]);
  });
  afterAll(async () => done());

  it('links RST examples, roles and :doc: links like Markdown, and checks their calls', async () => {
    const uses = (await graph.run<{ ex: string; sym: string }>(`MATCH (e:CodeExample {repo: 'acme/rst-docs'})-[:USES]->(s:Symbol) RETURN e.id AS ex, s.qualname AS sym ORDER BY ex, sym`)).rows;
    expect(uses.map((u) => `${u.ex.split(':').slice(1).join(':')} → ${u.sym}`)).toEqual([
      'docs/advanced.rst:0 → miniclient.client.Client',
      'docs/advanced.rst:0 → miniclient.client.Client.__init__',
      'docs/advanced.rst:0 → miniclient.client.Client.select_graph',
      'docs/advanced.rst:0 → miniclient.graph.Graph.delete',
      'docs/quickstart.rst:0 → miniclient.client.Client',
      'docs/quickstart.rst:0 → miniclient.client.Client.__init__',
      'docs/quickstart.rst:0 → miniclient.client.Client.select_graph',
      'docs/quickstart.rst:1 → miniclient.graph.Graph.ro_query',
      'docs/quickstart.rst:2 → miniclient.graph.Graph.query',
      'docs/quickstart.rst:3 → miniclient.graph.Graph.query',
    ]);
    const mentions = (await graph.run<{ sec: string; sym: string }>(`MATCH (d:DocSection {repo: 'acme/rst-docs'})-[:MENTIONS]->(s:Symbol) RETURN d.anchor AS sec, s.qualname AS sym ORDER BY sec, sym`)).rows;
    expect(mentions.map((m) => `${m.sec} → ${m.sym}`)).toEqual([
      'connect → miniclient.client.Client',
      'connect → miniclient.client.Client.select_graph',
      'deleting → miniclient.graph.Graph.delete',
    ]);
    const links = (await graph.run<{ from: string; to: string }>(`MATCH (a:DocSection {repo: 'acme/rst-docs'})-[:LINKS_TO]->(b) RETURN a.anchor AS from, b.id AS to ORDER BY from, to`)).rows;
    expect(links.map((l) => `${l.from} → ${l.to.split(':').slice(1).join(':')}`)).toEqual([
      'deleting → docs/quickstart.rst#quickstart',
      'read-only-queries → docs/advanced.rst#advanced',
      'read-only-queries → docs/quickstart.rst#quickstart',
    ]);
    // `g.delete(True)`: Graph.delete takes no argument.
    const mm = (await graph.run<{ ex: string; detail: string }>(`MATCH (e:CodeExample)-[m:MISMATCH]->() RETURN e.id AS ex, m.detail AS detail`)).rows;
    expect(mm).toEqual([{ ex: 'acme/rst-docs:docs/advanced.rst:0', detail: '`Graph.delete` takes at most 0 positional arguments; the example passes 1' }]);
  });
});
