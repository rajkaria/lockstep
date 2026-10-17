import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JS_LANGS } from '../indexer/docs.js';
import { git } from '../indexer/repo.js';
import type { ExampleSource, PreparedExample } from './prepare.js';
import { archive, installEnv, runProcess, type InstallTarget, type ProcResult } from './sandbox.js';

/**
 * Running JavaScript/TypeScript docs examples, the way the Python runner does: the page's
 * earlier blocks stitched in front of a fragment, the packages the example imports built
 * from source at the indexed commits (`npm ci`/`pnpm install`, the package's own `build`
 * script, `npm pack`) and installed into a scratch project, then the example run by Node
 * (TypeScript through tsx) with no inherited secrets, HOME in a temp dir, and every
 * outbound connection refused except FalkorDB on localhost:6379, which answers from the
 * scratch server. A package that does not build is a skipped run with the reason, never a
 * failing example: the docs are not what broke.
 */

const LLM =
  /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|GEMINI_API_KEY|AZURE_OPENAI\w*|GROQ_API_KEY|COHERE_API_KEY|MISTRAL_API_KEY|XAI_API_KEY|DEEPSEEK_API_KEY)\b|from\s+["'](openai|@anthropic-ai\/sdk|@ai-sdk\/[\w-]+|@google\/generative-ai|@google\/genai|cohere-ai|groq-sdk|@mistralai\/[\w-]+|@langchain\/[\w-]+|langchain)["']|\bnew\s+(OpenAI|Anthropic|ChatOpenAI|ChatAnthropic)\s*\(/;
const PLACEHOLDER = /["'`][^"'`]*<(your|YOUR|insert|INSERT)[^>]*>[^"'`]*["'`]|["'`]your[-_ ][a-z-_ ]*(key|password|token|host|secret|id)["'`]|["'`](sk|pk)-(\.\.\.|x{3,}|your)/i;
const LOCAL_FILE = /\b(readFileSync|readFile|createReadStream|openSync)\s*\(\s*["'`]([^"'`]+)["'`]/;
const BROWSER = /\b(document|window|localStorage|sessionStorage|navigator)\.\w/;
const EXTERNAL = /\b(fetch|axios(?:\.\w+)?|got(?:\.\w+)?|ky(?:\.\w+)?|request)\s*\(\s*["'`]https?:\/\/(?!localhost|127\.0\.0\.1)/;
const SERVER = /\.\s*listen\s*\(|\bserve\s*\(\s*\{|\bsetInterval\s*\(/;
const INPUT = /\breadline\b|process\.stdin|\bprompt\s*\(/;
const JSX = /return\s*\(?\s*<[A-Za-z]|=>\s*\(?\s*<[A-Za-z]|<\/[A-Za-z][\w.]*>|\/>\s*[);,]/;

/** A block that brings its own imports (`import … from`, `require(…)`, `await import(…)`): not a fragment. */
const OWN_IMPORTS = /^\s*import\s[^;]*?\bfrom\s*["']|^\s*import\s*["']|\brequire\s*\(\s*["']|\bimport\s*\(\s*["']/m;

/** Why a JS/TS example can't be run as written, or undefined when it can. */
export function jsSkipReason(code: string, lang: string): string | undefined {
  if (!JS_LANGS.has(lang)) return `not JavaScript or TypeScript (${lang || 'no language tag'})`;
  if (!code.trim()) return 'empty example';
  if (lang === 'jsx' || lang === 'tsx' || JSX.test(code)) return 'renders JSX (needs a UI framework to run)';
  const llm = LLM.exec(code);
  if (llm) return `needs an LLM provider (${llm[0].trim().slice(0, 40)}); Staleproof does not hold provider keys`;
  if (BROWSER.test(code)) return 'runs in a browser (uses document/window)';
  const file = LOCAL_FILE.exec(code);
  if (file && !/\b(writeFileSync|writeFile)\s*\(/.test(code)) return `reads a local file the docs do not provide (${file[2]})`;
  if (PLACEHOLDER.test(code)) return 'contains placeholders to fill in (e.g. "<your-host>")';
  if (INPUT.test(code)) return 'waits for user input';
  if (EXTERNAL.test(code)) return 'calls an external service';
  if (SERVER.test(code)) return 'starts a server or a timer (it never exits on its own)';
  return undefined;
}

const isTs = (lang: string) => lang === 'ts' || lang === 'typescript' || lang === 'tsx';

/**
 * Make a JS/TS example runnable the way a reader would run it: a fragment with no imports
 * is preceded by the page's earlier runnable JS/TS examples (an import line repeated
 * across blocks is kept once, since ES modules reject a second binding of a name).
 */
export function prepareJsExample(target: ExampleSource, earlier: ExampleSource[]): PreparedExample {
  const code = target.code;
  const skip = jsSkipReason(code, target.lang);
  if (skip) return { code, stitched: [], skip, lang: target.lang };
  if (OWN_IMPORTS.test(code)) return { code, stitched: [], lang: target.lang };
  const usable = earlier.filter((e) => JS_LANGS.has(e.lang) && !jsSkipReason(e.code, e.lang));
  if (usable.length === 0) return { code, stitched: [], lang: target.lang };
  const seen = new Set<string>();
  const dedupe = (block: string) =>
    block
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        if (!/^import\s/.test(t)) return true;
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      })
      .join('\n');
  return {
    code: [...usable.map((e) => `// --- stitched from ${e.id}\n${dedupe(e.code)}`), `// --- ${target.id}\n${dedupe(code)}`].join('\n\n'),
    stitched: usable.map((e) => e.id),
    // One TypeScript block makes the whole program TypeScript.
    lang: [target, ...usable].some((e) => isTs(e.lang)) ? 'typescript' : target.lang,
  };
}

/** The file an example runs as: ES module unless it is CommonJS (`require` and no `import`); `.mts`/`.cts` for TypeScript. */
export function jsModuleFile(code: string, lang: string): { file: string; code: string } {
  const ts = isTs(lang);
  const esm = /^\s*(import|export)\s/m.test(code) || !/\brequire\s*\(/.test(code);
  if (esm) return { file: ts ? 'example.mts' : 'example.mjs', code };
  // CommonJS has no top-level await: a reader pasting this into Node would wrap it.
  const wrapped = /(^|[^\w.$])await\s/.test(code) ? `(async () => {\n${code}\n})().catch((err) => {\n  console.error(err);\n  process.exitCode = 1;\n});\n` : code;
  return { file: ts ? 'example.cts' : 'example.cjs', code: wrapped };
}

const BUILTINS = new Set(builtinModules);

/** npm package names an example imports (`import x from 'pkg/sub'`, `require('@scope/pkg')`), Node built-ins (`fs`, `node:net`) left out. */
export function importedPackages(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'./][^"']*)["']/g)) {
    const spec = m[1]!;
    if (spec.startsWith('node:')) continue;
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    if (!BUILTINS.has(name)) out.add(name);
  }
  return [...out].sort();
}

/** The last uncaught error Node printed: `TypeError: g.roQuery is not a function`. */
export function jsErrorLine(stderr: string): string | undefined {
  const lines = stderr.split('\n');
  for (const l of lines) {
    const t = l.trim();
    if (/^([A-Z]\w*(Error|Exception)|Error)(\s\[[\w-]+\])?:\s/.test(t) || /^\[\w+(Error|Rejection)\b/.test(t)) return t.slice(0, 500);
  }
  return lines.map((l) => l.trim()).filter(Boolean).find((l) => !/^(at |file:|Node\.js v)/.test(l));
}

/** What Node printed for the failure, from the excerpt to the last stack frame (without the version footer). */
export function jsTraceback(stderr: string): string | undefined {
  const trimmed = stderr.replace(/\n*Node\.js v[\d.]+\s*$/, '').trim();
  return trimmed || undefined;
}

/** A ReferenceError on a name nothing on the page defines means the example is a fragment, not broken. */
export function isJsFragmentFailure(code: string, stderr: string): boolean {
  const m = /ReferenceError: ([\w$]+) is not defined/.exec(stderr);
  if (!m) return false;
  const name = m[1]!.replace(/\$/g, '\\$');
  return !new RegExp(`\\b(const|let|var|function|class)\\s+${name}\\b|\\{[^}]*\\b${name}\\b[^}]*\\}\\s*(=|from)|\\bimport\\s+${name}\\b|\\bas\\s+${name}\\b`).test(code);
}

/** A package that would not build or install from source: the run is skipped, with this reason. */
export class BuildSkipped extends Error {}

/** A published package (`package.json` with a name, not private) of a repository at a commit. */
export interface SourcePackage {
  name: string;
  /** Directory inside the repository ('' for the root). */
  dir: string;
  deps: string[];
  scripts: Record<string, string>;
}

export async function packagesAt(clone: string, sha: string): Promise<SourcePackage[]> {
  const files = (await git(clone, ['ls-tree', '-r', '--name-only', sha])).split('\n');
  const out: SourcePackage[] = [];
  for (const f of files.filter((p) => /(^|\/)package\.json$/.test(p) && !/(^|\/)(node_modules|test|tests|fixtures|examples?)\//.test(p))) {
    try {
      const m = JSON.parse(await git(clone, ['show', `${sha}:${f}`])) as {
        name?: string;
        private?: boolean;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      if (!m.name || m.private) continue;
      out.push({ name: m.name, dir: posix.dirname(f) === '.' ? '' : posix.dirname(f), deps: Object.keys({ ...m.dependencies, ...m.peerDependencies }), scripts: m.scripts ?? {} });
    } catch {
      // Not JSON at this commit: not a package.
    }
  }
  return out;
}

export interface NodeEnv {
  /** The scratch project: `package.json` and `node_modules` with the built packages. */
  dir: string;
  /** tsx's ESM loader, for TypeScript examples. */
  tsx?: string;
  /** `repo@sha` of every repository a package was built from. */
  installed: string[];
}

const NODE_MAJOR = process.versions.node.split('.')[0]!;
const envLocks = new Map<string, Promise<NodeEnv>>();

/** Staleproof's own tsx (a development install); a published install adds tsx to the scratch project instead. */
function ownTsx(): string | undefined {
  try {
    const loader = createRequire(import.meta.url).resolve('tsx');
    return existsSync(loader) ? loader : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A scratch Node project with the example's packages installed from source at their
 * commits, cached by (Node major, repo@sha set, packages). Packages the example imports
 * come from the indexed repositories, with the organisation packages they depend on.
 */
export function ensureNodeEnv(home: string, targets: InstallTarget[], wanted: string[], log?: (m: string) => void): Promise<NodeEnv> {
  const spec = targets.map((t) => `${t.repo}@${t.sha}`).sort();
  const key = createHash('sha1').update(JSON.stringify([NODE_MAJOR, ...spec, '|', ...[...wanted].sort()])).digest('hex').slice(0, 16);
  const pending = envLocks.get(key);
  if (pending) return pending;
  const p = buildNodeEnv(home, key, targets, wanted, log).finally(() => envLocks.delete(key));
  envLocks.set(key, p);
  return p;
}

const tail = (s: string, n = 1500) => (s.length > n ? `…${s.slice(-n)}` : s).trim();

async function step(cmd: string, args: string[], cwd: string, what: string, timeoutMs = 600_000): Promise<ProcResult> {
  // The Python install's allow-list, plus npm's own settings (`npm_config_registry`, a mirror), like `UV_*` and `PIP_*` there.
  const npm = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && /^npm_config_/i.test(k)));
  const env = { ...installEnv(process.env), ...npm, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
  let r: ProcResult;
  try {
    r = await runProcess(cmd, args, { cwd, env, timeoutMs });
  } catch (err) {
    throw new BuildSkipped(`${what}: ${cmd} is not available here (${(err as Error).message})`);
  }
  if (r.timedOut) throw new BuildSkipped(`${what}: no exit after ${timeoutMs / 1000}s`);
  if (r.code !== 0) throw new BuildSkipped(`${what} failed:\n${tail(r.stderr || r.stdout)}`);
  return r;
}

/** The package manager a repository is set up for, from its lockfile. */
function packageManager(root: string): 'npm' | 'pnpm' | 'yarn' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

async function isWorkspaceRoot(root: string): Promise<boolean> {
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) return true;
  try {
    return !!(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { workspaces?: unknown }).workspaces;
  } catch {
    return false;
  }
}

/** Install a repository's dependencies, run the package's build script, and pack it: the tarball's path. */
async function buildPackage(root: string, pkg: SourcePackage, out: string, log?: (m: string) => void): Promise<string> {
  const pkgDir = pkg.dir ? join(root, pkg.dir) : root;
  const pm = packageManager(root);
  const installAt = pkg.dir && (await isWorkspaceRoot(root)) ? root : pkgDir;
  log?.(`building ${pkg.name} from source (${pm})`);
  if (pm === 'pnpm') await step('pnpm', ['install', '--frozen-lockfile'], installAt, `pnpm install for ${pkg.name}`);
  else if (pm === 'yarn') await step('yarn', ['install', '--frozen-lockfile'], installAt, `yarn install for ${pkg.name}`);
  else if (existsSync(join(installAt, 'package-lock.json')) || existsSync(join(installAt, 'npm-shrinkwrap.json'))) await step('npm', ['ci', '--no-audit', '--no-fund'], installAt, `npm ci for ${pkg.name}`);
  else await step('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock'], installAt, `npm install for ${pkg.name}`);
  if (pkg.scripts.build) {
    // pnpm builds the package's workspace dependencies first (`name...`); npm and yarn run the package's own script.
    if (pm === 'pnpm') await step('pnpm', ['--filter', `${pkg.name}...`, 'run', 'build'], root, `the build script of ${pkg.name}`);
    else await step(pm, ['run', 'build'], pkgDir, `the build script of ${pkg.name}`);
  }
  await mkdir(out, { recursive: true });
  const before = new Set(await readdir(out));
  // pnpm rewrites `workspace:` dependency ranges when it packs; npm leaves them, so pnpm repositories pack with pnpm.
  if (pm === 'pnpm') await step('pnpm', ['pack', '--pack-destination', out], pkgDir, `packing ${pkg.name}`);
  else await step('npm', ['pack', '--ignore-scripts', '--pack-destination', out], pkgDir, `packing ${pkg.name}`);
  const made = (await readdir(out)).filter((f) => f.endsWith('.tgz') && !before.has(f));
  if (!made[0]) throw new BuildSkipped(`packing ${pkg.name} produced no tarball`);
  return join(out, made[0]);
}

async function buildNodeEnv(home: string, key: string, targets: InstallTarget[], wanted: string[], log?: (m: string) => void): Promise<NodeEnv> {
  const dir = join(home, 'node-envs', key);
  const marker = join(dir, '.staleproof-ok');
  if (existsSync(marker)) return JSON.parse(await readFile(marker, 'utf8')) as NodeEnv;
  // Which repository builds which package; then the wanted ones plus the org packages they depend on.
  const owners = new Map<string, { target: InstallTarget; pkg: SourcePackage }>();
  for (const t of targets) for (const pkg of await packagesAt(t.dir, t.sha)) if (!owners.has(pkg.name)) owners.set(pkg.name, { target: t, pkg });
  const needed: string[] = [];
  const queue = wanted.filter((w) => owners.has(w));
  while (queue.length) {
    const name = queue.shift()!;
    if (needed.includes(name)) continue;
    needed.push(name);
    for (const d of owners.get(name)!.pkg.deps) if (owners.has(d) && !needed.includes(d)) queue.push(d);
  }
  if (needed.length === 0) throw new BuildSkipped(`the example imports no package built from an indexed repository (${wanted.join(', ') || 'no imports'})`);
  log?.(`building a Node sandbox for ${needed.join(', ')}`);
  const src = join(home, 'src', `node-${key}`);
  await rm(src, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
  const tarballs: string[] = [];
  const roots = new Map<string, string>();
  const installed = new Set<string>();
  try {
    for (const name of needed) {
      const { target, pkg } = owners.get(name)!;
      let root = roots.get(target.repo);
      if (!root) {
        root = join(src, target.repo.replace('/', '__'));
        await archive(target.dir, target.sha, root);
        roots.set(target.repo, root);
      }
      tarballs.push(await buildPackage(root, pkg, join(src, '_packs'), log));
      installed.add(`${target.repo}@${target.sha}`);
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'staleproof-example', private: true, type: 'module' }, null, 2));
    const tsx = ownTsx();
    // Other packages the example imports come from the registry, as a reader would install them
    // (not the ones the built packages already depend on: those arrive with them).
    const deps = new Set(needed.flatMap((n) => owners.get(n)!.pkg.deps));
    const extras = wanted.filter((w) => !owners.has(w) && !deps.has(w));
    await step('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock', ...tarballs, ...extras, ...(tsx ? [] : ['tsx@4'])], dir, `installing ${[...needed, ...extras].join(', ')} into the sandbox`);
    const env: NodeEnv = { dir, tsx: tsx ?? join(dir, 'node_modules', 'tsx', 'dist', 'loader.mjs'), installed: [...installed].sort() };
    await writeFile(marker, JSON.stringify(env));
    return env;
  } finally {
    await rm(src, { recursive: true, force: true });
  }
}

/** Whether this host can build Node sandboxes (git and npm; Node is the one running Staleproof). */
let jsCheck: Promise<boolean> | undefined;
export function jsSandboxAvailable(): Promise<boolean> {
  jsCheck ??= (async () => {
    for (const cmd of ['git', 'npm']) {
      try {
        if ((await runProcess(cmd, ['--version'], { timeoutMs: 15_000, env: process.env })).code !== 0) return false;
      } catch {
        return false;
      }
    }
    return true;
  })();
  return jsCheck;
}

/**
 * Preloaded into every example (`node --require`): connections to FalkorDB on
 * localhost:6379 go to the scratch server, every other connection and DNS lookup is
 * refused, so an example can neither touch a real database nor reach the network.
 */
export const NODE_SHIM = `'use strict';
const net = require('node:net');
const dns = require('node:dns');
const env = process.env;
const SCRATCH_HOST = env.STALEPROOF_SCRATCH_HOST || '127.0.0.1';
const SCRATCH_PORT = Number(env.STALEPROOF_SCRATCH_PORT || 6390);
const DB_PORTS = new Set(String(env.STALEPROOF_DB_PORTS || '6379').split(',').filter(Boolean).map(Number));
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal', 'falkordb', '']);
const refused = (host, port) => Object.assign(new Error('Staleproof sandbox: outbound network is disabled (tried ' + host + ':' + port + '); only FalkorDB on localhost:6379 is available'), { code: 'ECONNREFUSED' });
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const opts = Array.isArray(first) ? first[0] : first !== null && typeof first === 'object' ? first : typeof first === 'number' || /^\\d+$/.test(String(first)) ? null : { path: first };
  if (opts && opts.path) return realConnect.apply(this, args);
  const port = Number(opts ? opts.port : first);
  const host = String((opts ? opts.host : typeof args[1] === 'string' ? args[1] : '') || 'localhost');
  let target;
  if (LOCAL.has(host) && DB_PORTS.has(port)) target = { host: SCRATCH_HOST, port: SCRATCH_PORT };
  else if ((host === SCRATCH_HOST || host === 'localhost' || host === '127.0.0.1') && port === SCRATCH_PORT) target = { host: SCRATCH_HOST, port: SCRATCH_PORT };
  if (!target) {
    process.nextTick(() => this.destroy(refused(host, port)));
    return this;
  }
  if (opts) {
    opts.host = target.host;
    opts.port = target.port;
    return realConnect.apply(this, args);
  }
  const cb = args.find((a) => typeof a === 'function');
  return realConnect.call(this, target.port, target.host, cb);
};
const dnsRefused = (host) => Object.assign(new Error('Staleproof sandbox: DNS is disabled (' + host + ')'), { code: 'ENOTFOUND' });
const lookup = (host, options, cb) => {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  if (!LOCAL.has(host || '')) return process.nextTick(() => cb(dnsRefused(host)));
  if (options && options.all) return process.nextTick(() => cb(null, [{ address: '127.0.0.1', family: 4 }]));
  process.nextTick(() => cb(null, '127.0.0.1', 4));
};
dns.lookup = lookup;
dns.promises.lookup = (host, options) => new Promise((resolve, reject) => lookup(host, options || {}, (err, address, family) => (err ? reject(err) : resolve(Array.isArray(address) ? address : { address, family }))));
for (const m of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveSrv', 'resolveTxt', 'resolveMx', 'resolveCname', 'resolveNs']) {
  dns[m] = (host, ...rest) => { const cb = rest.find((a) => typeof a === 'function'); if (cb) process.nextTick(() => cb(dnsRefused(host))); };
  if (dns.promises[m]) dns.promises[m] = (host) => Promise.reject(dnsRefused(host));
}
`;

export interface JsRun extends ProcResult {
  file: string;
}

/**
 * Execute an example in the scratch project: a fresh working directory inside it (so the
 * installed packages resolve), no inherited environment, the network shim preloaded,
 * TypeScript through tsx. Paths of the working directory are written as `./` in the output.
 */
export async function runJsInSandbox(env: Pick<NodeEnv, 'dir' | 'tsx'>, code: string, lang: string, opts: { scratchPort: number; scratchHost?: string; timeoutMs: number }): Promise<JsRun> {
  await mkdir(env.dir, { recursive: true });
  const work = await mkdtemp(join(env.dir, 'run-'));
  try {
    const { file, code: source } = jsModuleFile(code, lang);
    await writeFile(join(work, '_shim.cjs'), NODE_SHIM);
    await writeFile(join(work, file), source);
    const ts = /\.(mts|cts)$/.test(file);
    if (ts && (!env.tsx || !existsSync(env.tsx))) throw new BuildSkipped('TypeScript examples need tsx, which is not installed in the sandbox');
    const args = ['--require', './_shim.cjs', ...(ts ? ['--import', pathToFileURL(env.tsx!).href] : []), file];
    const childEnv: NodeJS.ProcessEnv = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: work,
      TMPDIR: work,
      LANG: 'C.UTF-8',
      NODE_NO_WARNINGS: '1',
      STALEPROOF_SCRATCH_HOST: opts.scratchHost ?? '127.0.0.1',
      STALEPROOF_SCRATCH_PORT: String(opts.scratchPort),
    };
    const r = await runProcess(process.execPath, args, { cwd: work, env: childEnv, timeoutMs: opts.timeoutMs });
    const clean = (s: string) => s.split(pathToFileURL(work).href).join('.').split(work).join('.');
    return { ...r, stdout: clean(r.stdout), stderr: clean(r.stderr), file };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
