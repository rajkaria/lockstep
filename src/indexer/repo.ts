import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { setting } from '../config.js';

const exec = promisify(execFile);

/**
 * With GITHUB_TOKEN (or GH_TOKEN) set, clones and fetches from github.com send it, so
 * private repositories the token can read work too. It goes through git's environment
 * config (not the remote URL or argv) and only to https://github.com/.
 */
function gitAuthEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token || env.GIT_CONFIG_COUNT) return {};
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

export async function git(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...gitAuthEnv() },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(e.stderr || e.message).trim()}`);
  }
}

let gitCheck: Promise<boolean> | undefined;

/** Whether `git` can run here (false on serverless hosts, or when STALEPROOF_INGEST=github). */
export function gitAvailable(): Promise<boolean> {
  if (setting('INGEST') === 'github') return Promise.resolve(false);
  gitCheck ??= exec('git', ['--version']).then(
    () => true,
    () => false,
  );
  return gitCheck;
}

/** `owner/name` from a GitHub URL or an `owner/name` string. */
export function parseRepoName(input: string): string {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m) throw new Error(`not a GitHub repository: "${input}" (expected owner/name or a github.com URL)`);
  return `${m[1]}/${m[2]}`;
}

export interface Checkout {
  repo: string;
  dir: string;
  sha: string;
}

/**
 * Clone (blob-less) or fetch a public GitHub repository under `<home>/repos/<owner>/<name>`
 * and check out `ref` (default: the remote's default branch head).
 */
export async function checkoutRepo(home: string, repo: string, ref?: string): Promise<Checkout> {
  const dir = join(home, 'repos', ...repo.split('/'));
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(dirname(dir), { recursive: true });
    await git(dirname(dir), ['clone', '--quiet', '--filter=blob:none', `https://github.com/${repo}.git`, dir]);
  } else {
    await git(dir, ['fetch', '--quiet', '--prune', 'origin']);
  }
  const target = ref ?? (await defaultBranchRef(dir));
  await git(dir, ['checkout', '--quiet', '--detach', target]);
  const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  return { repo, dir, sha };
}

async function defaultBranchRef(dir: string): Promise<string> {
  try {
    return (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
  } catch {
    return 'origin/main';
  }
}

/** Tracked files (git ls-files), so build output and vendored junk never enter the graph. */
export async function trackedFiles(dir: string): Promise<string[]> {
  const out = await git(dir, ['ls-files', '-z']);
  return out.split('\0').filter(Boolean);
}

const IGNORED_DIRS = /(^|\/)(\.github|node_modules|venv|\.venv|build|dist|site-packages|__pycache__|\.tox|\.mypy_cache)\//;
const TEST_FILE = /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;

/** Repository housekeeping files are not product documentation. */
const NON_DOCS_MD = /(^|\/)(CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|SUPPORT|AGENTS|CLAUDE|GEMINI|LICENSE|NOTICE|PULL_REQUEST_TEMPLATE|ISSUE_TEMPLATE)[^/]*\.mdx?$/i;

export type FileKind = 'python' | 'markdown' | 'python-example';

/** Classify a tracked path; `undefined` means the indexer skips it. */
export function classifyFile(path: string): FileKind | undefined {
  if (IGNORED_DIRS.test(path)) return undefined;
  if (/\.(md|mdx)$/i.test(path)) {
    return NON_DOCS_MD.test(path) || /(^|\/)(tests?|testing|fixtures)\//.test(path) ? undefined : 'markdown';
  }
  if (!path.endsWith('.py')) return undefined;
  if (TEST_FILE.test(path)) return undefined;
  if (/(^|\/)(setup|noxfile|fabfile)\.py$/.test(path)) return undefined;
  if (/(^|\/)(examples?|samples?|tutorials?|notebooks?)\//.test(path)) return 'python-example';
  if (/(^|\/)(scripts?|benchmarks?|docs)\//.test(path)) return undefined;
  return 'python';
}

/**
 * Dotted module names for Python files. A package root is a directory with an
 * `__init__.py` whose parent has none; the module path starts at that root, so
 * `graphrag_sdk/src/graphrag_sdk/core/connection.py` → `graphrag_sdk.core.connection`.
 */
export function moduleNames(pyFiles: string[]): Map<string, { module: string; isPackage: boolean }> {
  const inits = new Set(pyFiles.filter((f) => posix.basename(f) === '__init__.py').map((f) => posix.dirname(f)));
  const out = new Map<string, { module: string; isPackage: boolean }>();
  for (const file of pyFiles) {
    let dir = posix.dirname(file);
    if (!inits.has(dir)) {
      // A loose module (no package): name it after its path so qualnames stay unique.
      const loose = file.replace(/\.py$/, '').split('/').map(sanitize).join('.');
      out.set(file, { module: loose, isPackage: false });
      continue;
    }
    while (inits.has(posix.dirname(dir)) && posix.dirname(dir) !== '.') dir = posix.dirname(dir);
    const root = posix.dirname(dir) === '.' ? '' : posix.dirname(dir);
    const rel = root ? file.slice(root.length + 1) : file;
    const isPackage = posix.basename(file) === '__init__.py';
    const parts = rel.replace(/\.py$/, '').split('/');
    if (isPackage) parts.pop();
    out.set(file, { module: parts.join('.'), isPackage });
  }
  return out;
}

function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_]/g, '_');
}
