import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffRange, parseHunks, parseNameStatus } from '../src/pr/changes.js';
import { parsePrUrl } from '../src/pr/github.js';
import { FIXTURES } from './helpers.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

async function edit(file: string, fn: (s: string) => string) {
  await writeFile(file, fn(await readFile(file, 'utf8')));
}

describe('diffRange', () => {
  let dir: string;
  let before: string;
  let after: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lockstep-diff-'));
    await cp(join(FIXTURES, 'org', 'mini-client'), dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    before = git(dir, 'rev-parse', 'HEAD');
    const graph = join(dir, 'miniclient', 'graph.py');
    await edit(graph, (s) =>
      s
        .replace('def ro_query(self, q: str):', 'def read_query(self, q: str):')
        .replace('        return self._send("QUERY", q)\n', '        q = q.strip()\n        return self._send("QUERY", q)\n')
        .replace('def delete(self):', 'def delete(self, force: bool = False):')
        .concat('\n    def copy(self, name):\n        return Graph(self.client, name)\n'),
    );
    await edit(join(dir, 'miniclient', 'client.py'), (s) => s.replace(/\n    def list_graphs\(self\):\n        return \[\]\n/, '\n'));
    await edit(join(dir, 'miniclient', '__init__.py'), (s) => s.replace('from .graph import Graph as Graph\n', ''));
    await writeFile(join(dir, 'README.md'), '# miniclient\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'change');
    after = git(dir, 'rev-parse', 'HEAD');
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('classifies every symbol-level change', async () => {
    const d = await diffRange(dir, 'acme/mini-client', before, after);
    expect(d.symbols.map((s) => `${s.change} ${s.qualname}${s.renamedTo ? ` -> ${s.renamedTo}` : ''}${s.exportTarget ? ` (${s.exportTarget})` : ''}`)).toEqual([
      'export-removed miniclient.Graph (miniclient.graph.Graph)',
      'removed miniclient.client.Client.list_graphs',
      'added miniclient.graph.Graph.copy',
      'signature miniclient.graph.Graph.delete',
      'modified miniclient.graph.Graph.query',
      'renamed miniclient.graph.Graph.ro_query -> miniclient.graph.Graph.read_query',
    ]);
    const sig = d.symbols.find((s) => s.change === 'signature')!;
    expect(sig.before).toBe('def delete(self)');
    expect(sig.after).toBe('def delete(self, force: bool = False)');
    expect(d.docsTouched).toEqual(['README.md']);
  });
});

describe('diff parsing', () => {
  it('parses name-status with renames and hunks with zero-length sides', () => {
    expect(parseNameStatus('M\0a.py\0R087\0old.py\0new.py\0A\0b.md\0')).toEqual([
      { status: 'M', path: 'a.py' },
      { status: 'R087', path: 'new.py', oldPath: 'old.py' },
      { status: 'A', path: 'b.md' },
    ]);
    expect(parseHunks('@@ -3,0 +4,2 @@\n@@ -10 +12 @@\n@@ -20,3 +23,0 @@')).toEqual({
      old: [[3, 3], [10, 10], [20, 22]],
      new: [[4, 5], [12, 12], [23, 23]],
    });
  });

  it('parses PR URLs', () => {
    expect(parsePrUrl('https://github.com/FalkorDB/falkordb-py/pull/262/files')).toMatchObject({ fullName: 'FalkorDB/falkordb-py', number: 262 });
    expect(parsePrUrl('FalkorDB/docs#569').url).toBe('https://github.com/FalkorDB/docs/pull/569');
    expect(() => parsePrUrl('https://github.com/FalkorDB/docs/issues/1')).toThrow(/not a GitHub pull request/);
  });
});

describe('githubSource (serverless ingestion)', () => {
  it('produces the same symbol diff as a local clone, from GitHub API-shaped responses', async () => {
    const { mkdtemp, cp, readFile, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { diffWith, diffRange, parseNameStatus } = await import('../src/pr/changes.js');
    const { githubSource } = await import('../src/pr/github-diff.js');
    const dir = await mkdtemp(join(tmpdir(), 'lockstep-gh-'));
    try {
      await cp(join(FIXTURES, 'org', 'mini-client'), dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'base');
      const before = git(dir, 'rev-parse', 'HEAD');
      const file = join(dir, 'miniclient', 'graph.py');
      // Change one method; its neighbours fall inside the 3 lines of context GitHub sends.
      await writeFile(file, (await readFile(file, 'utf8')).replace('return self.query(q)', 'return self.query(q.strip())'));
      git(dir, 'mv', 'miniclient/client.py', 'miniclient/connection.py');
      git(dir, 'commit', '-q', '-am', 'change');
      const after = git(dir, 'rev-parse', 'HEAD');
      const STATUS: Record<string, string> = { A: 'added', D: 'removed', M: 'modified', R: 'renamed' };
      const fetchImpl = (async (url: string) => {
        const u = new URL(url);
        if (u.hostname === 'raw.githubusercontent.com') {
          const [, , , sha, ...path] = u.pathname.split('/');
          try {
            return new Response(git(dir, 'show', `${sha}:${decodeURIComponent(path.join('/'))}`) + '\n');
          } catch {
            return new Response('', { status: 404 });
          }
        }
        if (u.pathname.includes('/compare/')) {
          const files = parseNameStatus(git(dir, 'diff', '--name-status', '-M', '-z', before, after) + '\0').map((f) => ({
            filename: f.path,
            status: STATUS[f.status[0]!],
            ...(f.oldPath ? { previous_filename: f.oldPath } : {}),
            patch: git(dir, 'diff', '-U3', before, after, '--', f.oldPath ?? f.path, f.path).split('\n').filter((l) => !/^(diff|index|---|\+\+\+|similarity|rename)/.test(l)).join('\n'),
          }));
          return new Response(JSON.stringify({ files }));
        }
        if (u.pathname.includes('/git/trees/')) {
          const sha = u.pathname.split('/').pop()!;
          return new Response(JSON.stringify({ truncated: false, tree: git(dir, 'ls-tree', '-r', '--name-only', sha).split('\n').map((path) => ({ path, type: 'blob' })) }));
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch;
      const viaApi = await diffWith(githubSource('acme/mini-client', { fetchImpl }), 'acme/mini-client', before, after);
      const viaGit = await diffRange(dir, 'acme/mini-client', before, after);
      expect(viaApi.symbols).toEqual(viaGit.symbols);
      expect(viaApi.symbols.filter((s) => s.qualname.startsWith('miniclient.graph')).map((s) => `${s.change} ${s.qualname}`)).toEqual([
        'modified miniclient.graph.Graph.ro_query',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
