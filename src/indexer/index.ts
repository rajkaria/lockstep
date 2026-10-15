import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import { ensureSchema } from '../graph/schema.js';
import { dependencyEdges, type DependsOn } from './deps.js';
import { readDocs, writeDocs, type DocsIndexReport } from './docs.js';
import { trackedOrWalked } from './files.js';
import type { MdDoc } from './markdown.js';
import { extractPython, type PyModule } from './python.js';
import { classifyFile, moduleNames, type Checkout, type FileKind } from './repo.js';
import { symbolId, SymbolTable } from './resolve.js';
import { fileId, writeBatched } from './write.js';

export { fileId, writeBatched };

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
  docs: DocsIndexReport[];
  dependsOn: DependsOn[];
  ms: number;
}

export interface ParsedRepo {
  checkout: Checkout;
  files: { path: string; kind: FileKind }[];
  modules: PyModule[];
  parseErrors: string[];
}

/** All indexable files of a checkout (git-tracked when it is a git repo, else a directory walk). */
export async function listFiles(dir: string): Promise<{ path: string; kind: FileKind }[]> {
  const paths = await trackedOrWalked(dir);
  return paths.flatMap((path) => {
    const kind = classifyFile(path);
    return kind ? [{ path, kind }] : [];
  });
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

/**
 * Index an organisation: every repository's code, then every repository's docs
 * (Markdown/MDX pages and example scripts) linked against the whole org's symbols,
 * then repository dependencies. Re-running is idempotent.
 */
export async function indexOrg(
  graph: OrgGraph,
  checkouts: Checkout[],
  onProgress: (p: IndexProgress) => void = () => {},
): Promise<IndexReport> {
  const started = Date.now();
  const run = newRunId();
  const parsed: ParsedRepo[] = [];
  for (const c of checkouts) {
    onProgress({ phase: 'parse', repo: c.repo, message: `parsing ${c.repo}@${c.sha.slice(0, 7)}` });
    parsed.push(await parseRepo(c));
  }
  const table = buildSymbolTable(parsed);
  const repos = await writeCode(graph, parsed, table, run, onProgress);
  const codeRepos = new Set(parsed.filter((p) => p.modules.length > 0).map((p) => p.checkout.repo));
  const docs: DocsIndexReport[] = [];
  const docsByRepo = new Map<string, MdDoc[]>();
  for (const p of parsed) {
    if (!p.files.some((f) => f.kind === 'markdown' || f.kind === 'python-example')) continue;
    onProgress({ phase: 'docs', repo: p.checkout.repo, message: 'linking docs to code' });
    docs.push(await writeDocs(graph, p, table, run, codeRepos));
    docsByRepo.set(p.checkout.repo, await readDocs(p));
  }
  const dependsOn = await dependencyEdges(parsed, docsByRepo, table.packageRepos);
  await writeBatched(graph, Q.upsertDependsOn, dependsOn);
  onProgress({ phase: 'done', message: `indexed ${parsed.length} repositories` });
  return { org: graph.name, run, repos, docs, dependsOn, ms: Date.now() - started };
}
