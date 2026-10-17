import { chmod, cp, mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRepo } from '../src/indexer/index.js';
import { extractPython } from '../src/indexer/python.js';
import { extractTs } from '../src/indexer/typescript.js';
import { CACHE_DIR, cacheLocation, codeStamp, loadHistoryCached, ParseCache } from '../src/lint/cache.js';
import { lintRepo, workingFiles } from '../src/lint/engine.js';
import { RepoFacts } from '../src/lint/facts.js';
import { FIXTURES, gitIn } from './helpers.js';

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-cache-'));
  await cp(join(FIXTURES, 'hooks', 'repo'), dir, { recursive: true });
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const brief = (r: Awaited<ReturnType<typeof lintRepo>>) => r.findings.map((f) => `${f.path}:${f.line}:${f.column} ${f.rule} ${f.fingerprint}`);

describe('local parse cache', () => {
  const saved = { dir: process.env.STALEPROOF_CACHE_DIR, on: process.env.STALEPROOF_CACHE };
  beforeEach(() => {
    delete process.env.STALEPROOF_CACHE_DIR;
    delete process.env.STALEPROOF_CACHE;
  });
  afterEach(() => {
    if (saved.dir === undefined) delete process.env.STALEPROOF_CACHE_DIR;
    else process.env.STALEPROOF_CACHE_DIR = saved.dir;
    if (saved.on === undefined) delete process.env.STALEPROOF_CACHE;
    else process.env.STALEPROOF_CACHE = saved.on;
  });

  it('parses a file once per content, and hands out a fresh copy on every hit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'staleproof-cache-unit-'));
    const cache = await ParseCache.open(dir);
    const src = 'def connect(host, timeout=10):\n    return host\n';
    const opts = { module: 'demo.client', path: 'demo/client.py' };
    let runs = 0;
    const run = (o: typeof opts) => (runs++, extractPython(src, o));
    const a = await cache.extract('python', src, opts, run);
    a.defs.length = 0; // a caller that changes what it got must not change the cache
    const b = await cache.extract('python', src, opts, run);
    expect(runs).toBe(1);
    expect(b.defs.map((d) => d.qualname)).toEqual(['demo.client', 'demo.client.connect']);
    await cache.extract('python', `${src}\n`, opts, run);
    await cache.extract('python', src, { ...opts, module: 'other' }, run);
    expect(runs).toBe(3);
    expect(cache.stats).toMatchObject({ hits: 1, misses: 3 });
  });

  it('re-parses TypeScript when a relative import resolves elsewhere', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'staleproof-cache-ts-'));
    const cache = await ParseCache.open(dir);
    const src = "import { x } from './util';\nexport function f() { return x(); }\n";
    let target = 'pkg.util';
    const opts = () => ({ module: 'pkg.index', path: 'src/index.ts', resolve: (spec: string) => (spec === './util' ? target : undefined) });
    let runs = 0;
    const run = (o: ReturnType<typeof opts>) => (runs++, extractTs(src, o));
    await cache.extract('ts', src, opts(), run);
    await cache.extract('ts', src, opts(), run);
    expect(runs).toBe(1);
    target = 'pkg.helpers.util';
    const m = await cache.extract('ts', src, opts(), run);
    expect(runs).toBe(2);
    expect(m.imports.map((i) => i.target)).toContain('pkg.helpers.util.x');
  });

  it('survives a restart; each build has its own file, and the oldest builds are pruned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'staleproof-cache-file-'));
    const src = 'def f():\n    pass\n';
    const opts = { module: 'm', path: 'm.py' };
    const first = await ParseCache.open(dir);
    await first.extract('python', src, opts, (o) => extractPython(src, o));
    await first.save();
    const loc = cacheLocation(dir);
    expect(loc).toBe(join(dir, CACHE_DIR));
    const mine = `parse-${codeStamp()}.jsonl`;
    expect((await readdir(loc)).sort()).toEqual(['.gitignore', mine]);

    const second = await ParseCache.open(dir);
    await second.extract('python', src, opts, () => Promise.reject(new Error('should be cached')));
    expect(second.stats).toMatchObject({ hits: 1, misses: 0, loaded: 1 });

    // A damaged header: parsed again, the file rewritten.
    const file = join(loc, mine);
    const lines = (await readFile(file, 'utf8')).split('\n');
    await writeFile(file, [JSON.stringify({ salt: 'something-else' }), ...lines.slice(1)].join('\n'));
    expect((await ParseCache.open(dir)).stats.loaded).toBe(0);

    // Other builds' files: the two most recent stay.
    for (const [i, salt] of ['aaaa', 'bbbb', 'cccc', 'dddd'].entries()) {
      await writeFile(join(loc, `parse-${salt}.jsonl`), '{}\n');
      await utimes(join(loc, `parse-${salt}.jsonl`), new Date(), new Date(Date.now() - (10 - i) * 60_000));
    }
    const third = await ParseCache.open(dir);
    await third.extract('python', `${src}\n`, opts, (o) => extractPython(`${src}\n`, o));
    await third.save();
    expect((await readdir(loc)).filter((n) => n.endsWith('.jsonl')).sort()).toEqual([mine, 'parse-cccc.jsonl', 'parse-dddd.jsonl'].sort());
  });

  it('records sit next to it: per build, or shared by every build (hook state)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'staleproof-cache-json-'));
    const cache = await ParseCache.open(dir);
    expect(await cache.readJson('baseline-x')).toBeUndefined();
    await cache.writeJson('baseline-x', ['a', 'b']);
    expect(await (await ParseCache.open(dir)).readJson('baseline-x')).toEqual(['a', 'b']);
    await writeFile(join(cacheLocation(dir), `baseline-x.${codeStamp().slice(0, 8)}.json`), JSON.stringify({ salt: 'other', value: ['z'] }));
    expect(await cache.readJson('baseline-x')).toBeUndefined();
    await writeFile(join(cacheLocation(dir), 'hook-session-x.json'), JSON.stringify({ salt: 'other', value: { edited: true } }));
    expect(await cache.readJson('hook-session-x', { shared: true })).toEqual({ edited: true });
  });

  it('lint gives the same findings warm as cold, without parsing again', async () => {
    const dir = await repo();
    await writeFile(join(dir, 'demo', 'client.py'), (await readFile(join(dir, 'demo', 'client.py'), 'utf8')).replace('timeout=10', 'deadline=10'));
    const cold = await ParseCache.open(dir);
    const a = await lintRepo({ dir, cache: cold });
    expect(cold.stats.hits).toBe(0);
    expect(cold.stats.misses).toBeGreaterThan(0);
    const warm = await ParseCache.open(dir);
    const b = await lintRepo({ dir, cache: warm });
    expect(warm.stats.misses).toBe(0);
    expect(warm.stats.hits).toBe(cold.stats.misses);
    expect(brief(b)).toEqual(brief(a));
    expect(brief(b).some((l) => l.startsWith('README.md:8:8 example-unknown-keyword'))).toBe(true);
    expect(brief(await lintRepo({ dir }))).toEqual(brief(a));
    // The cache ignores itself.
    expect(gitIn(dir, 'status', '--porcelain')).toBe('M demo/client.py');
  });

  it('parseRepo with the cache equals parseRepo without it', async () => {
    const dir = await repo();
    const plain = await parseRepo({ repo: 'acme/demo', dir, sha: 'x' });
    const cache = await ParseCache.open(dir);
    await parseRepo({ repo: 'acme/demo', dir, sha: 'x' }, { memo: cache });
    const cached = await parseRepo({ repo: 'acme/demo', dir, sha: 'x' }, { memo: cache });
    expect(JSON.parse(JSON.stringify(cached.modules))).toEqual(JSON.parse(JSON.stringify(plain.modules)));
  });

  it('STALEPROOF_CACHE_DIR moves it; STALEPROOF_CACHE=off turns it off', async () => {
    const dir = await repo();
    const elsewhere = await mkdtemp(join(tmpdir(), 'staleproof-cache-ci-'));
    process.env.STALEPROOF_CACHE_DIR = elsewhere;
    await lintRepo({ dir, cache: true });
    expect(existsSync(join(elsewhere, `parse-${codeStamp()}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, CACHE_DIR))).toBe(false);
    expect(await ParseCache.shared()).toBeDefined();

    delete process.env.STALEPROOF_CACHE_DIR;
    process.env.STALEPROOF_CACHE = 'off';
    await lintRepo({ dir, cache: true });
    expect(existsSync(join(dir, CACHE_DIR))).toBe(false);
    expect(await ParseCache.shared()).toBeUndefined();
  });

  it('a read-only checkout is not an error', async () => {
    const dir = await repo();
    await chmod(dir, 0o555);
    try {
      const r = await lintRepo({ dir, cache: true });
      expect(r.summary.files).toBeGreaterThan(0);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('keeps any per-file value by content, and the git history by the refs', async () => {
    const dir = await repo();
    const cache = await ParseCache.open(dir);
    let runs = 0;
    const count = () => (runs++, { reads: ['API_KEY'] });
    expect(cache.valueSync('env-reads.v1', 'os.environ["API_KEY"]', count)).toEqual({ reads: ['API_KEY'] });
    expect(cache.valueSync('env-reads.v1', 'os.environ["API_KEY"]', count)).toEqual({ reads: ['API_KEY'] });
    expect(await cache.value('env-reads.v2', 'os.environ["API_KEY"]', async () => count())).toEqual({ reads: ['API_KEY'] });
    expect(runs).toBe(2);
    await expect(cache.value('x', 'y', async () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(await cache.value('x', 'y', async () => 'computed')).toBe('computed');

    await mkdir(join(dir, 'demo', 'tools'));
    gitIn(dir, 'mv', 'demo/util.py', 'demo/tools/util.py');
    gitIn(dir, 'commit', '-q', '-m', 'move util');
    const load = async () => {
      const facts = new RepoFacts(dir, new Set(await workingFiles(dir)));
      await loadHistoryCached(facts, cache);
      return facts;
    };
    const first = await load();
    expect(first.renamed.get('demo/util.py')).toBe('demo/tools/util.py');
    const before = cache.stats.hits;
    expect((await load()).renamed.get('demo/util.py')).toBe('demo/tools/util.py');
    expect(cache.stats.hits).toBe(before + 1);
    gitIn(dir, 'rm', '-q', 'demo/tools/util.py');
    gitIn(dir, 'commit', '-q', '-m', 'drop util');
    expect((await load()).deleted.has('demo/tools/util.py')).toBe(true);
  });
});
