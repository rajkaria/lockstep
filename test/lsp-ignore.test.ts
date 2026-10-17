import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanDoc } from '../src/indexer/markdown.js';
import { codeDoc } from '../src/lint/facts-docstrings.js';
import { applyTextEdits } from '../src/lint/fixes.js';
import { isSuppressed, scanClaims } from '../src/lint/scan.js';
import type { Finding } from '../src/lint/types.js';
import { ignoreAction } from '../src/lsp/ignore.js';
import { LspWorkspace } from '../src/lsp/workspace.js';
import { fixtureRepo, LSP_FIXTURES } from './lsp-harness.js';

const finding = (over: Partial<Finding>): Finding => ({
  rule: 'path-missing',
  severity: 'error',
  message: 'm',
  path: 'README.md',
  line: 3,
  column: 6,
  endLine: 3,
  endColumn: 14,
  surface: 'readme',
  subject: 's',
  fingerprint: 'f',
  ...over,
});

/** Apply the action and say whether lint's suppression reading silences `rule` on `line` (after the edit). */
function silenced(f: Finding, text: string, line: number, opts: Parameters<typeof ignoreAction>[2] = {}): { after: string; ok: boolean } {
  const action = ignoreAction(f, text, opts)!;
  expect(action, 'an action').toBeDefined();
  const after = applyTextEdits(text, [action.edit]);
  const doc = /\.(md|mdx|mdc|rst)$/.test(f.path) ? scanClaims(f.path, after) : codeDoc(f.path, after);
  return { after, ok: isSuppressed(doc, line, f.rule) && !isSuppressed(doc, line, 'link-broken') };
}

