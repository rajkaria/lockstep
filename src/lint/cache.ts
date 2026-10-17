import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ExtractMemo } from '../indexer/index.js';
import type { PyModule } from '../indexer/python.js';
import { packageVersion } from '../pkg.js';
import type { RepoFacts } from './facts.js';

/**
 * The local parse cache: what the parsers read from each file, keyed by the file's
 * content, under `.staleproof/cache/` in the checkout. `staleproof lint`, the coding-agent
 * hooks, the editor and indexing share it, so a warm run re-parses only the files that
 * changed. It never leaves the machine and can be deleted at any time.
 *
 * `STALEPROOF_CACHE_DIR` moves it out of the checkout (CI keeps it between runs with
 * `actions/cache`); `STALEPROOF_CACHE=off` turns it off.
 */
export const CACHE_DIR = '.staleproof/cache';

/** Bump when the stored shape changes; Staleproof's own version and code are part of every key too. */
const CACHE_VERSION = 1;
/** One parse file per build (`parse-<salt>.jsonl`): two Staleproofs used on one checkout (a project's and a global one) do not evict each other. */
const parseFile = (salt: string) => `parse-${salt}.jsonl`;
/** Parse files of other builds kept (the most recently written). */
const KEEP_BUILDS = 3;
/** Entries not read for this long are dropped when the file is next written. */
const KEEP_UNUSED_MS = 7 * 24 * 3600 * 1000;
const MAX_ENTRIES = 50_000;
/** A larger file is not read (and is rebuilt): a cache must never be slower than parsing. */
const MAX_FILE_BYTES = 256 << 20;
/** Rewrite an unchanged file at most this often, to refresh last-used times. */
const TOUCH_MS = 12 * 3600 * 1000;

interface Entry {
  /** Last used, ms since the epoch. */
  at: number;
  /** The JSON line as stored: parsed again on every hit, so callers may change what they get. */
  raw: string;
  touched: boolean;
}

interface StoredModule {
  m: PyModule;
  /** Import specifiers the extractor resolved, with the module each resolved to (null: none). */
  r?: [string, string | null][];
}

/** `STALEPROOF_<name>`, or its former name `LOCKSTEP_<name>` (as `setting` in src/config.ts, which this light module does not load). */
function setting(name: string): string | undefined {
  return process.env[`STALEPROOF_${name}`] || process.env[`LOCKSTEP_${name}`] || undefined;
}

export function cacheEnabled(): boolean {
  return !/^(off|0|false|no)$/i.test(setting('CACHE') ?? '');
}

/** Where the cache of a checkout lives. */
export function cacheLocation(dir: string): string {
  const env = setting('CACHE_DIR');
  return env ? resolve(env) : join(resolve(dir), CACHE_DIR);
}

let stamp: string | undefined;

/**
 * What identifies the code that wrote an entry: the version, plus the size and time of
 * the parser sources (from a source checkout) or the bundle (installed), so a rebuilt or
 * edited Staleproof never reads results an older parser wrote.
 */
