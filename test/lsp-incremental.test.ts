import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { lintRepo } from '../src/lint/engine.js';
import type { Finding } from '../src/lint/types.js';
import { BufferFacts } from '../src/lsp/facts.js';
import { checkedPage, CODE_RULES, ENV_PAGE_RULES, envClaimNames, envFindings, lintCode, lintPage, PAGE_RULES, parsedModule } from '../src/lsp/incremental.js';
import { carryEdits, carryFindings, diffEdit, lineMap } from '../src/lsp/lines.js';
import { applyTextEdits } from '../src/lint/fixes.js';
import { buildModel, type LintModel } from '../src/lsp/model.js';
import { fixtureRepo, git, LSP_FIXTURES } from './lsp-harness.js';
import { FIXTURES } from './helpers.js';

const key = (f: Finding) => `${f.path}:${f.line}:${f.column}-${f.endLine}:${f.endColumn} ${f.severity} ${f.rule} ${f.subject} ${f.fingerprint} | ${f.message} | ${f.evidence?.looked}`;
const keys = (fs: Finding[]) => fs.map(key).sort();

/** What the per-file passes report for every page and code file of a snapshot. */
async function perFile(model: LintModel): Promise<{ pages: Map<string, Finding[]>; code: Map<string, Finding[]> }> {
  const pages = new Map<string, Finding[]>();
  for (const page of model.pages.values()) pages.set(page.target.path, [...(await lintPage(model, page)), ...(await envFindings(model, page))]);
  const code = new Map<string, Finding[]>();
  for (const m of model.parsed[0]!.modules) {
    if (m.lang === 'go' || !parsedModule(model, m.path)) continue;
    const text = await readFile(join(model.root, m.path), 'utf8');
    code.set(m.path, await lintCode(model, m.path, text));
  }
  return { pages, code };
}

