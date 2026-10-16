import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { classifyFile, type Checkout } from './repo.js';

/** What a hosted index refuses, so one huge repository can't take the server down. */
export interface TarballLimits {
  /** Compressed download size. */
  maxBytes: number;
  /** Files the indexer would read (Python, Markdown/MDX, dependency manifests). */
  maxFiles: number;
}

export const DEFAULT_TARBALL_LIMITS: TarballLimits = { maxBytes: 150 * 1024 * 1024, maxFiles: 4000 };

export class RepoTooLargeError extends Error {}

/** Files the indexer reads besides code and docs: dependency manifests (src/indexer/deps.ts). */
function wanted(path: string): boolean {
  if (classifyFile(path)) return true;
  const base = posix.basename(path);
  return base === 'pyproject.toml' || /^requirements[\w.-]*\.txt$/.test(base);
}

/**
 * Download a GitHub repository at `ref` as a tarball and extract the files the indexer
 * reads, for hosts without `git` (serverless). Public repositories come from codeload
 * (not counted against the API rate limit); with a token the API's tarball endpoint is
 * used, which also reads private repositories the token can see. The commit SHA comes
 * from the archive's pax header, so this costs no API call.
 */
export async function downloadRepo(
  home: string,
  repo: string,
  ref = 'HEAD',
  opts: { token?: string; limits?: TarballLimits; fetchImpl?: typeof fetch; /** Paths not to extract (e.g. translated docs). */ skip?: (path: string) => boolean } = {},
): Promise<Checkout> {
  const limits = opts.limits ?? DEFAULT_TARBALL_LIMITS;
  const f = opts.fetchImpl ?? fetch;
  const take = (path: string) => !!path && wanted(path) && !opts.skip?.(path);
  const url = opts.token ? `https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(ref)}` : `https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`;
  const res = await f(url, {
    headers: { 'User-Agent': 'staleproof', ...(opts.token ? { Authorization: `Bearer ${opts.token}`, Accept: 'application/vnd.github+json' } : {}) },
    redirect: 'follow',
  });
  if (res.status === 404) throw new Error(`GitHub: ${repo}${ref === 'HEAD' ? '' : `@${ref}`} not found (is it public? private repositories need GITHUB_TOKEN)`);
  if (!res.ok || !res.body) throw new Error(`GitHub: downloading ${repo} failed: ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limits.maxBytes) throw new RepoTooLargeError(tooLarge(repo, `${mb(declared)} archive`, limits));

  const staging = join(home, 'tarballs', `${repo.replace('/', '__')}.${process.pid}.${Date.now()}.tmp`);
  await mkdir(staging, { recursive: true });
  let sha: string | undefined;
  let files = 0;
  let downloaded = 0;
  try {
    const body = Readable.fromWeb(res.body as never);
    body.on('data', (chunk: Buffer) => {
      downloaded += chunk.length;
      if (downloaded > limits.maxBytes) body.destroy(new RepoTooLargeError(tooLarge(repo, `more than ${mb(limits.maxBytes)} archive`, limits)));
    });
    for await (const entry of tarEntries(body.pipe(createGunzip()), (p) => take(p.split('/').slice(1).join('/')))) {
      if (entry.type === 'global') {
        sha ??= /(?:^|\n)\d+ comment=([0-9a-f]{40})\n/.exec(entry.data.toString('utf8'))?.[1];
        continue;
      }
      if (entry.type !== 'file') continue;
      // Strip the archive's top directory (`<repo>-<sha>/`).
      const path = entry.path.split('/').slice(1).join('/');
      if (!path || path.split('/').some((p) => p === '..' || p.startsWith('.')) || !take(path)) continue;
      if (++files > limits.maxFiles) throw new RepoTooLargeError(tooLarge(repo, `more than ${limits.maxFiles} code and docs files`, limits));
      const out = join(staging, ...path.split('/'));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, entry.data);
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  if (!sha) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(`GitHub: the archive of ${repo} carries no commit id`);
  }
  // What was extracted depends on the options (skip), so a previous extraction is replaced, not reused.
  const dir = join(home, 'tarballs', ...repo.split('/'), sha);
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });
  await rename(staging, dir);
  return { repo, dir, sha };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function tooLarge(repo: string, what: string, limits: TarballLimits): string {
  return (
    `${repo} is too large to index from an archive here (${what}; the limit is ${mb(limits.maxBytes)} and ${limits.maxFiles} files). ` +
    'Run Staleproof where git is installed (npx -y staleproof check <pr-url>, which clones instead) or in the GitHub Action.'
  );
}

export interface TarEntry {
  path: string;
  type: 'file' | 'dir' | 'global' | 'other';
  data: Buffer;
}

interface Header {
  name: string;
  type: string;
  size: number;
}

/**
 * A minimal streaming tar reader: ustar headers, pax extended headers (long paths) and
 * GNU long names, which is everything `git archive` (GitHub's archives) writes. Bodies of
 * entries `keep` rejects are discarded as they stream past instead of being buffered.
 */
export async function* tarEntries(stream: AsyncIterable<Buffer>, keep: (path: string) => boolean = () => true): AsyncGenerator<TarEntry> {
  let buf: Buffer = Buffer.alloc(0);
  let body: { header: Header; path: string; padded: number; parts: Buffer[]; got: number; keep: boolean } | undefined;
  let longPath: string | undefined;

  const drain = function* (): Generator<TarEntry> {
    for (;;) {
      if (!body) {
        if (buf.length < 512) return;
        const block = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (block.every((b) => b === 0)) continue;
        const header = parseHeader(block);
        const meta = header.type === 'x' || header.type === 'g' || header.type === 'L';
        const path = meta ? header.name : (longPath ?? header.name);
        if (!meta) longPath = undefined;
        const isFile = header.type === '0' || header.type === '\0' || header.type === '7';
        body = { header, path, padded: Math.ceil(header.size / 512) * 512, parts: [], got: 0, keep: meta || (isFile ? keep(path) : true) };
      }
      const want = body.padded - body.got;
      if (want > 0) {
        if (buf.length === 0) return;
        const n = Math.min(want, buf.length);
        if (body.keep) body.parts.push(buf.subarray(0, n));
        body.got += n;
        buf = buf.subarray(n);
        if (body.got < body.padded) return;
      }
      const { header, path } = body;
      const data = body.keep ? Buffer.concat(body.parts).subarray(0, header.size) : Buffer.alloc(0);
      const kept = body.keep;
      body = undefined;
      if (header.type === 'x') {
        longPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? longPath;
        continue;
      }
      if (header.type === 'L') {
        longPath = data.toString('utf8').replace(/\0+$/, '');
        continue;
      }
      if (!kept) continue;
      const type = header.type === 'g' ? 'global' : header.type === '5' ? 'dir' : header.type === '0' || header.type === '\0' || header.type === '7' ? 'file' : 'other';
      yield { path, type, data };
    }
  };

  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    yield* drain();
  }
  yield* drain();
}

function field(block: Buffer, start: number, len: number): string {
  const s = block.subarray(start, start + len);
  const end = s.indexOf(0);
  return s.subarray(0, end < 0 ? len : end).toString('utf8');
}

function parseHeader(block: Buffer): Header {
  const name = field(block, 0, 100);
  const prefix = field(block, 345, 155);
  // Base-256 sizes (high bit set) are for files over 8 GB; GitHub archives never carry them.
  const size = block[124]! & 0x80 ? Number.MAX_SAFE_INTEGER : parseInt(field(block, 124, 12).trim() || '0', 8);
  return { name: prefix ? `${prefix}/${name}` : name, type: String.fromCharCode(block[156]!), size };
}
