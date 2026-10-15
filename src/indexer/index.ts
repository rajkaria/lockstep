import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import { ensureSchema } from '../graph/schema.js';
import { extractPython, type PyModule } from './python.js';
import { classifyFile, moduleNames, trackedFiles, type Checkout, type FileKind } from './repo.js';
import { symbolId, SymbolTable } from './resolve.js';

export interface IndexProgress {
  phase: 'checkout' | 'parse' | 'write' | 'resolve' | 'docs' | 'done';
  repo?: string;
  message: string;
}

export interface RepoIndexReport {
  repo: string;
  sha: string;
  files: number;
  symbols: number;
  calls: { exact: number; byName: number; crossRepo: number };
  gone: number;
  parseErrors: string[];
}

export interface IndexReport {
  org: string;
  run: string;
  repos: RepoIndexReport[];
  ms: number;
}

export interface ParsedRepo {
  checkout: Checkout;
  files: { path: string; kind: FileKind }[];
  modules: PyModule[];
  parseErrors: string[];
}

const BATCH = 400;

export async function writeBatched(graph: OrgGraph, query: Q.NamedQuery, rows: unknown[], extra: Record<string, unknown> = {}): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await graph.run(query, { ...extra, rows: rows.slice(i, i + BATCH) });
  }
}

/** All indexable files of a checkout (git-tracked when it is a git repo, else a directory walk). */
export async function listFiles(dir: string): Promise<{ path: string; kind: FileKind }[]> {
  const paths = existsSync(join(dir, '.git')) ? await trackedFiles(dir) : await walk(dir, dir);
  return paths.flatMap((path) => {
    const kind = classifyFile(path);
    return kind ? [{ path, kind }] : [];
  });
}

async function walk(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(root, full)));
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out.sort();
}

export async function parseRepo(checkout: Checkout): Promise<ParsedRepo> {
  const files = await listFiles(checkout.dir);
  const py = files.filter((f) => f.kind === 'python').map((f) => f.path);
  const names = moduleNames(py);
  const modules: PyModule[] = [];
  const parseErrors: string[] = [];
  for (const path of py) {
    const meta = names.get(path)!;
    try {
      const source = await readFile(join(checkout.dir, path), 'utf8');
      modules.push(await extractPython(source, { module: meta.module, path, isPackage: meta.isPackage }));
    } catch (err) {
      parseErrors.push(`${path}: ${(err as Error).message}`);
    }
  }
  return { checkout, files, modules, parseErrors };
}

export function buildSymbolTable(parsed: ParsedRepo[]): SymbolTable {
  const table = new SymbolTable();
  for (const p of parsed) for (const m of p.modules) table.add(p.checkout.repo, m);
  return table;
}

/**
 * Write the code half of the graph for every parsed repository: Repo, File and
 * Symbol nodes, then CALLS edges resolved against the whole organisation.
 */
export async function writeCode(
  graph: OrgGraph,
  parsed: ParsedRepo[],
  table: SymbolTable,
  run: string,
  onProgress: (p: IndexProgress) => void = () => {},
): Promise<RepoIndexReport[]> {
  await ensureSchema(graph);
  const reports: RepoIndexReport[] = [];
  for (const p of parsed) {
    const { repo, sha } = p.checkout;
    onProgress({ phase: 'write', repo, message: `writing ${p.modules.length} modules` });
    await graph.run(Q.upsertRepo, {
      name: repo,
      props: { name: repo, url: `https://github.com/${repo}`, sha, indexed_at: Date.now(), packages: packagesOf(p.modules) },
    });
    await writeBatched(
      graph,
      Q.upsertFiles,
      p.files.map((f) => ({ id: fileId(repo, f.path), repo, props: { repo, path: f.path, kind: f.kind } })),
      { run },
    );
    const symbols = p.modules.flatMap((m) =>
      m.defs.map((d) => ({
        id: symbolId(repo, d.qualname),
        file: fileId(repo, m.path),
        props: {
          repo,
          qualname: d.qualname,
          name: d.name,
          kind: d.kind,
          path: m.path,
          lineno: d.lineno,
          end_lineno: d.endLineno,
          signature: d.signature,
          doc: d.doc ?? '',
          visibility: visibility(d.name),
          decorators: d.decorators,
        },
      })),
    );
    await writeBatched(graph, Q.upsertSymbols, symbols, { run });
    reports.push({
      repo,
      sha,
      files: p.files.length,
      symbols: symbols.length,
      calls: { exact: 0, byName: 0, crossRepo: 0 },
      gone: 0,
      parseErrors: p.parseErrors,
    });
  }
  for (const [i, p] of parsed.entries()) {
    const { repo } = p.checkout;
    onProgress({ phase: 'resolve', repo, message: 'resolving calls' });
    const calls = p.modules.flatMap((m) => table.resolveModule(repo, m));
    await graph.run(Q.deleteRepoCalls, { repo });
    await writeBatched(graph, Q.upsertCalls, calls);
    const gone = await graph.run<{ gone: number }>(Q.markGoneSymbols, { repo, run });
    const report = reports[i]!;
    report.gone = gone.rows[0]?.gone ?? 0;
    for (const c of calls) {
      if (c.resolved === 'exact') report.calls.exact++;
      else report.calls.byName++;
      if (!c.to.startsWith(`${repo}:`)) report.calls.crossRepo++;
    }
  }
  return reports;
}

export function fileId(repo: string, path: string): string {
  return `${repo}:${path}`;
}

function visibility(name: string): 'public' | 'private' | 'special' {
  if (/^__.*__$/.test(name)) return 'special';
  return name.startsWith('_') ? 'private' : 'public';
}

function packagesOf(modules: PyModule[]): string[] {
  return [...new Set(modules.map((m) => m.module.split('.')[0]!))].sort();
}

export function newRunId(): string {
  return `idx-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
}