export function codeStamp(): string {
  if (stamp) return stamp;
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = /[\\/]src[\\/]lint$/.test(here) ? [here, join(here, '..', 'indexer')] : [here];
  const parts = [`v${CACHE_VERSION}`, packageVersion()];
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(d).filter((n) => /\.(ts|js|mjs)$/.test(n)).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        const s = statSync(join(d, n));
        parts.push(`${n}:${s.size}:${Math.round(s.mtimeMs)}`);
      } catch {
        // A file removed while listing: the next run sees the new set.
      }
    }
  }
  stamp = createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
  return stamp;
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Extractor options as part of a key: plain values only, in a fixed order. */
function optionsKey(opts: object): string {
  return JSON.stringify(
    Object.entries(opts)
      .filter(([, v]) => typeof v !== 'function' && v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, text);
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Entries in the file when it was opened. */
  loaded: number;
}

/**
 * Per-file parse results of one checkout (or of every checkout, with `STALEPROOF_CACHE_DIR`).
 * Hand it to `parseRepo(checkout, { memo })` and call `save()` when the run is done; small
 * named JSON records (baselines, hook state) sit next to it with `readJson`/`writeJson`.
 */
export class ParseCache implements ExtractMemo {
  readonly stats: CacheStats = { hits: 0, misses: 0, loaded: 0 };
  private entries = new Map<string, Entry>();
  private dirty = false;

  private constructor(
    /** The cache directory. */
    readonly dir: string,
    private readonly salt: string,
  ) {}

  /** Open the cache of a checkout; a missing, unreadable or outdated file starts it empty. */
  static async open(checkout: string, opts: { dir?: string } = {}): Promise<ParseCache> {
    const cache = new ParseCache(opts.dir ?? cacheLocation(checkout), codeStamp());
    await cache.load();
    return cache;
  }

  /** The cache `STALEPROOF_CACHE_DIR` names, or none (indexing uses the cache only there). */
  static async shared(): Promise<ParseCache | undefined> {
    if (!setting('CACHE_DIR') || !cacheEnabled()) return undefined;
    return ParseCache.open('.', {});
  }

  private async load(): Promise<void> {
    const file = join(this.dir, parseFile(this.salt));
    try {
      if (statSync(file).size > MAX_FILE_BYTES) return;
    } catch {
      return;
    }
    const text = await readFile(file, 'utf8').catch(() => '');
    const lines = text.split('\n');
    let header: { salt?: string } = {};
    try {
      header = JSON.parse(lines[0] || '{}') as { salt?: string };
    } catch {
      return;
    }
    if (header.salt !== this.salt) {
      // Damaged: everything is parsed again and the file replaced.
      this.dirty = true;
      return;
    }
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      const a = line.indexOf(' ');
      const b = a < 0 ? -1 : line.indexOf(' ', a + 1);
      if (b < 0) continue;
      this.entries.set(line.slice(0, a), { at: Number(line.slice(a + 1, b)) || 0, raw: line.slice(b + 1), touched: false });
    }
    this.stats.loaded = this.entries.size;
  }

  /**
   * One file's parse, from the cache when the same content was parsed with the same
   * options (and, for TypeScript, its relative imports still resolve to the same modules).
   */
  async extract<O extends object>(kind: string, source: string, opts: O, run: (opts: O) => Promise<PyModule>): Promise<PyModule> {
    const key = sha1(`${kind}\0${optionsKey(opts)}\0${source}`);
    const resolveSpec = (opts as { resolve?: (spec: string) => string | undefined }).resolve;
    const hit = this.entries.get(key);
    if (hit) {
      try {
        const stored = JSON.parse(hit.raw) as StoredModule;
        if (!stored.r || stored.r.every(([spec, target]) => (resolveSpec?.(spec) ?? null) === target)) {
          hit.touched = true;
          if (Date.now() - hit.at > TOUCH_MS) this.dirty = true;
          hit.at = Date.now();
          this.stats.hits++;
          return stored.m;
        }
      } catch {
        // A damaged line: parse the file again below.
      }
    }
    this.stats.misses++;
    // Record what the extractor resolves, so a later hit can check the answers still hold.
    const resolved: [string, string | null][] = [];
    const recorded = resolveSpec
      ? ({
          ...opts,
          resolve: (spec: string) => {
            const target = resolveSpec(spec);
            resolved.push([spec, target ?? null]);
            return target;
          },
        } as O)
      : opts;
    const m = await run(recorded);
    const stored: StoredModule = resolveSpec ? { m, r: resolved } : { m };
    this.entries.set(key, { at: Date.now(), raw: JSON.stringify(stored), touched: true });
    this.dirty = true;
    return m;
  }

  /**
   * Any other per-file result (JSON values only), keyed by `kind` and the file's content:
   * a fact extractor that scans each code file (`env` reads, CLI definitions) caches its
   * answer here. `kind` must change when the extractor's output does (`env-reads.v2`).
   */
  valueSync<T>(kind: string, source: string, compute: () => T): T {
    const key = sha1(`value\0${kind}\0${source}`);
    const hit = this.lookup<T>(key);
    if (hit) return hit.v;
    const v = compute();
    this.store(key, v);
    return v;
  }

  /** `valueSync` for an async computation (a failed one stores nothing). */
  async value<T>(kind: string, source: string, compute: () => Promise<T> | T): Promise<T> {
    const key = sha1(`value\0${kind}\0${source}`);
    const hit = this.lookup<T>(key);
    if (hit) return hit.v;
    const v = await compute();
    this.store(key, v);
    return v;
  }

  private lookup<T>(key: string): { v: T } | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    try {
      const v = (JSON.parse(hit.raw) as { v: T }).v;
      hit.touched = true;
      if (Date.now() - hit.at > TOUCH_MS) this.dirty = true;
      hit.at = Date.now();
      this.stats.hits++;
      return { v };
    } catch {
      return undefined;
    }
  }

  private store(key: string, v: unknown): void {
    this.stats.misses++;
    this.entries.set(key, { at: Date.now(), raw: JSON.stringify({ v }), touched: true });
    this.dirty = true;
  }

  /** Write the file when something changed: entries used now, and recent ones, are kept. */
  async save(): Promise<void> {
    const now = Date.now();
    const keep = [...this.entries].filter(([, e]) => e.touched || now - e.at < KEEP_UNUSED_MS);
    if (keep.length < this.entries.size) this.dirty = true;
    if (!this.dirty) return;
    keep.sort(([, a], [, b]) => Number(b.touched) - Number(a.touched) || b.at - a.at);
    const lines = [JSON.stringify({ staleproof: 'parse cache', salt: this.salt })];
    for (const [key, e] of keep.slice(0, MAX_ENTRIES)) lines.push(`${key} ${e.at} ${e.raw}`);
    try {
      await this.ensureDir();
      await writeAtomic(join(this.dir, parseFile(this.salt)), `${lines.join('\n')}\n`);
      this.dirty = false;
      await this.pruneBuilds();
    } catch {
      // A read-only checkout: the cache is an optimisation, never an error.
    }
  }

  /** Drop the parse files of builds not used lately (all but the newest few). */
  private async pruneBuilds(): Promise<void> {
    try {
      const files = (await readdir(this.dir)).filter((n) => /^parse-[0-9a-f]+\.jsonl$/.test(n) && n !== parseFile(this.salt));
      if (files.length < KEEP_BUILDS) return;
      const dated = files.map((n) => ({ n, t: statSync(join(this.dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const { n } of dated.slice(KEEP_BUILDS - 1)) await rm(join(this.dir, n), { force: true });
    } catch {
      // Nothing to prune.
    }
  }

  /**
   * A small named record next to the parse cache: per build (results of this Staleproof's
   * rules) unless `shared` (hook state any build may read). Undefined when absent.
   */
  async readJson<T>(name: string, opts: { shared?: boolean } = {}): Promise<T | undefined> {
    try {
      const doc = JSON.parse(await readFile(this.recordPath(name, opts.shared), 'utf8')) as { salt?: string; value: T };
      return opts.shared || doc.salt === this.salt ? doc.value : undefined;
    } catch {
      return undefined;
    }
  }

  async writeJson(name: string, value: unknown, opts: { shared?: boolean } = {}): Promise<void> {
    try {
      await this.ensureDir();
      await writeAtomic(this.recordPath(name, opts.shared), JSON.stringify({ salt: this.salt, value }));
    } catch {
      // As in save().
    }
  }

  private recordPath(name: string, shared?: boolean): string {
    return join(this.dir, shared ? `${name}.json` : `${name}.${this.salt.slice(0, 8)}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // The cache ignores itself, so `git status` stays clean whether or not `.staleproof/` is in .gitignore.
    const ignore = join(this.dir, '.gitignore');
    if (!existsSync(ignore)) await writeFile(ignore, '# Staleproof parse cache: safe to delete.\n*\n').catch(() => {});
  }
}

const run = promisify(execFile);

/**
 * `facts.loadHistory()` through the cache: the deleted and renamed paths of `git log --all`
 * depend only on the refs, so they are read again only when a ref moved. On large
 * repositories this is most of a warm lint.
 */
export async function loadHistoryCached(facts: RepoFacts, cache: ParseCache | undefined): Promise<void> {
  if (!cache || !existsSync(join(facts.root, '.git'))) return facts.loadHistory();
  let refs: string;
  try {
    // One process: HEAD and every ref with its commit.
    refs = (await run('git', ['show-ref', '--head'], { cwd: facts.root, maxBuffer: 64 << 20 })).stdout;
  } catch {
    return facts.loadHistory();
  }
  const history = await cache.value('git-history.v1', refs, async () => {
    await facts.loadHistory();
    return { deleted: [...facts.deleted], renamed: [...facts.renamed] };
  });
  if (!facts.deleted.size) for (const [k, v] of history.deleted) facts.deleted.set(k, v);
  if (!facts.renamed.size) for (const [k, v] of history.renamed) facts.renamed.set(k, v);
}
