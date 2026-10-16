import { posix } from 'node:path';
import type { PyDef, PyModule } from './python.js';
import { npmToken, sanitize } from './typescript.js';

/** A published npm package in a repository (a `package.json` with a name, not private). */
export interface NpmPackage {
  dir: string;
  name: string;
  /** Source files the manifest's entry points (main/module/types/exports) map back to, best first. */
  entries: string[];
}

export const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

interface Manifest {
  name?: string;
  private?: boolean;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  source?: string;
  exports?: unknown;
}

function exportsEntry(exp: unknown): string[] {
  if (typeof exp === 'string') return [exp];
  if (!exp || typeof exp !== 'object') return [];
  const o = exp as Record<string, unknown>;
  const dot = '.' in o ? o['.'] : o;
  if (typeof dot === 'string') return [dot];
  if (!dot || typeof dot !== 'object') return [];
  const d = dot as Record<string, unknown>;
  return ['source', 'types', 'import', 'module', 'require', 'default', 'node'].flatMap((k) => exportsEntry(d[k]));
}

/** `dist/index.js`, `./lib/main.d.ts` → the source files they were built from. */
function sourceCandidates(entry: string): string[] {
  const clean = posix.normalize(entry.replace(/^\.\//, '')).replace(/\.d\.(m|c)?ts$/, '').replace(/\.(m|c)?js$/, '').replace(/\.(m|c)?ts$/, '');
  const stems = [clean, clean.replace(/^(dist|build|lib|out|esm|cjs|es|umd)\//, 'src/'), clean.replace(/^(dist|build|lib|out|esm|cjs|es|umd)\/(esm|cjs|src)\//, 'src/')];
  return [...new Set(stems)].flatMap((s) => ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx'].map((x) => `${s}${x}`));
}

export function readManifest(dir: string, text: string): NpmPackage | undefined {
  let m: Manifest;
  try {
    m = JSON.parse(text) as Manifest;
  } catch {
    return undefined;
  }
  if (!m.name || m.private) return undefined;
  const entries = [m.source, m.types, m.typings, m.module, ...exportsEntry(m.exports), m.main]
    .filter((x): x is string => typeof x === 'string')
    .flatMap(sourceCandidates);
  entries.push(...['src/index.ts', 'src/index.tsx', 'index.ts', 'src/index.js', 'index.js', 'lib/index.js', 'src/main.ts']);
  const prefix = dir ? `${dir}/` : '';
  return { dir, name: m.name, entries: [...new Set(entries.map((e) => `${prefix}${e}`))] };
}

/** The package a file belongs to: the nearest enclosing package directory. */
export function packageOf(path: string, packages: NpmPackage[]): NpmPackage | undefined {
  let best: NpmPackage | undefined;
  for (const p of packages) {
    if (p.dir && !path.startsWith(`${p.dir}/`)) continue;
    if (!best || p.dir.length > best.dir.length) best = p;
  }
  return best;
}

export interface TsModuleName {
  module: string;
  pkg: NpmPackage;
  /** An `index` file: relative imports of its directory resolve to it. */
  isIndex: boolean;
}

/**
 * Module names for a repository's TypeScript/JavaScript files: `js-<package>` plus the
 * path inside the package (a leading `src/` dropped, `index` files naming their
 * directory). Files outside a published package are not library code and get none.
 */
export function tsModuleNames(paths: string[], packages: NpmPackage[]): Map<string, TsModuleName> {
  const out = new Map<string, TsModuleName>();
  for (const path of paths) {
    if (!TS_EXT.test(path)) continue;
    const pkg = packageOf(path, packages);
    if (!pkg) continue;
    const rel = (pkg.dir ? path.slice(pkg.dir.length + 1) : path).replace(TS_EXT, '');
    const parts = rel.replace(/^src\//, '').split('/');
    const isIndex = parts.at(-1) === 'index';
    if (isIndex) parts.pop();
    out.set(path, { module: [npmToken(pkg.name), ...parts.map(sanitize)].join('.'), pkg, isIndex });
  }
  return out;
}

/** Resolve a relative import from a file to the module of the file it names (`./graph`, `./graph.js`, `../util/index`). */
export function relativeResolver(from: string, names: Map<string, TsModuleName>): (spec: string) => string | undefined {
  const dir = posix.dirname(from);
  return (spec) => {
    const base = posix.normalize(posix.join(dir, spec)).replace(/\.(m|c)?js$/, '');
    for (const ext of ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs']) {
      const hit = names.get(`${base}${ext}`);
      if (hit) return hit.module;
    }
    return undefined;
  };
}

/**
 * The module a package's name imports (`import { X } from 'falkordb'`): when the entry
 * file isn't already named after the package, a module that re-exports it.
 */
export function packageModules(packages: NpmPackage[], names: Map<string, TsModuleName>): PyModule[] {
  const out: PyModule[] = [];
  for (const pkg of packages) {
    const token = npmToken(pkg.name);
    const entry = pkg.entries.map((e) => names.get(e)).find(Boolean);
    if (!entry || entry.module === token) continue;
    const def: PyDef = { qualname: token, name: token, kind: 'module', lineno: 1, endLineno: 1, signature: '', decorators: [], parent: null, returnExprs: [], bases: [], params: [], isAsync: false };
    out.push({
      module: token,
      path: pkg.dir ? `${pkg.dir}/package.json` : 'package.json',
      defs: [def],
      imports: [{ alias: '*', target: entry.module, lineno: 1, exported: true }],
      bindings: [],
      calls: [],
      idents: [],
      lang: 'ts',
    });
  }
  return out;
}
