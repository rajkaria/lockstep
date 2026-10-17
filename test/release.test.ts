import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Arity } from '../src/indexer/signature.js';
import {
  breakingReasons,
  changelogHeadings,
  dunderAll,
  mentionIn,
  parseFailOn,
  previousTag,
  releaseMarkdown,
  releaseReport,
  releaseSection,
  releaseText,
  runReleaseCommand,
  tagVersion,
  type ReleaseReport,
} from '../src/release.js';

/**
 * A library with two tagged releases, built as a git repository in a temporary folder at
 * test time (no nested .git is committed). v2.0.0 removes `Client.close`, renames
 * `connect`'s `retries` to `attempts`, adds an optional parameter to `Client.query`, and
 * drops `helper`, which `client.py`'s `__all__` never exported. Its changelog names only
 * the removal of `Client.close`; the guide still calls both changed things.
 */
const V1: Record<string, string> = {
  'pyproject.toml': '[project]\nname = "minipkg"\nversion = "1.0.0"\n',
  'minipkg/__init__.py': 'from .client import *\n',
  'minipkg/client.py': [
    '__all__ = ["Client", "connect"]',
    '',
    '',
    'class Client:',
    '    def __init__(self, url, timeout=10):',
    '        self.url = url',
    '',
    '    def query(self, q):',
    '        return q',
    '',
    '    def close(self):',
    '        pass',
    '',
    '',
    'def connect(url, *, retries=3):',
    '    return Client(url)',
    '',
    '',
    'def helper():',
    '    return 1',
    '',
  ].join('\n'),
  'minipkg/_internal.py': 'def secret():\n    return 2\n',
  'docs/guide.md': [
    '# Guide',
    '',
    '```python',
    'from minipkg import Client, connect',
    '',
    'client = connect("redis://localhost", retries=5)',
    'client.query("MATCH (n) RETURN n")',
    'client.close()',
    '```',
    '',
  ].join('\n'),
  'CHANGELOG.md': '# Changelog\n\n## 1.0.0 - 2026-09-01\n\n- First release.\n',
};

const V2: Record<string, string | null> = {
  'minipkg/client.py': [
    '__all__ = ["Client", "connect"]',
    '',
    '',
    'class Client:',
    '    def __init__(self, url, timeout=10):',
    '        self.url = url',
    '',
    '    def query(self, q, params=None):',
    '        return q',
    '',
    '',
    'def connect(url, *, attempts=3):',
    '    return Client(url)',
    '',
  ].join('\n'),
  'minipkg/_internal.py': null,
  'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n## 2.0.0 - 2026-10-01\n\n- Removed `Client.close`: clients close themselves.\n\n## 1.0.0 - 2026-09-01\n\n- First release.\n',
};

let dir: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
  });
}

function write(files: Record<string, string | null>): void {
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    if (text === null) git('rm', '-q', path);
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }
  git('add', '-A');
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'staleproof-release-'));
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://github.com/acme/minipkg.git');
  write(V1);
  git('commit', '-q', '-m', 'v1');
  git('tag', 'v1.0.0');
  write(V2);
  git('commit', '-q', '-m', 'v2');
  git('tag', 'v2.0.0');
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

