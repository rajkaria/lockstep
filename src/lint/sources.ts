import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { classifyFile, gitAvailable, gitEnv, type Checkout } from '../indexer/repo.js';
import { DEFAULT_TARBALL_LIMITS, RepoTooLargeError, tarEntries, type TarballLimits } from '../indexer/tarball.js';
import { lintRepo, type LintOptions } from './engine.js';
import type { LintResult } from './types.js';

/**
 * Where `staleproof lint` reads a repository from: the working tree, the git index
 * (`--staged`), any commit of a local clone (`--new` compares with one), or a GitHub
 * tarball (hosted checks, no git). Every source but the working tree is a temporary
 * directory that looks to lint like a checkout at that commit, so base and head are
 * linted the same way and their findings compare by fingerprint.
 */
export interface LintTree {
  /** The directory to lint. */
  dir: string;
  /** `owner/name` when known. */
  repo?: string;
  /** The commit, when the tree is one. */
  sha?: string;
  /** For messages: `working tree`, `index`, `origin/main (1a2b3c4)`. */
  label: string;
  /** Every file of the tree when `dir` holds only some of them (a tarball extraction). */
  paths?: string[];
  /** A temporary directory, removed by `dispose`. */
  temporary: boolean;
  dispose(): Promise<void>;
}

const exec = promisify(execFile);

/**
 * Variables git exports to hooks (`GIT_INDEX_FILE` in pre-commit): they locate the user's
 * repository, so they must never reach a git command run in a temporary tree.
 */
const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE'];

function treeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...gitEnv(), ...extra };
  for (const v of REPO_VARS) if (!(v in extra)) delete env[v];
  return env;
}

