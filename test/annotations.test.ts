import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import { directiveFor, scanMarkdown } from '../src/indexer/markdown.js';
import { globToRegExp, loadRepoConfig, matchesAny, parseRepoConfig } from '../src/indexer/repo-config.js';
import { runExampleTool } from '../src/tools/run-example.js';
import { FIXTURE_REPOS, STALE_DOCS, testConfig, testGraph } from './helpers.js';

describe('example directives', () => {
  const at = (before: string[], meta = '') => directiveFor([...before, '```python'], before.length, meta);

  it('reads Staleproof markers in HTML and MDX comments, and other tools\' markers', () => {
    expect(at(['<!-- staleproof: skip -->'])).toBe('skip');
    expect(at(['<!--staleproof:expect-error-->', ''])).toBe('expect-error');
    expect(at(['{/* staleproof: skip */}'])).toBe('skip');
    expect(at(['<!--pytest-codeblocks:skip-->'])).toBe('skip');
    expect(at(['<!-- pytest-codeblocks:expect-exception -->'])).toBe('expect-error');
    expect(at(['<!-- skip: next -->'])).toBe('skip');
  });

  it('reads fence words, and ignores comments that are not directly above', () => {
    expect(at([], 'skip')).toBe('skip');
    expect(at([], 'title="a" no-run')).toBe('skip');
    expect(at([], '{expect-error}')).toBe('expect-error');
    expect(at([], 'title="How to skip"')).toBeUndefined();
    expect(at(['<!-- staleproof: skip -->', 'Some text.'])).toBeUndefined();
    expect(at(['<!-- a note -->'])).toBeUndefined();
  });

  it('marks the scanned example', () => {
    const doc = scanMarkdown('a.md', '# A\n\n<!-- staleproof: skip -->\n```python\nx()\n```\n\n```python\ny()\n```\n');
    expect(doc.examples.map((e) => e.directive)).toEqual(['skip', undefined]);
  });
});

describe('repository config', () => {
  it('matches gitignore-style globs', () => {
    expect(globToRegExp('docs/legacy/**').test('docs/legacy/a/b.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/a.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/x/a.md')).toBe(false);
    expect(globToRegExp('**/CHANGELOG.md').test('CHANGELOG.md')).toBe(true);
    expect(globToRegExp('**/CHANGELOG.md').test('pkg/CHANGELOG.md')).toBe(true);
    expect(matchesAny('docs/v1/guide.md', ['docs/v1'])).toBe(true);
    expect(matchesAny('docs/v10/guide.md', ['docs/v1'])).toBe(false);
  });

  it('reads .staleproof.toml and [tool.staleproof], and rejects wrong types', () => {
    expect(parseRepoConfig('ignore = ["a/**"]\nskip-examples = ["b.md"]\n', '.staleproof.toml')).toEqual({ ignore: ['a/**'], skipExamples: ['b.md'] });
    expect(parseRepoConfig('[tool.staleproof]\nignore = ["x"]\n', 'pyproject.toml')).toEqual({ ignore: ['x'], skipExamples: [] });
    expect(parseRepoConfig('[project]\nname = "x"\n', 'pyproject.toml')).toEqual({ ignore: [], skipExamples: [] });
    expect(() => parseRepoConfig('ignore = "a"\n', '.staleproof.toml')).toThrow('ignore must be a list of glob strings');
  });
});

describe('directives and config on the graph (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'staleproof-annot-'));
    await cp(STALE_DOCS.dir, dir, { recursive: true });
    // The second block (L19-20) is marked as failing on purpose; a whole page is skipped by config; another is ignored.
    const page = join(dir, 'docs', 'stale.md');
    const { readFile } = await import('node:fs/promises');
    await writeFile(page, (await readFile(page, 'utf8')).replace('## Query\n\nUse `Graph.query` and `Graph.ro_query`.\n\n', '## Query\n\nUse `Graph.query` and `Graph.ro_query`.\n\n<!-- staleproof: expect-error -->\n'));
    await writeFile(join(dir, 'docs', 'v1.md'), '# Old\n\n```python\nfrom miniclient import Gone\n```\n');
    await writeFile(join(dir, 'docs', 'drafts.md'), '# Draft\n\n```python\nfrom miniclient import AlsoGone\n```\n');
    await writeFile(join(dir, '.staleproof.toml'), 'skip-examples = ["docs/v1.md"]\nignore = ["docs/drafts.md"]\n');
    ({ graph, done } = await testGraph('annot'));
    await indexOrg(graph, [...FIXTURE_REPOS.slice(0, 2), { ...STALE_DOCS, dir }]);
  });
  afterAll(async () => {
    await done();
    await rm(dir, { recursive: true, force: true });
  });

  it('records no mismatch for marked examples or skipped pages, and never indexes ignored ones', async () => {
    expect((await loadRepoConfig(dir)).skipExamples).toEqual(['docs/v1.md']);
    const rows = (await graph.run<{ ex: string; kind: string }>(`MATCH (e:CodeExample)-[m:MISMATCH]->() RETURN e.id AS ex, m.kind AS kind ORDER BY ex, kind`)).rows;
    expect(rows.map((r) => `${r.ex.split(':').slice(1).join(':')} ${r.kind}`)).toEqual([
      'docs/stale.md:0 missing-import',
      'docs/stale.md:0 unknown-keyword',
      'docs/stale.md:2 unknown-keyword',
    ]);
    const marked = (await graph.run<{ id: string; d: string }>(`MATCH (e:CodeExample {repo: 'acme/stale-docs'}) RETURN e.id AS id, e.directive AS d ORDER BY id`)).rows;
    expect(marked.map((r) => `${r.id.split(':').slice(1).join(':')} ${r.d || '-'}`)).toEqual([
      'docs/stale.md:0 -',
      'docs/stale.md:1 expect-error',
      'docs/stale.md:2 -',
      'docs/stale.md:3 -',
      'docs/v1.md:0 skip',
    ]);
  });

  it('does not run marked examples', async () => {
    const r = await runExampleTool.run({ graph, config: testConfig() }, { example_id: 'acme/stale-docs:docs/stale.md:1' });
    expect(r.data.verdict).toBe('skipped');
    expect(r.summary).toBe('Not run: the docs mark this example as failing on purpose (expect-error), so a run proves nothing.');
  });
});
