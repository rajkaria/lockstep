import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintRepo, workingFiles } from '../src/lint/engine.js';
import { addFixes, applyFixes, verifiedFixes } from '../src/lint/fixes.js';
import { refTree, worktreeTree, type LintTree } from '../src/lint/sources.js';
import type { Finding, LintResult } from '../src/lint/types.js';
import { baseRepo, edit, FIX_APP, git, headChange, moreChange, moreRepo, put } from './fix-helpers.js';

const key = (f: Finding) => `${f.path}:${f.line} ${f.rule} ${f.subject}`;
const fixOf = (r: LintResult, k: string) => r.findings.find((f) => key(f) === k)?.fix;
const newTexts = (r: LintResult, k: string) => fixOf(r, k)?.edits.map((e) => e.newText);

/** Apply every verified fix of `r` to the files of `dir`. */
async function applyVerified(dir: string, r: LintResult): Promise<string[]> {
  const fixes = verifiedFixes(r).map((f) => f.fix!);
  const paths = [...new Set(fixes.flatMap((x) => x.edits.map((e) => e.path)))];
  const files = new Map(await Promise.all(paths.map(async (p) => [p, await readFile(join(dir, p), 'utf8')] as const)));
  const changed = applyFixes(files, fixes);
  for (const [p, text] of changed) await writeFile(join(dir, p), text);
  return [...changed.keys()];
}

describe('addFixes: renames between base and head', () => {
  let dir: string;
  let base: string;
  let baseTree: LintTree;
  let result: LintResult;
  let fixed: LintResult;

  beforeAll(async () => {
    ({ dir, base } = await baseRepo());
    await headChange(dir);
    result = await lintRepo({ dir });
    baseTree = await refTree(dir, base);
    fixed = await addFixes(result, worktreeTree(dir), { baseTree });
  });
  afterAll(async () => {
    await baseTree?.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces a renamed script, Make target, flag, file and docs page with the new name, verified', () => {
    expect(fixOf(fixed, 'AGENTS.md:4 command-missing npm run lint:docs')).toMatchObject({
      description: 'Rename to `npm run docs:lint` (renamed in package.json)',
      edits: [{ path: 'AGENTS.md', line: 4, column: 32, endLine: 4, endColumn: 41, newText: 'docs:lint' }],
      verified: true,
    });
    expect(fixOf(fixed, 'AGENTS.md:4 command-missing make check-docs')).toMatchObject({ edits: [{ newText: 'docs-check' }], verified: true });
    expect(fixOf(fixed, 'AGENTS.md:6 cli-flag-unknown mytool --quiet')).toMatchObject({ description: 'Rename to `--silent` (renamed in this change)', verified: true });
    expect(fixOf(fixed, 'docs/usage.md:3 link-broken docs/old-guide.md')).toMatchObject({ edits: [{ newText: 'guide.md' }], verified: true });
    const path = fixed.findings.filter((f) => f.rule === 'path-missing');
    expect(path.map((f) => [f.column, f.fix?.edits[0]?.newText, f.fix?.description])).toEqual([
      [21, 'src/config/defaults.ts', 'Rename to `src/config/defaults.ts` (renamed in this change)'],
      [68, 'src/config/defaults.ts', 'Rename to `src/config/defaults.ts` (renamed in this change)'],
    ]);
  });

  it('a fix that adds a finding fails verification and stays a hint', () => {
    // `src/settings/defaults.ts:40` would point past the end of the moved file (line-out-of-range).
    const [plain, withLine] = fixed.findings.filter((f) => f.rule === 'path-missing');
    expect(plain!.fix!.verified).toBe(true);
    expect(withLine!.fix).toMatchObject({ verified: false, edits: [{ newText: 'src/config/defaults.ts' }] });
  });

  it('uses the one close name when nothing was renamed, and refuses ties and short names', () => {
    expect(fixOf(fixed, 'AGENTS.md:5 command-missing npm run buld')).toMatchObject({ description: 'Rename to `npm run build` (the closest script in package.json)', verified: true });
    expect(fixOf(fixed, 'AGENTS.md:6 cli-flag-unknown mytool --colour')).toMatchObject({ edits: [{ newText: '--color' }], verified: true });
    expect(fixOf(fixed, 'docs/usage.md:3 anchor-missing docs/setup.md#instal')).toMatchObject({ edits: [{ column: 27, endColumn: 33, newText: 'install' }], verified: true });
    expect(fixOf(fixed, 'docs/usage.md:5 symbol-missing Client.qeury')).toMatchObject({ description: 'Rename to `Client.query` (the closest member of `Client`)', verified: true });
    // `dov` is one edit from both `dev` and `doc`: ambiguous.
    expect(fixOf(fixed, 'AGENTS.md:5 command-missing npm run dov')).toBeUndefined();
    // `tset` is two edits from `test`: too far for a four-letter name.
    expect(fixOf(fixed, 'AGENTS.md:5 command-missing npm run tset')).toBeUndefined();
  });

  it('renames an env var everywhere a page names it, and a docstring parameter and an example keyword', () => {
    expect(newTexts(fixed, 'README.md:3 env-unused REDIS_HSOT')).toEqual(['REDIS_HOST']);
    expect(fixOf(fixed, '.env.example:3 env-unused REDIS_HSOT')).toMatchObject({ edits: [{ path: '.env.example', line: 3, column: 1, endColumn: 11 }], verified: true });
    expect(fixOf(fixed, 'mypkg/client.py:12 docstring-param-unknown Client.query(timeout_ms)')).toMatchObject({
      description: 'Rename to `timeout` (the one undocumented parameter of `Client.query`)',
      edits: [{ path: 'mypkg/client.py', line: 12, column: 13, endColumn: 23, newText: 'timeout' }],
      verified: true,
    });
    expect(fixOf(fixed, 'docs/usage.md:11 example-unknown-keyword mypkg.client.Client.query')).toMatchObject({
      edits: [{ line: 11, column: 31, endColumn: 37, newText: 'timeout' }],
      verified: true,
    });
  });

  it('never writes the tree: only the head change is in git status', () => {
    expect(git(dir, 'status', '--porcelain').split('\n').map((l) => l.trim()).sort()).toEqual(
      ['M Makefile', 'M mypkg/cli.py', 'M package.json', 'M src/app.ts', 'R  docs/old-guide.md -> docs/guide.md', 'R  src/settings/defaults.ts -> src/config/defaults.ts'].sort(),
    );
  });

  it('applying the verified fixes clears their findings and adds none; a second run has nothing to do', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'staleproof-fixes-apply-'));
    try {
      await cp(dir, copy, { recursive: true });
      const changed = await applyVerified(copy, fixed);
      expect(changed.sort()).toEqual(['.env.example', 'AGENTS.md', 'README.md', 'docs/usage.md', 'mypkg/client.py']);
      const after = await lintRepo({ dir: copy });
      // Every finding left was there before and had no verified fix (counted by rule, file and subject).
      const left = new Map<string, number>();
      for (const f of result.findings) if (!f.fix?.verified && fixed.findings.find((x) => x.fingerprint === f.fingerprint && !x.fix?.verified)) left.set(key(f), (left.get(key(f)) ?? 0) + 1);
      for (const f of after.findings) {
        expect(left.get(key(f)) ?? 0, key(f)).toBeGreaterThan(0);
        left.set(key(f), left.get(key(f))! - 1);
      }
      expect(after.findings.map((f) => `${key(f)}:${f.column}`)).toEqual([
        'AGENTS.md:3 path-missing src/settings/defaults.ts:66',
        'AGENTS.md:5 command-missing npm run tset:42',
        'AGENTS.md:5 command-missing npm run dov:88',
      ]);
      const again = await addFixes(after, worktreeTree(copy));
      expect(verifiedFixes(again)).toEqual([]);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });
});

