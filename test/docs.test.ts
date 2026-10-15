import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { END, graphModelDoc, readmeCypher, START } from '../scripts/gen-docs.js';
import { ALL_QUERIES } from '../src/graph/queries.js';

const root = join(import.meta.dirname, '..');

describe('generated docs stay in sync with the code', () => {
  it('README carries every tool and memory query verbatim (run `npm run docs` if this fails)', async () => {
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf(START), readme.indexOf(END) + END.length);
    expect(section).toBe(readmeCypher());
    for (const q of ALL_QUERIES.filter((x) => x.group === 'tool' || x.group === 'memory')) expect(readme).toContain(q.cypher);
  });

  it('docs/GRAPH-MODEL.md carries every query', async () => {
    const doc = await readFile(join(root, 'docs', 'GRAPH-MODEL.md'), 'utf8');
    expect(doc.trim()).toBe(graphModelDoc().trim());
    for (const q of ALL_QUERIES) expect(doc).toContain(q.cypher);
  });

  it('keeps internal hackathon material out of the public repository', async () => {
    const { execFileSync } = await import('node:child_process');
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(files.some((f) => f.startsWith('.ocean/') || f.startsWith('.claude/'))).toBe(false);
    const banned = /pre-?mortem|judge panel|battle clock|blind screen|win(ning)? the hackathon/i;
    for (const f of files.filter((x) => /\.(md|ts|tsx|json|yml|txt)$/.test(x) && !x.startsWith('test/'))) {
      const text = await readFile(join(root, f), 'utf8');
      expect(banned.test(text), f).toBe(false);
    }
  });
});