describe('release gate on a repository with two tags', () => {
  let r: ReleaseReport;
  beforeAll(async () => {
    r = await releaseReport({ dir });
  });

  it('compares HEAD with the tag before the one HEAD carries', () => {
    expect(r.repo).toBe('acme/minipkg');
    expect(r.from).toMatchObject({ ref: 'v1.0.0', why: 'the latest tag reachable from HEAD' });
    expect(r.to.ref).toBe('HEAD');
    expect(r.from.sha).not.toBe(r.to.sha);
  });

  it('finds the breaking public API changes only, and which the changelog names', () => {
    expect(r.breaking.map((b) => ({ symbol: b.symbol, change: b.change, reasons: b.reasons, mentioned: b.mentioned, as: b.mentionedAs }))).toEqual([
      { symbol: 'minipkg.client.Client.close', change: 'removed', reasons: ['removed'], mentioned: true, as: 'Client.close' },
      { symbol: 'minipkg.client.connect', change: 'signature', reasons: ['parameter `retries` renamed to `attempts`'], mentioned: false, as: undefined },
    ]);
    // helper (not in __all__) and _internal.secret were never public; query's new optional parameter breaks nobody.
    expect(r.compatible).toBe(1);
    expect(r.undocumented).toBe(1);
    expect(r.changelog).toEqual({ path: 'CHANGELOG.md', source: 'commit', section: { heading: '2.0.0 - 2026-10-01', line: 5, kind: 'version' } });
  });

  it('lists the docs that still rely on what changed', () => {
    expect(r.staleDocs.map((s) => `${s.finding.path}:${s.finding.line} ${s.finding.rule} → ${s.symbol}`)).toEqual([
      'docs/guide.md:6 example-unknown-keyword → minipkg.client.connect',
      'docs/guide.md:8 example-missing-attribute → minipkg.client.Client.close',
    ]);
    expect(r.lint.newSinceFrom).toHaveLength(2);
  });

  it('fails the gates that are set, and says why in one sentence', () => {
    expect(r.failOn).toEqual(['undocumented-breaking', 'stale-docs']);
    expect(r.failed).toEqual(['undocumented-breaking', 'stale-docs']);
    const text = releaseText(r);
    expect(text).toContain('Release acme/minipkg: v1.0.0 (');
    expect(text).toContain('Changelog: CHANGELOG.md, the section for this version "2.0.0 - 2026-10-01" (line 5)');
    expect(text).toContain('  ✗ minipkg.client.connect: parameter `retries` renamed to `attempts`  (not in the changelog)');
    expect(text).toContain('  ✓ minipkg.client.Client.close: removed  (changelog: "Client.close")');
    expect(text.split('\n').at(-1)).toBe(
      'Release gate (--fail-on undocumented-breaking,stale-docs): fails: 1 breaking change is not in the changelog; 2 docs references still rely on what changed.',
    );
    const md = releaseMarkdown(r);
    expect(md.startsWith('<!-- staleproof-release -->\n### Staleproof release gate: acme/minipkg v1.0.0')).toBe(true);
    expect(md).toContain('| `minipkg.client.connect` | parameter `retries` renamed to `attempts` | **no** |');
    expect(md.split('\n').at(-1)).toBe('<!-- staleproof:release breaking=2 undocumented=1 stale=2 findings=2 new-errors=0 failed=2 -->');
  });

  it('exits 1 when a gate fails, 0 with --fail-on never, 2 on a usage error', async () => {
    const logs: string[] = [];
    expect((await runReleaseCommand({ dir, log: (m) => logs.push(m) })).exitCode).toBe(1);
    const never = await runReleaseCommand({ dir, failOn: 'never', format: 'json' });
    expect(never.exitCode).toBe(0);
    expect(JSON.parse(never.output)).toMatchObject({ version: 1, failed: [], undocumented: 1 });
    expect((await runReleaseCommand({ dir, failOn: 'stale-docs', from: 'v2.0.0' })).exitCode).toBe(0);
    expect((await runReleaseCommand({ dir, format: 'yaml', log: (m) => logs.push(m) })).exitCode).toBe(2);
    expect(logs.at(-1)).toBe('staleproof release: unknown --format yaml (text, markdown, json)');
    expect((await runReleaseCommand({ dir, failOn: 'sometimes', log: (m) => logs.push(m) })).exitCode).toBe(2);
    expect((await runReleaseCommand({ dir, from: 'v9', log: (m) => logs.push(m) })).exitCode).toBe(2);
    expect(logs.at(-1)).toContain('v9 is not a commit');
  });

  it('reads the changelog from the working tree when checking HEAD with uncommitted notes', async () => {
    writeFileSync(join(dir, 'CHANGELOG.md'), `${V2['CHANGELOG.md']!.replace('## Unreleased\n', '## Unreleased\n\n- `connect` takes `attempts` instead of `retries`.\n')}`);
    try {
      const w = await releaseReport({ dir });
      expect(w.changelog.source).toBe('working tree');
      // HEAD carries v2.0.0: its own section still wins over Unreleased.
      expect(w.changelog.section?.kind).toBe('version');
      const head = await releaseReport({ dir, to: 'v2.0.0' });
      expect(head.changelog.source).toBe('commit');
    } finally {
      git('checkout', '-q', '--', 'CHANGELOG.md');
    }
  });

  it('compares a stable release with the previous stable one, a prerelease with the tag before it', async () => {
    const tags = await mkdtemp(join(tmpdir(), 'staleproof-release-tags-'));
    try {
      const g = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: tags, encoding: 'utf8' }).trim();
      g('init', '-q');
      const sha: string[] = [];
      for (const [i, tag] of ['v1.0.0', 'v2.0.0-rc.1', 'v2.0.0'].entries()) {
        g('commit', '-q', '--allow-empty', '-m', `c${i}`);
        g('tag', tag);
        sha.push(g('rev-parse', 'HEAD'));
      }
      expect(await previousTag(tags, sha[2]!, '2.0.0')).toEqual({ tag: 'v1.0.0', sha: sha[0] });
      expect(await previousTag(tags, sha[2]!, '2.0.1-rc.1')).toEqual({ tag: 'v2.0.0-rc.1', sha: sha[1] });
      expect(await previousTag(tags, sha[0]!, '1.0.0')).toBeUndefined();
    } finally {
      await rm(tags, { recursive: true, force: true });
    }
  });

  it('needs a tag or --from', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'staleproof-release-bare-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: bare });
      writeFileSync(join(bare, 'a.md'), '# A\n');
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: bare });
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one'], { cwd: bare });
      await expect(releaseReport({ dir: bare })).rejects.toThrow('no tag is reachable from HEAD (other than one on that commit): pass --from <ref>');
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

