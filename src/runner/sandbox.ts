import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { git, gitEnv } from '../indexer/repo.js';
import { packageRoot } from '../pkg.js';

export interface InstallTarget {
  repo: string;
  sha: string;
  /** Local clone the source is archived from. */
  dir: string;
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_OUTPUT = 64 * 1024;

/** Run a process with a hard timeout; the whole process group is killed on timeout. */
export function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; input?: string },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    child.stdin.end(opts.input ?? '');
  });
}

let sandboxCheck: Promise<boolean> | undefined;

/** Whether this host can build sandboxes (git + uv or python3). False on serverless hosts. */
export function sandboxAvailable(): Promise<boolean> {
  sandboxCheck ??= (async () => (await which('git')) && ((await which('uv')) || (await which('python3'))))();
  return sandboxCheck;
}

async function which(cmd: string): Promise<boolean> {
  try {
    const r = await runProcess(cmd, ['--version'], { timeoutMs: 10_000, env: process.env });
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Extract `sha` of a clone into `dest` (git archive | tar), fetching missing blobs lazily. */
async function archive(dir: string, sha: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    // Blob-less clones fetch missing blobs here, so this git needs the token too (private repositories).
    const gitProc = spawn('git', ['archive', '--format=tar', sha], { cwd: dir, env: gitEnv() });
    const tar = spawn('tar', ['-x', '-C', dest]);
    let err = '';
    gitProc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    tar.stderr.on('data', (d: Buffer) => (err += d.toString()));
    gitProc.stdout.pipe(tar.stdin);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git archive ${sha} failed: ${err.trim()}`))));
    gitProc.on('error', reject);
    tar.on('error', reject);
  });
}

/** The directory holding the Python project (pyproject.toml / setup.py) of a source tree at a commit. */
export async function projectSubdir(dir: string, sha: string): Promise<string> {
  const files = (await git(dir, ['ls-tree', '-r', '--name-only', sha])).split('\n');
  const candidates = files
    .filter((f) => /(^|\/)(pyproject\.toml|setup\.py)$/.test(f))
    .filter((f) => !/(^|\/)(tests?|docs|examples?|benchmarks?)\//.test(f))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  return candidates[0] ? posix.dirname(candidates[0]) : '.';
}

const PYTHON_VERSION = '3.12';
const venvLocks = new Map<string, Promise<string>>();

/**
 * A virtualenv with every target installed from source at its commit, cached by
 * (repo@sha set, Python version). Returns the venv's python executable.
 */
export function ensureVenv(home: string, targets: InstallTarget[], log?: (m: string) => void): Promise<string> {
  const spec = targets.map((t) => `${t.repo}@${t.sha}`).sort();
  const key = createHash('sha1').update(JSON.stringify([PYTHON_VERSION, ...spec])).digest('hex').slice(0, 16);
  const pending = venvLocks.get(key);
  if (pending) return pending;
  const p = buildVenv(home, key, targets, spec, log).finally(() => venvLocks.delete(key));
  venvLocks.set(key, p);
  return p;
}

/** Variables uv and pip need: paths, locale, proxies, certificates, their own settings. */
const INSTALL_ENV = /^(PATH|HOME|TMPDIR|TEMP|TMP|USER|LOGNAME|SHELL|LANG|LC_\w+|TZ|XDG_CACHE_HOME|XDG_DATA_HOME|UV_\w+|PIP_\w+|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|https?_proxy|no_proxy|all_proxy|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|SYSTEMROOT|COMSPEC|PATHEXT)$/;

/**
 * The environment for building the sandbox: an allow-list, not the server's environment.
 * Installing the repositories at a pull request's commits runs their build backends
 * (setup.py, hatch hooks), which must not see FALKORDB_URL, model keys or GITHUB_TOKEN.
 */
export function installEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && INSTALL_ENV.test(k)) env[k] = v;
  return env;
}

/**
 * The error recorded when the repositories can't be installed. Its first line is what
 * the agent and the UI show, so a resolver conflict names the pin that blocks it
 * (e.g. an SDK requiring `falkordb<2` while the client under test is 2.x).
 */
export function installFailure(spec: string[], stderr: string): string {
  const flat = stderr.replace(/\s+/g, ' ');
  const pin = /(\S+==[^\s,]+) depends on (.+?), we can conclude/.exec(flat);
  const head = pin
    ? `dependency conflict: ${pin[1]} requires ${pin[2]}, which the other checkouts don't satisfy (installing ${spec.join(', ')})`
    : `installing ${spec.join(', ')} failed:`;
  return `${head}\n${stderr.trim().slice(-2000)}`;
}

async function buildVenv(home: string, key: string, targets: InstallTarget[], spec: string[], log?: (m: string) => void): Promise<string> {
  const venv = join(home, 'venvs', key);
  const python = join(venv, 'bin', 'python');
  const marker = join(venv, '.staleproof-ok');
  // Venvs built before the rename carry `.lockstep-ok` and are reused as they are.
  if ((existsSync(marker) || existsSync(join(venv, '.lockstep-ok'))) && existsSync(python)) return python;
  log?.(`building sandbox environment for ${spec.join(', ')}`);
  const src = join(home, 'src', key);
  await rm(src, { recursive: true, force: true });
  const paths: string[] = [];
  for (const t of targets) {
    const dest = join(src, t.repo.replace('/', '__'));
    await archive(t.dir, t.sha, dest);
    paths.push(join(dest, await projectSubdir(t.dir, t.sha)));
  }
  await rm(venv, { recursive: true, force: true });
  const env = installEnv(process.env);
  if (await which('uv')) {
    const mk = await runProcess('uv', ['venv', '-q', '--python', PYTHON_VERSION, venv], { timeoutMs: 300_000, env });
    if (mk.code !== 0) throw new Error(`uv venv failed: ${mk.stderr.trim()}`);
    const inst = await runProcess('uv', ['pip', 'install', '-q', '--python', python, ...paths], { timeoutMs: 600_000, env });
    if (inst.code !== 0) throw new Error(installFailure(spec, inst.stderr));
  } else {
    const mk = await runProcess('python3', ['-m', 'venv', venv], { timeoutMs: 300_000, env });
    if (mk.code !== 0) throw new Error(`python3 -m venv failed: ${mk.stderr.trim()}`);
    const inst = await runProcess(python, ['-m', 'pip', 'install', '-q', ...paths], { timeoutMs: 600_000, env });
    if (inst.code !== 0) throw new Error(installFailure(spec, inst.stderr));
  }
  await writeFile(marker, JSON.stringify({ spec, python: PYTHON_VERSION, createdAt: new Date().toISOString() }));
  await rm(src, { recursive: true, force: true });
  return python;
}

export interface SandboxRun extends ProcResult {
  python: string;
}

/**
 * Execute a Python program in an isolated working directory: no inherited
 * secrets, HOME in a temp dir, outbound network refused except the scratch
 * FalkorDB (which answers for localhost:6379).
 */
export async function runInSandbox(
  python: string,
  code: string,
  opts: { scratchPort: number; scratchHost?: string; timeoutMs: number },
): Promise<SandboxRun> {
  const work = await mkdtemp(join(tmpdir(), 'staleproof-run-'));
  try {
    const shim = join(work, '_shim');
    await mkdir(shim);
    await writeFile(join(shim, 'sitecustomize.py'), await readFile(join(packageRoot(), 'python', 'sitecustomize.py'), 'utf8'));
    await writeFile(join(work, 'example.py'), code);
    await writeFile(join(work, '_run_example.py'), await readFile(join(packageRoot(), 'python', 'run_example.py'), 'utf8'));
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: work,
      TMPDIR: work,
      LANG: 'C.UTF-8',
      PYTHONPATH: shim,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUNBUFFERED: '1',
      STALEPROOF_SCRATCH_HOST: opts.scratchHost ?? '127.0.0.1',
      STALEPROOF_SCRATCH_PORT: String(opts.scratchPort),
    };
    // _run_example.py runs example.py, with top-level await allowed for async docs.
    const r = await runProcess(python, ['-s', '_run_example.py'], { cwd: work, env, timeoutMs: opts.timeoutMs });
    return { ...r, python };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