async function run(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<string> {
  try {
    const child = exec('git', args, { cwd, env: opts.env ?? gitEnv(), maxBuffer: 256 << 20 });
    if (opts.input !== undefined) child.child.stdin!.end(opts.input);
    return (await child).stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(e.stderr || e.message).trim()}`);
  }
}

/** The top of the git checkout `dir` is in, or undefined outside git. */
export async function gitRoot(dir: string): Promise<string | undefined> {
  try {
    return (await run(resolve(dir), ['rev-parse', '--show-toplevel'])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The commit a ref names in a checkout. */
export async function resolveCommit(root: string, ref: string): Promise<string> {
  try {
    return (await run(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
  } catch {
    throw new Error(`${ref} is not a commit in ${root} (fetch it first; Staleproof never fetches for lint)`);
  }
}

const noop = async () => {};

/** The files on disk, as `staleproof lint` reads them by default. */
export function worktreeTree(dir: string, repo?: string): LintTree {
  return { dir: resolve(dir), repo, label: 'working tree', temporary: false, dispose: noop };
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `staleproof-${prefix}-`));
}

/**
 * Make `tmp` a git repository whose objects and refs are the real one's (alternates and a
 * copy of the refs: nothing is cloned), at `head`, with the real `origin` URL. Lint then
 * reads it like a checkout: `git ls-files` for the file list, `.gitignore` rules, and the
 * same history (renames and deletions) as the working tree.
 */
async function shadowRepo(real: string, tmp: string, head?: string): Promise<void> {
  const env = treeEnv();
  await run(tmp, ['init', '-q'], { env });
  const objects = resolve(real, (await run(real, ['rev-parse', '--git-path', 'objects'])).trim());
  const inherited = await readFile(join(objects, 'info', 'alternates'), 'utf8').catch(() => '');
  await writeFile(join(tmp, '.git', 'objects', 'info', 'alternates'), `${objects}\n${inherited}`);
  const refs = await run(real, ['for-each-ref', '--format=%(objectname) %(refname)']).catch(() => '');
  await writeFile(join(tmp, '.git', 'packed-refs'), refs);
  if (head) await run(tmp, ['update-ref', '--no-deref', 'HEAD', head], { env });
  const origin = (await run(real, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  if (origin) await run(tmp, ['config', 'remote.origin.url', origin], { env });
}

/** Submodules have no files in the tree: give them their directory, as a checkout has. */
async function makeGitlinks(tmp: string, prefix = ''): Promise<void> {
  const staged = await run(tmp, ['ls-files', '-s', '-z'], { env: treeEnv() });
  for (const entry of staged.split('\0')) {
    if (entry.startsWith('160000 ')) await mkdir(join(tmp, prefix, entry.slice(entry.indexOf('\t') + 1)), { recursive: true });
  }
}

/**
 * A commit of a local clone, extracted into a temporary directory. No ref is fetched; a
 * blob-less clone reads the blobs it lacks in one batch, as `git checkout` does. LFS files
 * stay pointers. `subdir` is the part of the repository the caller lints.
 */
export async function refTree(dir: string, ref: string, opts: { repo?: string; subdir?: string } = {}): Promise<LintTree> {
  const root = (await gitRoot(dir)) ?? resolve(dir);
  const sha = await resolveCommit(root, ref);
  const tmp = await tempDir('ref');
  try {
    await shadowRepo(root, tmp, sha);
    // The real repository checks the commit out into the temporary tree and index (its own index
    // and files are untouched): `read-tree -u` prefetches a partial clone's missing blobs in one request.
    await run(root, ['-c', 'core.sparseCheckout=false', 'read-tree', '--reset', '-u', sha], {
      env: { ...gitEnv(), GIT_INDEX_FILE: join(tmp, '.git', 'index'), GIT_WORK_TREE: tmp, GIT_LFS_SKIP_SMUDGE: '1' },
    });
    await makeGitlinks(tmp);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  const label = ref === sha || ref.startsWith(sha.slice(0, 7)) ? sha.slice(0, 7) : `${ref} (${sha.slice(0, 7)})`;
  return { dir: join(tmp, opts.subdir ?? ''), repo: opts.repo, sha, label, temporary: true, dispose: () => rm(tmp, { recursive: true, force: true }) };
}

/**
 * The git index (what the next commit will contain), extracted into a temporary
 * directory. In a pre-commit hook this is the index git hands the hook.
 */
export async function indexTree(dir: string, opts: { repo?: string; subdir?: string } = {}): Promise<LintTree> {
  const root = (await gitRoot(dir)) ?? resolve(dir);
  const head = (await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim() || undefined;
  const tmp = await tempDir('index');
  try {
    await shadowRepo(root, tmp, head);
    await run(root, ['checkout-index', '-a', '-f', `--prefix=${tmp}/`], { env: { ...gitEnv(), GIT_LFS_SKIP_SMUDGE: '1' } });
    const entries = await run(root, ['ls-files', '-s', '-z']);
    await run(tmp, ['update-index', '-z', '--index-info'], { env: treeEnv(), input: entries });
    await makeGitlinks(tmp);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return { dir: join(tmp, opts.subdir ?? ''), repo: opts.repo, ...(head ? { sha: head } : {}), label: 'index', temporary: true, dispose: () => rm(tmp, { recursive: true, force: true }) };
}

/** Binary files: listed (paths to them are real) but never written or read. */
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|psd|ai|sketch|fig|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|whl|egg|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|mkv|webm|wav|ogg|flac|so|dylib|dll|exe|bin|dat|db|sqlite3?|parquet|arrow|npy|npz|pkl|pickle|pt|pth|onnx|h5|hdf5|ckpt|safetensors|wasm|class|o|a|lib|pyc|node)$/i;
const MAX_TEXT_FILE = 1 << 20;
/** What one extraction writes besides the indexer's files: generous, but bounded for small serverless disks. */
const MAX_EXTRA_FILES = 30_000;
const MAX_EXTRA_BYTES = 200 << 20;

/**
 * The files the indexer reads from an archive, which count against `maxFiles`: the same
 * rule as `wanted` in src/indexer/tarball.ts (`downloadRepo`), kept in step with it.
 */
function indexerFile(path: string): boolean {
  if (path !== '.staleproof.toml' && path.split('/').some((p) => p.startsWith('.'))) return false;
  const base = posix.basename(path);
  return (
    !!classifyFile(path) ||
    base === 'pyproject.toml' ||
    base === 'package.json' ||
    base === 'go.mod' ||
    path === '.staleproof.toml' ||
    /^requirements[\w.-]*\.txt$/.test(base)
  );
}

export interface DownloadedTree extends Checkout {
  /** Every file of the commit, extracted or not. */
  paths: string[];
}

/**
 * Download a GitHub repository at `ref` as a tarball (no git): the indexer's files
 * (code, docs, manifests; `maxFiles` counts these) plus everything else lint reads (agent
 * files in hidden folders, Makefiles, env files, scripts), and the list of every path.
 * Public repositories come from codeload; with a token, a 404 there is retried through the
 * API, which reads private repositories the token can see. `skip` paths are listed, not
 * written (translated docs on the hosted index).
 */
export async function downloadTree(
  home: string,
  repo: string,
  ref = 'HEAD',
  opts: { token?: string; limits?: TarballLimits; fetchImpl?: typeof fetch; skip?: (path: string) => boolean; signal?: AbortSignal } = {},
): Promise<DownloadedTree> {
  const limits = opts.limits ?? DEFAULT_TARBALL_LIMITS;
  const f = opts.fetchImpl ?? fetch;
  const get = (url: string, token?: string) =>
    f(url, {
      headers: { 'User-Agent': 'staleproof', ...(token ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } : {}) },
      redirect: 'follow',
      signal: opts.signal,
    });
  let res = await get(`https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`);
  if (res.status === 404 && opts.token) res = await get(`https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(ref)}`, opts.token);
  if (res.status === 404) throw new Error(`GitHub: ${repo}${ref === 'HEAD' ? '' : `@${ref}`} not found (is it public? private repositories need GITHUB_TOKEN)`);
  if (!res.ok || !res.body) throw new Error(`GitHub: downloading ${repo} failed: ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  const tooLarge = (what: string) =>
    new RepoTooLargeError(
      `${repo} is too large to read from an archive here (${what}; the limit is ${Math.round(limits.maxBytes / 1048576)} MB and ${limits.maxFiles} code and docs files). ` +
        'Run Staleproof where git is installed (npx -y staleproof lint, or the GitHub Action).',
    );
  if (declared > limits.maxBytes) throw tooLarge(`${Math.round(declared / 1048576)} MB archive`);

  const staging = join(home, 'trees', `${repo.replace('/', '__')}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`);
  await mkdir(staging, { recursive: true });
  const paths: string[] = [];
  const strip = (p: string) => p.split('/').slice(1).join('/');
  const safe = (p: string) => !!p && !p.split('/').some((x) => x === '..' || x === '.git');
  const writable = (p: string) => safe(p) && !opts.skip?.(p) && !BINARY.test(p) && !/(^|\/)node_modules\//.test(p);
  let sha: string | undefined;
  let indexed = 0;
  let extra = 0;
  let extraBytes = 0;
  let downloaded = 0;
  try {
    const body = Readable.fromWeb(res.body as never);
    body.on('data', (chunk: Buffer) => {
      downloaded += chunk.length;
      if (downloaded > limits.maxBytes) body.destroy(tooLarge(`more than ${Math.round(limits.maxBytes / 1048576)} MB archive`));
    });
    // Every file entry is listed here, whether or not its body is kept.
    const keep = (raw: string) => {
      const p = strip(raw);
      if (p && safe(p)) paths.push(p);
      return writable(p);
    };
    for await (const entry of tarEntries(body.pipe(createGunzip()), keep)) {
      if (entry.type === 'global') {
        sha ??= /(?:^|\n)\d+ comment=([0-9a-f]{40})\n/.exec(entry.data.toString('utf8'))?.[1];
        continue;
      }
      const path = strip(entry.path);
      if (entry.type === 'other' && path && safe(path)) paths.push(path);
      if (entry.type !== 'file' || !writable(path)) continue;
      if (indexerFile(path)) {
        if (++indexed > limits.maxFiles) throw tooLarge(`more than ${limits.maxFiles} code and docs files`);
      } else if (entry.data.length > MAX_TEXT_FILE || extra >= MAX_EXTRA_FILES || extraBytes + entry.data.length > MAX_EXTRA_BYTES) {
        continue;
      } else {
        extra++;
        extraBytes += entry.data.length;
      }
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
  const dir = join(home, 'trees', ...repo.split('/'), `${sha}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dirname(dir), { recursive: true });
  await rename(staging, dir);
  return { repo, dir, sha, paths: [...new Set(paths)].sort() };
}

/** A GitHub repository at `ref` from its tarball, for hosts without git or without a clone. */
export async function tarballTree(
  home: string,
  repo: string,
  ref = 'HEAD',
  opts: { token?: string; limits?: TarballLimits; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<LintTree> {
  const t = await downloadTree(home, repo, ref, opts);
  return { dir: t.dir, repo, sha: t.sha, paths: t.paths, label: ref === t.sha || ref === 'HEAD' ? t.sha.slice(0, 7) : `${ref} (${t.sha.slice(0, 7)})`, temporary: true, dispose: () => rm(t.dir, { recursive: true, force: true }) };
}

/**
 * A commit of a GitHub repository: from a local clone that has it (the CLI and the Action
 * clone before checking), else from its tarball (the hosted service has no git).
 */
export async function commitTree(
  repo: string,
  sha: string,
  opts: { home: string; clone?: string; token?: string; limits?: TarballLimits; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<LintTree> {
  if (opts.clone && existsSync(join(opts.clone, '.git')) && (await gitAvailable())) {
    try {
      return await refTree(opts.clone, sha, { repo });
    } catch {
      // The clone lacks the commit (a fork's head, a shallow clone): fall back to the archive.
    }
  }
  return tarballTree(opts.home, repo, sha, opts);
}

/**
 * Another tree with some files replaced (`null` deletes): what an editor's unsaved edits
 * would make of the repository. Copies the tree; the original is left as it is.
 */
export async function overlayTree(base: LintTree, files: { path: string; content: string | null }[], label = 'edited files'): Promise<LintTree> {
  const edits = files.map((f) => {
    const path = posix.normalize(f.path.replace(/^\.?\//, ''));
    if (!path || path === '.' || path.startsWith('../') || path === '..' || posix.isAbsolute(path) || path.split('/').includes('.git')) throw new Error(`not a repository path: ${f.path}`);
    return { path, content: f.content };
  });
  const tmp = await tempDir('overlay');
  // A git-backed tree is copied with its .git (still a checkout of the same objects); a tarball extraction is a plain folder.
  await cp(base.dir, tmp, { recursive: true, verbatimSymlinks: true });
  const paths = base.paths ? new Set(base.paths) : undefined;
  for (const f of edits) {
    const path = f.path;
    const out = join(tmp, ...path.split('/'));
    if (f.content === null) {
      await rm(out, { force: true });
      paths?.delete(path);
    } else {
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, f.content);
      paths?.add(path);
    }
  }
  return { dir: tmp, repo: base.repo, label, ...(paths ? { paths: [...paths].sort() } : {}), temporary: true, dispose: () => rm(tmp, { recursive: true, force: true }) };
}

/**
 * Run `fn` with the hook variables (`GIT_INDEX_FILE`, ...) out of the environment: lint's
 * own git calls in a temporary tree must read that tree, not the user's repository.
 */
async function withoutHookEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = REPO_VARS.filter((v) => process.env[v] !== undefined).map((v) => [v, process.env[v]!] as const);
  if (!saved.length) return fn();
  for (const [v] of saved) delete process.env[v];
  try {
    return await fn();
  } finally {
    for (const [v, value] of saved) process.env[v] = value;
  }
}

/** Lint a tree: `lintRepo` on its directory, with its commit, name and file list. */
export async function lintTree(tree: LintTree, opts: Omit<LintOptions, 'dir' | 'paths'> = {}): Promise<LintResult> {
  const go = () =>
    lintRepo({
      ...opts,
      dir: tree.dir,
      ...(opts.repo ?? tree.repo ? { repo: opts.repo ?? tree.repo } : {}),
      ...(opts.sha ?? tree.sha ? { sha: opts.sha ?? tree.sha } : {}),
      ...(tree.paths ? { paths: tree.paths } : {}),
    });
  return tree.temporary ? withoutHookEnv(go) : go();
}

/** The repository-relative folder of `dir` inside its checkout (`''` at the root). */
export function subdirOf(root: string, dir: string): string {
  // `git rev-parse --show-toplevel` answers with the real path; `dir` may go through a symlink
  // (macOS `/var` → `/private/var`), so compare real paths or the result climbs out of the root.
  const real = (p: string) => {
    try {
      return realpathSync(resolve(p));
    } catch {
      return resolve(p);
    }
  };
  const rel = relative(real(root), real(dir)).split('\\').join('/');
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`${dir} is not inside the checkout ${root}`);
  return rel === '.' ? '' : rel;
}

