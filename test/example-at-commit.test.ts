import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanMarkdown } from '../src/indexer/markdown.js';
import { exampleAtCommit, type ExampleForRun } from '../src/runner/index.js';
import { gitIn, makeGitOrg, testConfig } from './helpers.js';

describe('examples on a page the pull request edits', () => {
  let org: Awaited<ReturnType<typeof makeGitOrg>>;
  let docs: string;
  let base: string;
  let page: string;
  let example: ExampleForRun;
  const config = testConfig();

  beforeAll(async () => {
    org = await makeGitOrg();
    docs = org.checkouts.find((c) => c.repo === 'acme/mini-docs')!.dir;
    base = gitIn(docs, 'rev-parse', 'HEAD');
    for (const p of gitIn(docs, 'ls-files').split('\n').filter((f) => /\.mdx?$/.test(f))) {
      const ex = scanMarkdown(p, await readFile(join(docs, p), 'utf8')).examples.find((e) => e.lang === 'python');
      if (ex) {
        page = p;
        example = { id: `acme/mini-docs:${p}:${ex.index}`, lang: ex.lang, code: ex.code, repo: 'acme/mini-docs', path: p, url: '', usedRepos: [], earlier: [] };
        break;
      }
    }
  });
  afterAll(() => rm(org.root, { recursive: true, force: true }));

  it('runs the edited version, and knows when the example is gone', async () => {
    const text = await readFile(join(docs, page), 'utf8');
    await writeFile(join(docs, page), text.replace(example.code, `${example.code}print("edited")\n`));
    gitIn(docs, 'commit', '-qam', 'edit');
    const edited = await exampleAtCommit(config, example, base, gitIn(docs, 'rev-parse', 'HEAD'), docs);
    expect(edited?.code).toBe(`${example.code}print("edited")\n`);
    expect(edited?.id).toBe(example.id);

    await writeFile(join(docs, page), text.replace(/```python[^\n]*\n[\s\S]*?```\n?/g, ''));
    gitIn(docs, 'commit', '-qam', 'remove');
    expect(await exampleAtCommit(config, example, base, gitIn(docs, 'rev-parse', 'HEAD'), docs)).toBeNull();
    expect(await exampleAtCommit(config, example, base, base, docs)).toMatchObject({ code: example.code });
    expect(await exampleAtCommit(config, example, base, 'f'.repeat(40), docs)).toBeUndefined();
  });
});