describe('addFixes: no base', () => {
  let dir: string;
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('finds a committed move in git history, and leaves renamed names it cannot know alone', async () => {
    ({ dir } = await baseRepo());
    await headChange(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'head');
    const r = await addFixes(await lintRepo({ dir }), worktreeTree(dir));
    expect(fixOf(r, 'AGENTS.md:3 path-missing src/settings/defaults.ts')?.description).toBe('Rename to `src/config/defaults.ts` (moved in git history)');
    // `lint:docs` → `docs:lint` is a rename only a base shows; the names are far apart.
    expect(fixOf(r, 'AGENTS.md:4 command-missing npm run lint:docs')).toBeUndefined();
    expect(fixOf(r, 'AGENTS.md:6 cli-flag-unknown mytool --quiet')).toBeUndefined();
    expect(fixOf(r, 'AGENTS.md:5 command-missing npm run buld')?.verified).toBe(true);
  });

  it('works on an archive extraction (a plain folder with a file list), as the App and the hosted check lint', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'staleproof-fixes-plain-'));
    try {
      await cp(FIX_APP, plain, { recursive: true });
      const paths = await workingFiles(plain);
      const tree: LintTree = { dir: plain, paths, label: 'archive', temporary: false, dispose: async () => {} };
      const r = await addFixes(await lintRepo({ dir: plain, paths, repo: 'acme/fix-app', sha: 'a'.repeat(40) }), tree);
      expect(fixOf(r, 'AGENTS.md:5 command-missing npm run buld')).toMatchObject({ verified: true });
      expect(fixOf(r, 'docs/usage.md:5 symbol-missing Client.qeury')).toMatchObject({ verified: true });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe('addFixes: rename detection without git (two archive folders)', () => {
  it('pairs a moved file by content and a renamed script by its line', async () => {
    const base = await mkdtemp(join(tmpdir(), 'staleproof-fixes-a-'));
    const head = await mkdtemp(join(tmpdir(), 'staleproof-fixes-b-'));
    try {
      await cp(FIX_APP, base, { recursive: true });
      await cp(FIX_APP, head, { recursive: true });
      await edit(head, 'package.json', (t) => t.replace('"lint:docs"', '"docs:lint"'));
      await cp(join(head, 'docs', 'old-guide.md'), join(head, 'docs', 'guide.md'));
      await rm(join(head, 'docs', 'old-guide.md'));
      const tree = async (dir: string): Promise<LintTree> => ({ dir, paths: await workingFiles(dir), label: dir, temporary: false, dispose: async () => {} });
      const headTree = await tree(head);
      const r = await addFixes(await lintRepo({ dir: head, paths: headTree.paths, repo: 'acme/fix-app' }), headTree, { baseTree: await tree(base) });
      expect(fixOf(r, 'AGENTS.md:4 command-missing npm run lint:docs')).toMatchObject({ edits: [{ newText: 'docs:lint' }], verified: true });
      expect(fixOf(r, 'docs/usage.md:3 link-broken docs/old-guide.md')).toMatchObject({ edits: [{ newText: 'guide.md' }], verified: true });
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(head, { recursive: true, force: true });
    }
  });
});

describe('addFixes: options', () => {
  let dir: string;
  let result: LintResult;
  beforeAll(async () => {
    ({ dir } = await baseRepo());
    result = await lintRepo({ dir });
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('limits fixes to the given rules or findings, and attaches unverified hints when asked not to verify', async () => {
    const only = await addFixes(result, worktreeTree(dir), { rules: ['symbol-missing'] });
    expect(only.findings.filter((f) => f.fix).map((f) => f.rule)).toEqual(['symbol-missing']);
    const picked = await addFixes(result, worktreeTree(dir), { only: (f) => f.path === 'README.md' });
    expect(picked.findings.filter((f) => f.fix).map(key)).toEqual(['README.md:3 env-unused REDIS_HSOT']);
    const hints = await addFixes(result, worktreeTree(dir), { verify: false, rules: ['anchor-missing'] });
    expect(hints.findings.find((f) => f.fix)?.fix).toMatchObject({ verified: false, edits: [{ newText: 'install' }] });
  });

  it('past its deadline (the hooks), starts nothing and returns the result as it is', async () => {
    expect(await addFixes(result, worktreeTree(dir), { deadline: Date.now() - 1 })).toBe(result);
  });

  it('returns the result unchanged when nothing is fixable, and leaves findings that already carry a fix', async () => {
    const none = { ...result, findings: result.findings.filter((f) => f.rule === 'env-undocumented') };
    expect(await addFixes(none, worktreeTree(dir))).toBe(none);
    const given = { ...result, findings: result.findings.map((f) => (f.rule === 'symbol-missing' ? { ...f, fix: { description: 'mine', edits: [], verified: false } } : f)) };
    const r = await addFixes(given, worktreeTree(dir), { rules: ['symbol-missing'] });
    expect(r.findings.find((f) => f.rule === 'symbol-missing')?.fix?.description).toBe('mine');
  });
});

describe('addFixes: examples, links, anchors, subcommands and parameters', () => {
  let dir: string;
  let baseTree: LintTree;
  let fixed: LintResult;
  beforeAll(async () => {
    const repo = await moreRepo();
    dir = repo.dir;
    await moreChange(dir);
    baseTree = await refTree(dir, repo.base);
    fixed = await addFixes(await lintRepo({ dir }), worktreeTree(dir), { baseTree });
  });
  afterAll(async () => {
    await baseTree?.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('renames a heading anchor, a subcommand and a documented parameter renamed in the change', () => {
    expect(fixOf(fixed, 'docs/nested/page.md:3 anchor-missing docs/api.md#connecting')).toMatchObject({
      description: 'Rename to `#connections` (heading renamed in this change)',
      edits: [{ newText: 'connections' }],
      verified: true,
    });
    expect(fixOf(fixed, 'docs/nested/page.md:5 cli-command-unknown tool2 sync')).toMatchObject({ edits: [{ column: 12, endColumn: 16, newText: 'pull' }], verified: true });
    expect(fixOf(fixed, 'docs/nested/page.md:5 cli-command-unknown tool2 statsu')).toMatchObject({ description: 'Rename to `status` (the closest command of `tool2`)', verified: true });
    expect(fixOf(fixed, 'mypkg/tools.py:6 docstring-param-unknown connect(retries)')).toMatchObject({
      description: 'Rename to `attempts` (renamed in the signature of `connect`)',
      edits: [{ path: 'mypkg/tools.py', line: 6, column: 9, endColumn: 16, newText: 'attempts' }],
      verified: true,
    });
  });

  it('fixes an example method call and an aliased import, and refuses an import its example still uses', () => {
    expect(fixOf(fixed, 'docs/api.md:17 example-missing-attribute clsoe')).toMatchObject({ edits: [{ line: 17, column: 3, endColumn: 8, newText: 'close' }], verified: true });
    expect(fixOf(fixed, 'docs/api.md:21 example-missing-import pong')).toMatchObject({ edits: [{ line: 21, column: 25, endColumn: 29, newText: 'ping' }], verified: true });
    // `conect` is called below the import: renaming the import alone would break the example.
    expect(fixOf(fixed, 'docs/api.md:8 example-missing-import conect')).toBeUndefined();
  });

  it('points a root-relative link from a nested page at the file, relative to the page', () => {
    expect(fixOf(fixed, 'docs/nested/page.md:3 link-broken docs/nested/docs/api.md')).toMatchObject({
      description: 'Rename to `../api.md` (the file at the repository root, relative to this page)',
      edits: [{ column: 15, endColumn: 26, newText: '../api.md' }],
      verified: true,
    });
  });
});

describe('addFixes: history is left as it was', () => {
  it('never rewrites a migration guide or a line saying the name was renamed', async () => {
    const { dir } = await baseRepo();
    try {
      await put(dir, {
        'docs/migration.md': '# Migrating to 2.0\n\nUse `npm run buld` no more.\n',
        'docs/notes.md': '# Notes\n\nThe [install steps](setup.md#instal) were renamed.\n\nRun `npm run buld` now, after [installing](setup.md#instal).\n',
      });
      const rules = ['command-missing', 'anchor-missing'] as const;
      const r = await addFixes(await lintRepo({ dir, rules: [...rules] }), worktreeTree(dir), { rules: [...rules] });
      expect(r.findings.filter((f) => f.path.startsWith('docs/') && f.path !== 'docs/usage.md').map((f) => `${f.path}:${f.line} ${f.rule} ${f.fix?.verified ?? 'none'}`)).toEqual([
        'docs/migration.md:3 command-missing none',
        'docs/notes.md:3 anchor-missing none',
        'docs/notes.md:5 command-missing true',
        'docs/notes.md:5 anchor-missing true',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('addFixes: how a fix is written', () => {
  it('writes a moved path the shortest way that still resolves from the page', async () => {
    const { dir } = await baseRepo();
    try {
      await put(dir, {
        'helpers/README.md': '# Helpers\n',
        'tools/scripts/helpers/frobnicate.py': 'def run():\n    return 1\n',
        'tools/AGENTS.md': '# Tools\n\nThe entry point is `helpers/frobnicate.py`.\n',
      });
      const r = await addFixes(await lintRepo({ dir, rules: ['path-missing'] }), worktreeTree(dir), { rules: ['path-missing'] });
      expect(fixOf(r, 'tools/AGENTS.md:3 path-missing helpers/frobnicate.py')).toMatchObject({
        description: 'Rename to `scripts/helpers/frobnicate.py` (the only file of that name)',
        edits: [{ newText: 'scripts/helpers/frobnicate.py' }],
        verified: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to rename a documented parameter onto an options object', async () => {
    const { dir } = await baseRepo();
    try {
      await put(dir, {
        'waitlib/package.json': JSON.stringify({ name: 'waitlib', version: '1.0.0', main: 'index.ts', types: 'index.ts' }),
        'waitlib/index.ts':
          '/**\n * Wait a while.\n * @param ms - How long.\n * @param signal - Cancels the wait.\n */\nexport async function wait(ms: number, options?: { abortSignal?: AbortSignal }): Promise<void> {\n  void ms;\n  void options;\n}\n\n/**\n * Make a thing.\n * @param makeIt - Builds it.\n */\nexport function lazy(build: () => number): number {\n  return build();\n}\n',
      });
      git(dir, 'add', '-A'); // the code reader reads tracked files
      const r = await addFixes(await lintRepo({ dir, rules: ['docstring-param-unknown'] }), worktreeTree(dir), { rules: ['docstring-param-unknown'] });
      const by = Object.fromEntries(r.findings.map((f) => [f.subject, f.fix?.edits.map((e) => e.newText) ?? null]));
      expect(by).toEqual({ 'Client.query(timeout_ms)': ['timeout'], 'wait(signal)': null, 'lazy(makeIt)': ['build'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
