import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GraphStore } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import { FIXTURE_REPOS, STALE_DOCS } from './helpers.js';

/** `staleproof release` and `staleproof digest` through src/cli.ts. */
const ROOT = join(import.meta.dirname, '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const cli = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(TSX, [join(ROOT, 'src', 'cli.ts'), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 300_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
/** The same without blocking the event loop, so a webhook server in this process can answer. */
const cliAsync = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn(TSX, [join(ROOT, 'src', 'cli.ts'), ...args], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });

describe('staleproof release', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'staleproof-sp8-cli-'));
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd: dir });
    const write = (files: Record<string, string>) => {
      for (const [p, t] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), t);
      }
      git('add', '-A');
    };
    git('init', '-q');
    write({ 'pkg/__init__.py': 'def connect(url, *, retries=3):\n    return url\n', 'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- First.\n' });
    git('commit', '-q', '-m', 'one');
    git('tag', 'v1.0.0');
    write({ 'pkg/__init__.py': 'def connect(url, *, attempts=3):\n    return url\n', 'CHANGELOG.md': '# Changelog\n\n## 2.0.0\n\n- Faster.\n\n## 1.0.0\n\n- First.\n' });
    git('commit', '-q', '-m', 'two');
    git('tag', 'v2.0.0');
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('reports and exits 1 when a gate fails, 0 with --fail-on never, 2 on a usage error', () => {
    const r = cli(['release', dir, '--repo', 'acme/pkg']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ pkg.connect: parameter `retries` renamed to `attempts`  (not in the changelog)');
    const json = cli(['release', dir, '--format', 'json', '--fail-on', 'never']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ version: 1, from: { ref: 'v1.0.0' }, undocumented: 1 });
    const bad = cli(['release', dir, '--format', 'yaml']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('unknown --format yaml');
  });
});

describe('staleproof digest', () => {
  const graph = `test-sp8-digest-cli-${process.pid}${Math.random().toString(36).slice(2, 6)}`;
  let store: GraphStore;
  beforeAll(async () => {
    store = await GraphStore.connect(inject('falkordbUrl'));
    await indexOrg(store.org(graph), [...FIXTURE_REPOS, STALE_DOCS]);
  });
  afterAll(async () => {
    await store.org(graph).drop();
    await store.close();
  });

  it('posts to the webhook from STALEPROOF_DIGEST_WEBHOOK and never prints it', async () => {
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        bodies.push(JSON.parse(data));
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/SECRET`;
    try {
      const r = await cliAsync(['--db', inject('falkordbUrl'), '--org', graph, 'digest', 'acme/stale-docs'], { STALEPROOF_DIGEST_WEBHOOK: url });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^Docs health for acme\/stale-docs: \d+\/100/);
      expect(`${r.out}${r.err}`).not.toContain('SECRET');
      expect(bodies).toEqual([expect.objectContaining({ type: 'staleproof.digest', scope: 'acme/stale-docs' })]);
    } finally {
      server.close();
    }
  });
});