const arity = (params: [string, 'pos-only' | 'pos' | 'kw-only', boolean][], varArgs = false, varKw = false): Arity => ({
  params: params.map(([name, kind, required]) => ({ name, kind, required })),
  varArgs,
  varKw,
});

describe('breaking signature changes', () => {
  it('Python: removed, renamed, keyword-only, required, reordered, *args and **kwargs', () => {
    const a = arity([['url', 'pos', true], ['timeout', 'pos', false]]);
    expect(breakingReasons(a, arity([['url', 'pos', true], ['timeout', 'pos', false], ['tls', 'pos', false]]), 'python')).toEqual([]);
    expect(breakingReasons(a, arity([['url', 'pos', true]]), 'python')).toEqual(['takes at most 1 positional argument (was 2)', '`timeout` is no longer a parameter']);
    expect(breakingReasons(a, arity([['url', 'pos', true]], false, true), 'python')).toEqual(['takes at most 1 positional argument (was 2)']);
    expect(breakingReasons(a, arity([['url', 'pos', true], ['deadline', 'pos', false]]), 'python')).toEqual(['parameter `timeout` renamed to `deadline`']);
    expect(breakingReasons(a, arity([['url', 'pos', true], ['timeout', 'kw-only', false]]), 'python')).toEqual(['takes at most 1 positional argument (was 2)', '`timeout` is keyword-only now']);
    expect(breakingReasons(a, arity([['url', 'pos-only', true], ['timeout', 'pos', false]]), 'python')).toEqual(['`url` can no longer be passed by keyword']);
    expect(breakingReasons(a, arity([['url', 'pos', true], ['timeout', 'pos', true]]), 'python')).toEqual(['`timeout` is required now']);
    expect(breakingReasons(a, arity([['url', 'pos', true], ['timeout', 'pos', false], ['key', 'kw-only', true]]), 'python')).toEqual(['new required parameter `key`']);
    expect(breakingReasons(a, arity([['timeout', 'pos', false], ['url', 'pos', true]]), 'python')).toEqual(['positional order changed: `timeout` now comes before `url`']);
    expect(breakingReasons(arity([], true, true), arity([]), 'python')).toEqual(['no longer takes *args', 'no longer takes **kwargs']);
  });

  it('JavaScript/TypeScript and Go: by position only', () => {
    const a = arity([['url', 'pos', true], ['opts', 'pos', false]]);
    expect(breakingReasons(a, arity([['endpoint', 'pos', true], ['options', 'pos', false]]), 'ts')).toEqual([]);
    expect(breakingReasons(a, arity([['url', 'pos', true]]), 'ts')).toEqual(['takes at most 1 argument (was 2)']);
    expect(breakingReasons(a, arity([['url', 'pos', true], ['opts', 'pos', true]]), 'go')).toEqual(['requires 2 arguments (was 1)']);
    expect(breakingReasons(arity([['xs', 'pos', false]], true), arity([['xs', 'pos', false]]), 'ts')).toEqual(['no longer takes rest arguments']);
  });
});

