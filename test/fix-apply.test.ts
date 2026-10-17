import { describe, expect, it } from 'vitest';
import { applyFixes, applyTextEdits } from '../src/lint/fixes.js';
import type { Fix, TextEdit } from '../src/lint/types.js';

const edit = (line: number, column: number, endColumn: number, newText: string, path = 'README.md', endLine = line): TextEdit => ({
  path,
  line,
  column,
  endLine,
  endColumn,
  newText,
});

describe('applyTextEdits', () => {
  it('replaces a span on one line (1-based, end column exclusive)', () => {
    expect(applyTextEdits('Run `npm run lint:docs` first.\n', [edit(1, 6, 23, 'npm run docs:lint')])).toBe('Run `npm run docs:lint` first.\n');
  });

  it('applies several edits in any order, measured on the original text', () => {
    const text = 'a `x` b `y`\nc `z`\n';
    expect(applyTextEdits(text, [edit(2, 4, 5, 'ZZ'), edit(1, 4, 5, 'XXX'), edit(1, 10, 11, '')])).toBe('a `XXX` b ``\nc `ZZ`\n');
  });

  it('keeps CRLF and CR line endings and counts columns within the line', () => {
    expect(applyTextEdits('one\r\ntwo `old`\r\n', [edit(2, 6, 9, 'new')])).toBe('one\r\ntwo `new`\r\n');
    expect(applyTextEdits('one\rtwo\r', [edit(2, 1, 4, 'TWO')])).toBe('one\rTWO\r');
  });

  it('edits across lines and inserts at the end of a line or the file', () => {
    expect(applyTextEdits('ab\ncd\n', [edit(1, 2, 2, 'X\nY', 'f', 2)])).toBe('aX\nYd\n');
    expect(applyTextEdits('ab\ncd', [edit(2, 3, 3, '!')])).toBe('ab\ncd!');
    expect(applyTextEdits('ab\n', [edit(2, 1, 1, 'new')])).toBe('ab\nnew');
  });

  it('throws on overlapping edits and on two insertions at one point', () => {
    expect(() => applyTextEdits('abcdef', [edit(1, 1, 4, 'x'), edit(1, 3, 5, 'y')])).toThrow(/overlap/);
    expect(() => applyTextEdits('abcdef', [edit(1, 2, 2, 'x'), edit(1, 2, 2, 'y')])).toThrow(/overlap/);
    // Touching ranges do not overlap.
    expect(applyTextEdits('abcdef', [edit(1, 1, 3, 'X'), edit(1, 3, 5, 'Y')])).toBe('XYef');
  });

  it('throws on positions outside the file', () => {
    expect(() => applyTextEdits('ab\n', [edit(5, 1, 1, 'x')])).toThrow(/past the end of the file/);
    expect(() => applyTextEdits('ab\n', [edit(1, 1, 9, 'x')])).toThrow(/past the end of line 1/);
    expect(() => applyTextEdits('ab\n', [edit(1, 0, 1, 'x')])).toThrow(/1-based/);
    expect(() => applyTextEdits('abc\n', [edit(1, 3, 2, 'x')])).toThrow(/ends before it starts/);
  });

  it('returns the text unchanged without edits', () => {
    expect(applyTextEdits('same', [])).toBe('same');
  });
});

describe('applyFixes', () => {
  const fix = (edits: TextEdit[]): Fix => ({ description: 'd', edits, verified: true });

  it('applies the edits of several fixes to several files and returns only changed files', () => {
    const files = new Map([
      ['README.md', 'Run `make docs`.\n'],
      ['AGENTS.md', 'See `src/old.ts`.\n'],
      ['docs/x.md', 'untouched\n'],
    ]);
    const out = applyFixes(files, [fix([edit(1, 6, 15, 'make site')]), fix([edit(1, 6, 16, 'src/new.ts', 'AGENTS.md')]), fix([edit(1, 1, 10, 'untouched', 'docs/x.md')])]);
    expect([...out.entries()]).toEqual([
      ['README.md', 'Run `make site`.\n'],
      ['AGENTS.md', 'See `src/new.ts`.\n'],
    ]);
    expect(files.get('README.md')).toBe('Run `make docs`.\n');
  });

  it('throws when two fixes edit the same text or a file is missing', () => {
    const files = new Map([['README.md', 'Run `make docs`.\n']]);
    expect(() => applyFixes(files, [fix([edit(1, 6, 15, 'a')]), fix([edit(1, 6, 15, 'b')])])).toThrow(/overlap/);
    expect(() => applyFixes(files, [fix([edit(1, 1, 2, 'a', 'gone.md')])])).toThrow(/no content for gone.md/);
  });
});
