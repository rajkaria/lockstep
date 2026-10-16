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
import { extractTs } from './typescript.js';
import { packageModules, readManifest, relativeResolver, tsModuleNames, type NpmPackage } from './tsmodules.js';
import { classifyFile, moduleNames, type Checkout, type FileKind } from './repo.js';
import { symbolId, SymbolTable } from './resolve.js';
import { fileId, writeBatched } from './write.js';
import { loadRepoConfig, matchesAny, type RepoConfig } from './repo-config.js';

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
  /** `.staleproof.toml` / `[tool.staleproof]`: paths never indexed, examples never run or checked. */
  config?: RepoConfig;
}

/** All indexable files of a checkout (git-tracked when it is a git repo, else a directory walk). */
export async function listFiles(dir: string): Promise<{ path: string; kind: FileKind }[]> {
  const paths = await trackedOrWalked(dir);
  return paths.flatMap((path) => {
    const kind = classifyFile(path);
    return kind ? [{ path, kind }] : [];
  });
}

/** Published npm packages of a checkout (every non-private `package.json` with a name). */
export async function npmPackages(dir: string, paths: string[]): Promise<NpmPackage[]> {
  const out: NpmPackage[] = [];
  for (const path of paths.filter((p) => /(^|\/)package\.json$/.test(p) && !/(^|\/)node_modules\//.test(p))) {
    const pkg = readManifest(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', await readFile(join(dir, path), 'utf8').catch(() => ''));
    if (pkg) out.push(pkg);
  }
  return out;
}

export async function parseRepo(checkout: Checkout): Promise<ParsedRepo> {
  const config = await loadRepoConfig(checkout.dir);
  const all = await trackedOrWalked(checkout.dir);
  const packages = await npmPackages(checkout.dir, all);
  const tsNames = tsModuleNames(all.filter((p) => classifyFile(p) === 'typescript'), packages);
  const files = (await listFiles(checkout.dir))
    .filter((f) => !matchesAny(f.path, config.ignore))
    // TypeScript/JavaScript outside a published package (a docs site, an app, tooling) is not library code.
    .filter((f) => f.kind !== 'typescript' || tsNames.has(f.path));
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
  for (const f of files.filter((x) => x.kind === 'typescript')) {
    const name = tsNames.get(f.path)!;
    try {
      const source = await readFile(join(checkout.dir, f.path), 'utf8');
      modules.push(await extractTs(source, { module: name.module, path: f.path, tsx: !/\.(ts|mts|cts)$/.test(f.path), resolve: relativeResolver(f.path, tsNames) }));
    } catch (err) {
      parseErrors.push(`${f.path}: ${(err as Error).message}`);
    }
  }
  modules.push(...packageModules(packages, tsNames));
  return { checkout, files, modules, parseErrors, config };
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
      props: { name: repo, url: `https://github.com/${repo}`, sha, indexed_at: Date.now(), packages: packagesOf(p.modules), index_version: INDEX_VERSION },
    });
    await writeBatched(
      graph,
      Q.upsertFiles,
      p.files.map((f) => ({ id: fileId(repo, f.path), repo, props: { repo, path: f.path, kind: f.kind } })),
      { run },
    );
    const exported = table.exportedIds(repo, p.modules);
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
          visibility:
            d.decorators.includes('private') || d.decorators.includes('internal') ? 'private' : d.kind === 'method' && d.name === 'constructor' ? 'special' : visibility(d.name),
          decorators: d.decorators,
          exported: exported.has(symbolId(repo, d.qualname)),
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

/**
 * What an index holds, by version: 3 adds MISMATCH edges, `exported` flags, reStructuredText
 * and TypeScript/JavaScript. Hosted workspaces indexed by an older version are re-indexed on
 * next use; the audit says when a graph is older.
 */
export const INDEX_VERSION = 3;

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
    if (!p.files.some((f) => f.kind === 'markdown' || f.kind === 'python-example' || f.kind === 'js-example')) continue;
    onProgress({ phase: 'docs', repo: p.checkout.repo, message: 'linking docs to code' });
    docs.push(await writeDocs(graph, p, table, run, codeRepos));
    docsByRepo.set(p.checkout.repo, await readDocs(p));
  }
  const dependsOn = await dependencyEdges(parsed, docsByRepo, table.packageRepos);
  await writeBatched(graph, Q.upsertDependsOn, dependsOn);
  onProgress({ phase: 'done', message: `indexed ${parsed.length} repositories` });
  return { org: graph.name, run, repos, docs, dependsOn, ms: Date.now() - started };
}