for (const [name, setup] of [
  ['lsp/basic', () => fixtureRepo(join(LSP_FIXTURES, 'basic'))],
  [
    'claims',
    async () => {
      // As test/lint.test.ts builds it: history with one file moved and one deleted.
      const dir = await fixtureRepo(join(FIXTURES, 'claims'));
      // git keeps no empty folders: the rename target is made here, not in the fixture.
      await mkdir(join(dir, 'src', 'helpers'), { recursive: true });
      git(dir, 'mv', 'src/util/old.ts', 'src/helpers/old.ts');
      git(dir, 'rm', '-q', 'lib/removed.ts');
      git(dir, 'commit', '-q', '-m', 'move helpers, drop lib');
      return dir;
    },
  ],
] as const) {
  describe(`per-file checks against staleproof lint (${name})`, () => {
    let dir: string;
    let model: LintModel;

    beforeAll(async () => {
      dir = await setup();
      model = await buildModel(dir, { buffers: new Map() });
    });

    it('report for each page and code file exactly what lint reports for it', async () => {
      const { pages, code } = await perFile(model);
      const all = model.result.findings;
      expect(all.length).toBeGreaterThan(0);
      for (const [path, mine] of pages) {
        const lint = all.filter((f) => f.path === path && (PAGE_RULES.has(f.rule) || ENV_PAGE_RULES.has(f.rule)));
        expect(keys(mine), path).toEqual(keys(lint));
      }
      for (const [path, mine] of code) {
        expect(keys(mine), path).toEqual(keys(all.filter((f) => f.path === path && CODE_RULES.has(f.rule))));
      }
      // Every other finding is carried from the snapshot: env-undocumented (in code), and findings in env files.
      const covered = new Set([...pages.values(), ...code.values()].flat().map((f) => f.fingerprint));
      for (const f of all) if (!covered.has(f.fingerprint)) expect(f.rule === 'env-undocumented' || !model.targets.has(f.path), key(f)).toBe(true);
    });

    it('report for an edited page what lint reports once the same text is on disk', async () => {
      const page = [...model.pages.values()].find((p) => p.target.surface !== 'agent') ?? [...model.pages.values()][0]!;
      const path = page.target.path;
      const edited = [
        '# Moved around',
        '',
        'See `pkg/nowhere.py`, `src/nowhere.ts`, [a gone page](docs/gone.md) and [this](#not-a-heading).',
        '',
        page.text.replace(/\n## /, '\n\nAn inserted paragraph that shifts everything below.\n\n## '),
      ].join('\n');
      const buffers = new Map([[path, edited]]);
      const facts = new BufferFacts(model.root, new Set(model.paths), buffers);
      facts.adoptHistory(model.facts);
      const live = { ...model, facts };
      const mine = await lintPage(live, checkedPage(live, path, edited)!);
      const env = await envFindings(live, checkedPage(live, path, edited)!);

      const copy = await mkdtemp(join(tmpdir(), 'staleproof-lsp-edited-'));
      await cp(dir, copy, { recursive: true });
      await writeFile(join(copy, path), edited);
      const lint = await lintRepo({ dir: copy, repo: model.repo });
      const lintKeys = (fs: Finding[]) => keys(fs).map((k) => k.replace(/https:\/\/github\.com\/\S+/g, ''));
      expect(lintKeys([...mine, ...env])).toEqual(lintKeys(lint.findings.filter((f) => f.path === path && (PAGE_RULES.has(f.rule) || ENV_PAGE_RULES.has(f.rule)))));
      expect(mine.length).toBeGreaterThan(0);
    });
  });
}

describe('docstrings from an unsaved code buffer', () => {
  it('re-check the edited file against its own text', async () => {
    const dir = await fixtureRepo(join(LSP_FIXTURES, 'basic'));
    const model = await buildModel(dir, { buffers: new Map() });
    const disk = await readFile(join(dir, 'pkg/client.py'), 'utf8');
    expect((await lintCode(model, 'pkg/client.py', disk)).map((f) => f.subject)).toEqual(['Client.query(parameters)']);
    const fixed = disk.replace('parameters: Query parameters.', 'params: Query parameters.');
    expect(await lintCode(model, 'pkg/client.py', fixed)).toEqual([]);
    const worse = fixed.replace('def close(self):\n        """Close the connection."""', 'def close(self, force):\n        """Close the connection.\n\n        Args:\n            forced: Close at once.\n        """');
    expect((await lintCode(model, 'pkg/client.py', worse)).map((f) => `${f.line}:${f.column} ${f.subject}`)).toEqual(['24:13 Client.close(forced)']);
  });
});

describe('the variables a page documents', () => {
  it('change only when a claim is added, removed or renamed', async () => {
    const dir = await fixtureRepo(join(LSP_FIXTURES, 'basic'));
    const model = await buildModel(dir, { buffers: new Map() });
    const page = model.pages.get('docs/guide.md')!;
    expect(envClaimNames(page)).toEqual(['PKG_HOST', 'PKG_TIMEOUT_SECONDS']);
    const prose = checkedPage(model, page.target.path, page.text.replace('Install the package', 'Install the pkg package'))!;
    expect(envClaimNames(prose)).toEqual(['PKG_HOST', 'PKG_TIMEOUT_SECONDS']);
    const renamed = checkedPage(model, page.target.path, page.text.replace('PKG_TIMEOUT_SECONDS', 'PKG_HOST_TIMEOUT'))!;
    expect(envClaimNames(renamed)).toEqual(['PKG_HOST', 'PKG_HOST_TIMEOUT']);
  });
});

describe('carrying findings and fixes to an edited buffer', () => {
  const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
  const after = ['a', 'new', 'b', 'C', 'd', 'e'].join('\n');

  it('maps unchanged lines and drops the changed ones', () => {
    const map = lineMap(before, after);
    expect([1, 2, 3, 4, 5].map(map)).toEqual([1, undefined, undefined, 5, 6]);
    expect(lineMap(before, before)(3)).toBe(3);
  });

  it('moves findings below an edit and drops those inside it', () => {
    const f = (line: number) => ({ line, endLine: line, column: 1, endColumn: 2 }) as Finding;
    const r = carryFindings([f(1), f(3), f(5)], before, after);
    expect(r.kept.map((x) => x.line)).toEqual([1, 6]);
    expect(r.dropped).toBe(1);
  });

  it('moves edits only when the text they replace is unchanged', () => {
    const e = { path: 'x.md', line: 5, column: 1, endLine: 5, endColumn: 2, newText: 'E' };
    expect(carryEdits([e], before, after)).toEqual([{ ...e, line: 6, endLine: 6 }]);
    expect(carryEdits([{ ...e, line: 3, endLine: 3 }], before, after)).toBeUndefined();
    expect(carryEdits([{ ...e, line: 4, endLine: 4, column: 1, endColumn: 2 }], before, ['a', 'b', 'c', 'X', 'e'].join('\n'))).toBeUndefined();
  });

  it('turns one text into another with a single minimal edit', () => {
    const a = 'line one\nline two `old` here\nline three\n';
    const b = 'line one\nline two `new` here\nline three\n';
    const e = diffEdit('x.md', a, b)!;
    expect(e).toMatchObject({ line: 2, column: 11, endLine: 2, endColumn: 14, newText: 'new' });
    expect(applyTextEdits(a, [e])).toBe(b);
    for (const [x, y] of [
      ['', 'all new\n'],
      ['abc\n', ''],
      ['a\nb\nc\n', 'a\nc\n'],
      ['a\nb\n', 'a\nb\nc\n'],
      ['x\r\ny\r\n', 'x\r\nz\r\n'],
    ]) {
      expect(applyTextEdits(x!, [diffEdit('x.md', x!, y!)!])).toBe(y);
    }
  });
});