describe('"ignore this rule here"', () => {
  it('Markdown: a comment at the end of the line, before a hard break', () => {
    const text = '# Title\n\nSee `src/x.ts` here.  \nNext line.\n';
    const { after, ok } = silenced(finding({}), text, 3);
    expect(after.split('\n')[2]).toBe('See `src/x.ts` here. <!-- staleproof: ignore path-missing -->  ');
    expect(ok).toBe(true);
  });

  it('Markdown: adds the rule to a comment already on the line', () => {
    const text = '# Title\n\nSee `src/x.ts` and [y](y.md). <!-- staleproof: ignore link-broken -->\n';
    const action = ignoreAction(finding({}), text)!;
    const after = applyTextEdits(text, [action.edit]);
    expect(after.split('\n')[2]).toBe('See `src/x.ts` and [y](y.md). <!-- staleproof: ignore link-broken path-missing -->');
    const doc = scanClaims('README.md', after);
    expect(isSuppressed(doc, 3, 'path-missing') && isSuppressed(doc, 3, 'link-broken')).toBe(true);
  });

  it('Markdown heading: the comment goes on the line before, so the anchor stays the same', () => {
    const text = '# Title\n\n## Using `old_name()`\n\nBody.\n';
    const f = finding({ rule: 'symbol-missing', line: 3, column: 11 });
    const { after, ok } = silenced(f, text, 4);
    expect(after.split('\n').slice(2, 4)).toEqual(['<!-- staleproof: ignore symbol-missing -->', '## Using `old_name()`']);
    expect(ok).toBe(true);
    expect(scanDoc('README.md', after).sections.map((s) => s.anchor)).toEqual(scanDoc('README.md', text).sections.map((s) => s.anchor));
  });

  it('MDX: a JSX comment', () => {
    const text = '# Title\n\nSee `src/x.ts` here.\n';
    const { after, ok } = silenced(finding({ path: 'docs/page.mdx', surface: 'docs' }), text, 3);
    expect(after.split('\n')[2]).toBe('See `src/x.ts` here. {/* staleproof: ignore path-missing */}');
    expect(ok).toBe(true);
  });

  it('reStructuredText: a comment before the paragraph, and only at its first line', () => {
    const text = 'Title\n=====\n\nSee ``src/x.py`` here.\nMore of the paragraph.\n';
    const f = finding({ path: 'docs/index.rst', surface: 'docs', line: 4 });
    const { after, ok } = silenced(f, text, 6);
    expect(after.split('\n').slice(3, 6)).toEqual(['.. staleproof: ignore path-missing', '', 'See ``src/x.py`` here.']);
    expect(ok).toBe(true);
    expect(ignoreAction({ ...f, line: 5 }, text)).toBeUndefined();
  });

  it('a code example: skip the example (examples only); a shell block cannot take a comment', () => {
    const text = '# T\n\n```python\nconnect(timeout=3)\n```\n\n```bash\nnpm run gone\n```\n';
    const ex = ignoreAction(finding({ rule: 'example-unknown-keyword', line: 4, column: 1, endColumn: 8 }), text)!;
    expect(ex.title).toBe('Skip this example (staleproof: skip)');
    expect(applyTextEdits(text, [ex.edit]).split('\n').slice(2, 4)).toEqual(['<!-- staleproof: skip -->', '```python']);
    expect(scanDoc('README.md', applyTextEdits(text, [ex.edit])).examples[0]!.directive).toBe('skip');
    expect(ignoreAction(finding({ rule: 'command-missing', line: 8, column: 1, endColumn: 13 }), text)).toBeUndefined();
  });

  it('Python docstrings: on the definition line', () => {
    const text = 'class C:\n    @property\n    def f(self, a):\n        """Doc.\n\n        Args:\n            b: x.\n        """\n';
    const f = finding({ rule: 'docstring-param-unknown', path: 'pkg/c.py', surface: 'docstring', line: 7, column: 13 });
    const { after, ok } = silenced(f, text, 3, { definitionLine: () => 3 });
    expect(after.split('\n')[2]).toBe('    def f(self, a): # staleproof: ignore[docstring-param-unknown]');
    expect(ok).toBe(true);
    // Without the definition it is not offered.
    expect(ignoreAction(f, text)).toBeUndefined();
    // A continued line takes the comment on the line before.
    const cont = 'def g(a, \\\n      b):\n    pass\n';
    const c = ignoreAction({ ...f, line: 1 }, cont, { definitionLine: () => 1 })!;
    expect(applyTextEdits(cont, [c.edit]).split('\n')[0]).toBe('# staleproof: ignore[docstring-param-unknown]');
  });

  it('TypeScript: `//` on the function line, merged with an existing list', () => {
    const text = '/**\n * @param b x\n */\nexport function f(a: number) { // staleproof: ignore[docstring-param-undocumented]\n  return a;\n}\n';
    const f = finding({ rule: 'docstring-param-unknown', path: 'src/f.ts', surface: 'docstring', line: 2, column: 11 });
    const { after, ok } = silenced(f, text, 4, { definitionLine: () => 4 });
    expect(after.split('\n')[3]).toBe('export function f(a: number) { // staleproof: ignore[docstring-param-undocumented, docstring-param-unknown]');
    expect(ok).toBe(true);
  });

  it('env files: a comment line before the variable', () => {
    const text = 'PKG_HOST=localhost\nPKG_OLD=1\n';
    const f = finding({ rule: 'env-unused', path: '.env.example', surface: 'config', line: 2, column: 1, endColumn: 8 });
    const { after, ok } = silenced(f, text, 3);
    expect(after).toBe('PKG_HOST=localhost\n# staleproof: ignore[env-unused]\nPKG_OLD=1\n');
    expect(ok).toBe(true);
  });

  it('is offered by the workspace only when it silences the finding (docstrings, re-checked)', async () => {
    const dir = await fixtureRepo(join(LSP_FIXTURES, 'basic'));
    const ws = new LspWorkspace({ root: dir, cache: false, renameBase: false });
    const text = await readFile(join(dir, 'pkg/client.py'), 'utf8');
    await ws.setText('pkg/client.py', 'file:///x', 1, text);
    const [f] = (await ws.check('pkg/client.py')).findings;
    expect(f!.rule).toBe('docstring-param-unknown');
    const action = (await ws.ignoreFor('pkg/client.py', f!))!;
    expect(action.edit).toMatchObject({ line: 11, newText: ' # staleproof: ignore[docstring-param-unknown]' });
    await ws.setText('pkg/client.py', 'file:///x', 2, applyTextEdits(text, [action.edit]));
    expect((await ws.check('pkg/client.py')).findings).toEqual([]);
    await ws.dispose();
  });
});
