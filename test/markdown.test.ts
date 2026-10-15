import { describe, expect, it } from 'vitest';
import { resolveLink } from '../src/indexer/docs.js';
import { identifiersIn, normalizeLang, packagesNamedIn, scanMarkdown, slugify } from '../src/indexer/markdown.js';

const MDX = `---
title: "Client API"
description: x
---

Intro paragraph with \`FalkorDB\`.

# Client API

## Connect {#custom-connect}

Use \`db.select_graph("x")\` and \`Graph.query\`. See [algorithms](/algorithms/index#bfs) and [here](#queries).

<CodeGroup>
  \`\`\`python Python
  from falkordb import FalkorDB
  db = FalkorDB()
  \`\`\`
  \`\`\`javascript JS
  const db = await FalkorDB.connect()
  \`\`\`
</CodeGroup>

## Queries

### \`ro_query\` (read-only)

\`\`\`py
# not a heading
g.ro_query("MATCH (n) RETURN n")
\`\`\`

## Queries

<Card href="./other.mdx">x</Card>

\`\`\`\`markdown
\`\`\`python
nested
\`\`\`
\`\`\`\`
`;

describe('scanMarkdown', () => {
  const doc = scanMarkdown('docs/client.mdx', MDX);

  it('reads front matter title and builds sections with heading paths and unique anchors', () => {
    expect(doc.title).toBe('Client API');
    expect(doc.sections.map((s) => [s.anchor, s.level, s.headingPath.join(' > ')])).toEqual([
      ['', 0, 'Client API'],
      ['client-api', 1, 'Client API'],
      ['custom-connect', 2, 'Client API > Connect'],
      ['queries', 2, 'Client API > Queries'],
      ['ro_query-read-only', 3, 'Client API > Queries > ro_query (read-only)'],
      ['queries-1', 2, 'Client API > Queries'],
    ]);
    const connect = doc.sections[2]!;
    expect(connect.lineno).toBe(10);
    expect(connect.body.startsWith('## Connect')).toBe(true);
  });

  it('extracts fenced examples (indented MDX fences, info strings, nested fences) into their sections', () => {
    expect(doc.examples.map((e) => [e.index, e.lang, e.meta, e.sectionAnchor])).toEqual([
      [0, 'python', 'Python', 'custom-connect'],
      [1, 'javascript', 'JS', 'custom-connect'],
      [2, 'python', '', 'ro_query-read-only'],
      [3, 'markdown', '', 'queries-1'],
    ]);
    expect(doc.examples[0]!.code).toBe('from falkordb import FalkorDB\ndb = FalkorDB()');
    expect(doc.examples[0]!.lineno).toBe(16);
    expect(doc.examples[2]!.code).toContain('# not a heading');
    expect(doc.examples[3]!.code).toBe('```python\nnested\n```');
  });

  it('collects inline code and links per section', () => {
    const connect = doc.sections[2]!;
    expect(connect.inlineCode.map((c) => c.text)).toEqual(['db.select_graph("x")', 'Graph.query']);
    expect(connect.links.map((l) => l.target)).toEqual(['/algorithms/index#bfs', '#queries']);
    expect(doc.sections[5]!.links.map((l) => l.target)).toEqual(['./other.mdx']);
    expect(doc.sections[0]!.inlineCode.map((c) => c.text)).toEqual(['FalkorDB']);
  });
});

describe('helpers', () => {
  it('normalises languages and slugs', () => {
    expect(normalizeLang('py')).toBe('python');
    expect(normalizeLang('Shell')).toBe('bash');
    expect(slugify('Hello, World! (v2)')).toBe('hello-world-v2');
    const d = scanMarkdown('x.md', '## `backfill_entity_embeddings()` -- **Entity** _vector_ backfill\n');
    expect(d.sections[0]!.title).toBe('backfill_entity_embeddings() -- Entity vector backfill');
    expect(d.sections[0]!.anchor).toBe('backfill_entity_embeddings----entity-vector-backfill');
  });

  it('pulls the code identifier out of inline code, skipping commands, paths, flags, procedures and phrases', () => {
    expect(identifiersIn('db.select_graph("x")')).toEqual([{ ident: 'db.select_graph', called: true }]);
    expect(identifiersIn('Graph.ro_query')).toEqual([{ ident: 'Graph.ro_query', called: false }]);
    expect(identifiersIn('select_graph()')).toEqual([{ ident: 'select_graph', called: true }]);
    for (const span of ['pip install falkordb', 'RESULTSET_SIZE', '/api/graph/x', '--merge-mode', '@falkordb/x', 'db.idx.cch.query', 'Node By Label Scan']) {
      expect(identifiersIn(span)).toEqual([]);
    }
  });

  it('finds package names in install commands and bare package spans', () => {
    expect(packagesNamedIn('pip install graphrag-sdk[all]>=1.0 -U')).toEqual(['graphrag_sdk']);
    expect(packagesNamedIn('uv add falkordb')).toEqual(['falkordb']);
    expect(packagesNamedIn('falkordb')).toEqual(['falkordb']);
    expect(packagesNamedIn('FalkorDB')).toEqual([]);
  });

  it('resolves anchors, relative paths and site-absolute routes', () => {
    const ids = new Map([
      ['docs/a.mdx', new Map([['', 'r:docs/a.mdx#'], ['x', 'r:docs/a.mdx#x']])],
      ['algorithms/index.mdx', new Map([['algorithms', 'r:algorithms/index.mdx#algorithms'], ['bfs', 'r:algorithms/index.mdx#bfs']])],
    ]);
    expect(resolveLink('docs/b.mdx', './a.mdx#x', ids)).toBe('r:docs/a.mdx#x');
    expect(resolveLink('docs/b.mdx', 'a#x', ids)).toBe('r:docs/a.mdx#x');
    expect(resolveLink('docs/b.mdx', '/algorithms#bfs', ids)).toBe('r:algorithms/index.mdx#bfs');
    expect(resolveLink('docs/b.mdx', '/algorithms/index', ids)).toBe('r:algorithms/index.mdx#algorithms');
    expect(resolveLink('docs/a.mdx', '#x', ids)).toBe('r:docs/a.mdx#x');
    expect(resolveLink('docs/a.mdx', 'https://x.y/z', ids)).toBeUndefined();
  });
});