describe('changelogs', () => {
  const KEEP = '# Changelog\n\n## [Unreleased]\n\n### Removed\n- `Client.close`\n\n## [1.2.0] - 2026-09-01\n\n- Things.\n\n## [1.1.0] - 2026-08-01\n';

  it('picks the release version, else a non-empty Unreleased, else the top section unless it is the previous release', () => {
    expect(releaseSection(KEEP, { version: '1.2.0' }).section).toEqual({ heading: '[1.2.0] - 2026-09-01', line: 8, kind: 'version' });
    const un = releaseSection(KEEP);
    expect(un.section).toEqual({ heading: '[Unreleased]', line: 3, kind: 'unreleased' });
    expect(un.body).toContain('`Client.close`');
    expect(un.body).not.toContain('Things');
    const empty = '# Changelog\n\n## Unreleased\n\n## 2.0.0\n\n- New.\n\n## 1.0.0\n- Old.\n';
    expect(releaseSection(empty, { previousVersion: '1.0.0' }).section).toEqual({ heading: '2.0.0', line: 5, kind: 'top' });
    expect(releaseSection('# Changelog\n\n## 1.0.0\n- Old.\n', { previousVersion: '1.0.0' })).toEqual({
      body: '',
      why: 'its top section is 1.0.0, the previous release: this release has no section yet',
    });
    // An old section marked unreleased further down is history, not this release.
    const old = '# Changes\n\n## 0.4.0 — 2026-10-17\n\n- Lint.\n\n## 0.1.0 — unreleased\n\n- Start.\n';
    expect(releaseSection(old, { previousVersion: '0.3.0' }).section?.heading).toBe('0.4.0 — 2026-10-17');
    expect(releaseSection('Just text.').why).toBe('it has no Unreleased or version heading');
  });

  it('reads setext Markdown and reStructuredText headings, never inside code fences', () => {
    expect(changelogHeadings('Changes\n=======\n\n2.0.0\n-----\n- x\n\n```\n## not a heading\n```\n')).toEqual([
      { level: 1, text: 'Changes', line: 1 },
      { level: 2, text: '2.0.0', line: 4 },
    ]);
    const rst = 'Version 3.1.0\n-------------\n\nReleased 2024-11-13\n\n-   ``Flask.open_resource`` takes ``encoding``.\n\n\nVersion 3.0.3\n-------------\n\n-   Old.\n';
    const s = releaseSection(rst, { rst: true, version: '3.1.0' });
    expect(s.section).toEqual({ heading: 'Version 3.1.0', line: 1, kind: 'version' });
    expect(s.body).toContain('encoding');
    expect(s.body).not.toContain('Old.');
  });

  it('counts a change as documented when the section names it or every parameter it changed', () => {
    const c = { qualname: 'pkg._api.get', symbol: 'pkg._api.get', name: 'get', params: ['proxies', 'cert'] };
    expect(mentionIn('* The deprecated `proxies` argument has been removed.\n* The `cert` argument is deprecated.', c)).toBe('`proxies`, `cert`');
    expect(mentionIn('* The deprecated `proxies` argument has been removed.', c)).toBeUndefined();
    expect(mentionIn('Removed the proxies argument and cert= from the API.', c)).toBe('`proxies`, `cert`');
    expect(mentionIn('`get()` lost two arguments.', c)).toBe('get');
    expect(mentionIn('Nothing about it; a target is not get_all.', { ...c, params: [] })).toBeUndefined();
    expect(mentionIn('`Client()` takes `url` first.', { qualname: 'pkg.Client.__init__', symbol: 'pkg.Client.__init__', name: '__init__' })).toBe('Client');
  });

  it('reads tags, __all__ and --fail-on', () => {
    expect(tagVersion('v0.4.0')).toBe('0.4.0');
    expect(tagVersion('release/2.1')).toBe('2.1');
    expect(tagVersion('v1')).toBeUndefined();
    expect(dunderAll('__all__ = [\n    "Client",\n    \'connect\',\n]\n__all__ += ("extra",)\n')).toEqual(['Client', 'connect', 'extra']);
    expect(dunderAll('x = 1\n')).toBeUndefined();
    expect(parseFailOn(undefined)).toEqual(['undocumented-breaking', 'stale-docs']);
    expect(parseFailOn('never')).toEqual([]);
    expect(parseFailOn('stale-docs')).toEqual(['stale-docs']);
    expect(() => parseFailOn('all')).toThrow('--fail-on takes undocumented-breaking, stale-docs (comma-separated) or never; got all');
  });
});
