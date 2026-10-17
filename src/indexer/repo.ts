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

/** The environment every git process gets: no prompts, and the token for github.com when there is one. */
export function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', ...gitAuthEnv() };
}

export async function git(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      env: gitEnv(),
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
const NON_DOCS_MD = /(^|\/)(CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|SUPPORT|AGENTS|CLAUDE|GEMINI|LICENSE|NOTICE|PULL_REQUEST_TEMPLATE|ISSUE_TEMPLATE)[^/]*\.(mdx?|rst)$/i;

export type FileKind = 'python' | 'markdown' | 'python-example' | 'typescript' | 'js-example' | 'go' | 'go-example';

const TS_TEST = /(^|\/)(__tests__|__mocks__|tests?|test-utils|e2e|cypress|playwright|fixtures|coverage|out|\.next|\.docusaurus|\.vitepress)\/|\.(test|spec|stories|bench)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|\.min\.js$|(^|\/)[\w.-]+\.config\.[cm]?[jt]s$/;

/** Classify a tracked path; `undefined` means the indexer skips it. */
export function classifyFile(path: string): FileKind | undefined {
  if (IGNORED_DIRS.test(path)) return undefined;
  if (/\.(md|mdx|rst)$/i.test(path)) {
    return NON_DOCS_MD.test(path) || /(^|\/)(tests?|testing|fixtures)\//.test(path) ? undefined : 'markdown';
  }
  // TypeScript/JavaScript: library code only when it belongs to a published package (decided in parseRepo).
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) {
    if (TS_TEST.test(path)) return undefined;
    if (/(^|\/)(examples?|samples?)\//.test(path)) return 'js-example';
    if (/(^|\/)(scripts?|benchmarks?|docs|site|website)\//.test(path)) return undefined;
    return 'typescript';
  }
  // Go: what the go tool builds into a package (no tests, vendored code, testdata, or `_`/`.` directories).
  if (path.endsWith('.go')) {
    if (/_test\.go$/.test(path) || /(^|\/)(vendor|testdata)\//.test(path) || /(^|\/)[._][^/]*\//.test(path)) return undefined;
    if (/(^|\/)(examples?|samples?)\//.test(path)) return 'go-example';
    return 'go';
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
 * Inside a project's source root (`pythonSourceRoots`), a package's module path is its
 * path from the root, so a namespace package (`src/acme/graph/` with no
 * `src/acme/__init__.py`, as uv workspaces split one namespace across members) imports
 * as `acme.graph`.
 */
export function moduleNames(pyFiles: string[], roots: string[] = []): Map<string, { module: string; isPackage: boolean }> {
  const inits = new Set(pyFiles.filter((f) => posix.basename(f) === '__init__.py').map((f) => posix.dirname(f)));
  const out = new Map<string, { module: string; isPackage: boolean }>();
  const byLength = [...roots].sort((a, b) => b.length - a.length);
  for (const file of pyFiles) {
    let dir = posix.dirname(file);
    if (!inits.has(dir)) {
      // A loose module (no package): name it after its path so qualnames stay unique.
      const loose = file.replace(/\.py$/, '').split('/').map(sanitize).join('.');
      out.set(file, { module: loose, isPackage: false });
      continue;
    }
    const sourceRoot = byLength.find((r) => file.startsWith(`${r}/`) && !inits.has(r));
    if (sourceRoot !== undefined) {
      const isPackage = posix.basename(file) === '__init__.py';
      const parts = file.slice(sourceRoot.length + 1).replace(/\.py$/, '').split('/');
      if (isPackage) parts.pop();
      out.set(file, { module: parts.join('.'), isPackage });
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

const NOT_A_PROJECT = /(^|\/)(tests?|testing|docs|examples?|samples?|node_modules|testdata|fixtures|benchmarks?)\//;

/**
 * Source roots of a repository's Python projects (each `pyproject.toml`, `setup.py` or
 * `setup.cfg`: a monorepo's uv workspace members, several packages side by side):
 * `<project>/src` for the src layout, else the project directory itself (not the
 * repository root, where the `__init__.py` rule already holds).
 */
export function pythonSourceRoots(paths: string[]): string[] {
  const projects = new Set(
    paths.filter((p) => /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg)$/.test(p) && !NOT_A_PROJECT.test(p)).map((p) => (posix.dirname(p) === '.' ? '' : posix.dirname(p))),
  );
  const roots: string[] = [];
  for (const d of projects) {
    const src = d ? `${d}/src` : 'src';
    if (paths.some((p) => p.startsWith(`${src}/`) && p.endsWith('.py'))) roots.push(src);
    else if (d) roots.push(d);
  }
  return roots.sort();
}

const TRANSLATED_README = /(^|\/)(README|CONTRIBUTING|index)[._-](ar|bn|cs|de|es|fa|fr|he|hi|id|it|ja|jp|ko|kr|nl|pl|pt|pt[-_]br|ru|th|tr|uk|ua|vi|zh|zh[-_](cn|tw|hans|hant))\.(md|mdx|rst)$/i;
const VERSIONED = /^(.+?)[-_.](v\d+(\.\d+)*|\d+\.x)$/i;

/** Every directory of a file list (each file's folder and its ancestors). */
export function directoriesOf(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) for (let d = posix.dirname(p); d !== '.' && !out.has(d); d = posix.dirname(d)) out.add(d);
  return out;
}

/**
 * Docs pages whose examples are not judged against today's code: a versioned copy kept
 * next to the current docs (`docs-v3/` beside `docs/`, Docusaurus `versioned_docs/`)
 * documents an older API on purpose, and a translated README (`README_KO.md`,
 * `README.zh-CN.md`) is maintained apart from its source.
 */
export function olderOrTranslatedDocs(path: string, dirs: Set<string>): boolean {
  if (TRANSLATED_README.test(path)) return true;
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'versioned_docs') return true;
    const m = VERSIONED.exec(parts[i]!);
    if (m && dirs.has([...parts.slice(0, i), m[1]!].join('/'))) return true;
  }
  return false;
}

/** A package of a repository: an npm `package.json`, a Python project, a Go module. */
export interface WorkspacePackage {
  kind: 'npm' | 'python' | 'go';
  /** Directory inside the repository ('' for the root). */
  dir: string;
  /** The manifest the package is declared in (`packages/core/package.json`). */
  manifest: string;
}

/**
 * Every package a repository declares, monorepo or not: `package.json` files (npm, yarn
 * and pnpm workspaces), Python projects (uv workspace members, several `pyproject.toml`
 * packages) and Go modules (`go.mod`, `go.work` members). Generated, vendored and test
 * folders are left out.
 */
export function workspacePackages(paths: string[]): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const p of paths) {
    if (/(^|\/)(node_modules|vendor|testdata|fixtures)\//.test(p)) continue;
    const base = posix.basename(p);
    const kind = base === 'package.json' ? 'npm' : base === 'pyproject.toml' || base === 'setup.py' ? 'python' : base === 'go.mod' ? 'go' : undefined;
    if (kind) out.push({ kind, dir: posix.dirname(p) === '.' ? '' : posix.dirname(p), manifest: p });
  }
  return out.sort((a, b) => a.manifest.localeCompare(b.manifest));
}

/**
 * The package a file belongs to: the one whose directory is its closest ancestor (a
 * monorepo's `packages/core/README.md` → `packages/core/package.json`). Commands a page
 * names resolve against this package's scripts.
 */
export function nearestPackage(path: string, packages: WorkspacePackage[], kind?: WorkspacePackage['kind']): WorkspacePackage | undefined {
  let best: WorkspacePackage | undefined;
  for (const p of packages) {
    if (kind && p.kind !== kind) continue;
    if (p.dir && path !== p.dir && !path.startsWith(`${p.dir}/`)) continue;
    if (!best || p.dir.length > best.dir.length) best = p;
  }
  return best;
}
