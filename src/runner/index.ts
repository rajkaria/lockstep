import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import { scanDoc } from '../indexer/markdown.js';
import { checkoutRepo, git, gitAvailable } from '../indexer/repo.js';
import { githubSource } from '../pr/github-diff.js';
import { JS_LANGS } from '../indexer/docs.js';
import { BuildSkipped, ensureNodeEnv, importedPackages, isJsFragmentFailure, jsErrorLine, jsSandboxAvailable, jsTraceback, prepareJsExample, runJsInSandbox } from './js.js';
import { errorLine, extractTraceback, isFragmentFailure, prepareExample, type ExampleSource, type PreparedExample } from './prepare.js';
import { ensureVenv, runInSandbox, sandboxAvailable, type InstallTarget } from './sandbox.js';
import { ensureScratchDb, flushScratchDb } from './scratch.js';

export type RunStatus = 'pass' | 'fail' | 'timeout' | 'skipped' | 'error';

export interface RunRecord {
  id: string;
  example: string;
  status: RunStatus;
  reason?: string;
  /** Last line of the traceback, e.g. `AttributeError: ...`. */
  error?: string;
  traceback?: string;
  stdout: string;
  durationMs: number;
  stitched: string[];
  /** `repo@sha` for every installed repository. */
  installed: string[];
  side: 'before' | 'after' | 'current';
  cached: boolean;
  createdAt: number;
}

export interface ExampleForRun extends ExampleSource {
  repo: string;
  path: string;
  url: string;
  /** Marked in the docs (or the repository's config) as not to be run. */
  directive?: string | null;
  usedRepos: string[];
  earlier: ExampleSource[];
}

/** One run at a time: the scratch database is shared and flushed per run. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

export async function loadExample(graph: OrgGraph, id: string): Promise<ExampleForRun | undefined> {
  const r = await graph.run<ExampleForRun>(Q.exampleForRun, { id });
  const row = r.rows[0];
  if (!row) return undefined;
  row.earlier = (row.earlier ?? []).filter(Boolean);
  return row;
}

/** Repositories to install for an example: the ones it uses (+ the PR's), and their in-org dependencies. */
export async function installSet(graph: OrgGraph, repos: string[]): Promise<{ repo: string; sha: string }[]> {
  const r = await graph.run<{ repo: string; sha: string }>(Q.installSet, { repos });
  return r.rows;
}

export interface RunOptions {
  /** Override the commit of specific repositories (the PR's before/after). */
  shas?: Record<string, string>;
  side?: RunRecord['side'];
  prUrl?: string;
  /** Re-run even if an identical run is recorded. */
  fresh?: boolean;
  /** Local clones to install from instead of `<home>/repos/<owner>/<name>` (tests, offline use). */
  checkouts?: Record<string, string>;
  log?: (m: string) => void;
}

/**
 * Run a docs code example in the sandbox against the given commits and record a
 * Run node. Identical runs (same program, same commits) are answered from the graph.
 */
export async function runExample(graph: OrgGraph, config: Config, example: ExampleForRun, repos: { repo: string; sha: string }[], opts: RunOptions = {}): Promise<RunRecord> {
  // JavaScript/TypeScript examples run in a Node sandbox (src/runner/js.ts); everything else is Python's.
  const js = JS_LANGS.has(example.lang);
  const prepared = js ? prepareJsExample(example, example.earlier) : prepareExample(example, example.earlier);
  const targets = repos.map((r) => ({ repo: r.repo, sha: opts.shas?.[r.repo] ?? r.sha }));
  const installed = targets.map((t) => `${t.repo}@${t.sha}`).sort();
  const key = createHash('sha1').update(JSON.stringify({ code: prepared.code, installed, skip: prepared.skip ?? '' })).digest('hex').slice(0, 20);
  const side = opts.side ?? 'current';

  if (!opts.fresh) {
    const prev = (await graph.run<{ props: Record<string, unknown> }>(Q.cachedRun, { key })).rows[0];
    if (prev && prev.props.status !== 'error') {
      const record = fromProps(prev.props, side);
      await linkRunToPr(graph, record.id, opts.prUrl);
      return { ...record, cached: true };
    }
  }

  const base = { example: example.id, stitched: prepared.stitched, installed, side, cached: false, createdAt: Date.now() };
  let record: RunRecord;
  if (prepared.skip) {
    record = { id: `run-${key}`, ...base, status: 'skipped', reason: prepared.skip, stdout: '', durationMs: 0 };
  } else if (!(await (js ? jsSandboxAvailable() : sandboxAvailable()))) {
    // Not recorded: another host with a sandbox can still run it.
    return {
      id: `run-${key}-unavailable`,
      ...base,
      status: 'skipped',
      reason: `this deployment cannot execute examples (no git/${js ? 'npm' : 'uv'} sandbox runtime); runs recorded by other Staleproof hosts are answered from the graph`,
      stdout: '',
      durationMs: 0,
    };
  } else if (targets.length === 0) {
    record = { id: `run-${key}`, ...base, status: 'skipped', reason: 'uses no symbol from an indexed repository', stdout: '', durationMs: 0 };
  } else {
    record = await serial(async () => {
      try {
        const install: InstallTarget[] = [];
        for (const t of targets) {
          install.push({ ...t, dir: opts.checkouts?.[t.repo] ?? (await checkoutRepo(config.home, t.repo)).dir });
        }
        if (js) return await runJs(config, example, prepared, install, { id: `run-${key}`, ...base }, opts.log);
        const python = await ensureVenv(config.home, install, opts.log);
        await ensureScratchDb(config);
        await flushScratchDb(config);
        opts.log?.(`running ${example.id} against ${installed.join(', ')}`);
        const r = await runInSandbox(python, prepared.code, { scratchPort: config.scratch.port, scratchHost: config.scratch.host, timeoutMs: config.runTimeoutMs });
        const traceback = extractTraceback(r.stderr);
        if (r.timedOut) {
          return { id: `run-${key}`, ...base, status: 'timeout', reason: `no exit after ${config.runTimeoutMs / 1000}s`, stdout: tail(r.stdout), durationMs: r.durationMs };
        }
        if (r.code === 0) return { id: `run-${key}`, ...base, status: 'pass', stdout: tail(r.stdout), durationMs: r.durationMs };
        if (isFragmentFailure(prepared.code, traceback)) {
          return {
            id: `run-${key}`,
            ...base,
            status: 'skipped',
            reason: `fragment: ${errorLine(traceback)} (the page never defines it)`,
            traceback,
            stdout: tail(r.stdout),
            durationMs: r.durationMs,
          };
        }
        return {
          id: `run-${key}`,
          ...base,
          status: 'fail',
          error: errorLine(traceback) ?? r.stderr.trim().split('\n').pop(),
          traceback: traceback ?? tail(r.stderr),
          stdout: tail(r.stdout),
          durationMs: r.durationMs,
        };
      } catch (err) {
        return { id: `run-${key}-err-${Date.now()}`, ...base, status: 'error', reason: (err as Error).message.slice(0, 2000), stdout: '', durationMs: 0 };
      }
    });
  }
  await graph.run(Q.upsertRun, {
    id: record.id,
    example: example.id,
    props: {
      id: record.id,
      // A build that failed is recorded, never answered from: the lookup by key does not find it.
      key: record.id.includes('-build-') ? `build:${key}` : key,
      example: example.id,
      status: record.status,
      reason: record.reason ?? '',
      error: record.error ?? '',
      traceback: record.traceback ?? '',
      stdout: record.stdout,
      duration_ms: record.durationMs,
      stitched: record.stitched,
      installed: record.installed,
      side: record.side,
      created_at: record.createdAt,
    },
  });
  await linkRunToPr(graph, record.id, opts.prUrl);
  return record;
}

/**
 * One JS/TS run: build (or reuse) the Node sandbox, run, and read Node's verdict. A package
 * that does not build is `skipped` with the reason; a ReferenceError on a name the page
 * never defines is a fragment, also skipped.
 */
async function runJs(
  config: Config,
  example: ExampleForRun,
  prepared: PreparedExample,
  install: InstallTarget[],
  base: Omit<RunRecord, 'status' | 'stdout' | 'durationMs'>,
  log?: (m: string) => void,
): Promise<RunRecord> {
  let env;
  try {
    env = await ensureNodeEnv(config.home, install, importedPackages(prepared.code), log);
  } catch (err) {
    // A unique id: the next request builds again (a registry outage must not be remembered as the docs' state).
    if (err instanceof BuildSkipped) return { ...base, id: `${base.id}-build-${Date.now()}`, status: 'skipped', reason: err.message.slice(0, 2000), stdout: '', durationMs: 0 };
    throw err;
  }
  await ensureScratchDb(config);
  await flushScratchDb(config);
  log?.(`running ${example.id} against ${base.installed.join(', ')}`);
  let r;
  try {
    r = await runJsInSandbox(env, prepared.code, prepared.lang ?? example.lang, { scratchPort: config.scratch.port, scratchHost: config.scratch.host, timeoutMs: config.runTimeoutMs });
  } catch (err) {
    if (err instanceof BuildSkipped) return { ...base, status: 'skipped', reason: err.message, stdout: '', durationMs: 0 };
    throw err;
  }
  if (r.timedOut) return { ...base, status: 'timeout', reason: `no exit after ${config.runTimeoutMs / 1000}s`, stdout: tail(r.stdout), durationMs: r.durationMs };
  if (r.code === 0) return { ...base, status: 'pass', stdout: tail(r.stdout), durationMs: r.durationMs };
  const traceback = jsTraceback(r.stderr);
  if (isJsFragmentFailure(prepared.code, r.stderr)) {
    return { ...base, status: 'skipped', reason: `fragment: ${jsErrorLine(r.stderr)} (the page never defines it)`, traceback, stdout: tail(r.stdout), durationMs: r.durationMs };
  }
  return { ...base, status: 'fail', error: jsErrorLine(r.stderr), traceback: traceback ? tail(traceback) : undefined, stdout: tail(r.stdout), durationMs: r.durationMs };
}

async function linkRunToPr(graph: OrgGraph, id: string, prUrl: string | undefined): Promise<void> {
  if (prUrl) await graph.run(Q.linkRunToPr, { id, pr: prUrl });
}

function fromProps(p: Record<string, unknown>, side: RunRecord['side']): RunRecord {
  return {
    id: String(p.id),
    example: String(p.example),
    status: p.status as RunStatus,
    reason: (p.reason as string) || undefined,
    error: (p.error as string) || undefined,
    traceback: (p.traceback as string) || undefined,
    stdout: String(p.stdout ?? ''),
    durationMs: Number(p.duration_ms ?? 0),
    stitched: (p.stitched as string[]) ?? [],
    installed: (p.installed as string[]) ?? [],
    side,
    cached: true,
    createdAt: Number(p.created_at ?? 0),
  };
}

function tail(s: string, n = 4000): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

export function venvRoot(config: Config): string {
  return join(config.home, 'venvs');
}

/** Record a run that could not happen (the example is gone at that commit), so reports see both sides. */
export async function recordSkippedRun(graph: OrgGraph, exampleId: string, side: RunRecord['side'], reason: string, at: string, prUrl?: string): Promise<RunRecord> {
  const key = createHash('sha1').update(JSON.stringify({ example: exampleId, at, skip: reason })).digest('hex').slice(0, 20);
  const record: RunRecord = { id: `run-${key}`, example: exampleId, status: 'skipped', reason, stdout: '', durationMs: 0, stitched: [], installed: [], side, cached: false, createdAt: Date.now() };
  await graph.run(Q.upsertRun, {
    id: record.id,
    example: exampleId,
    props: { id: record.id, key, example: exampleId, status: 'skipped', reason, error: '', traceback: '', stdout: '', duration_ms: 0, stitched: [], installed: [], side, created_at: record.createdAt },
  });
  await linkRunToPr(graph, record.id, prUrl);
  return record;
}

/**
 * A file of `repo` at `sha` (undefined when the commit has no such file): from the local
 * clone when git is here, else raw.githubusercontent.com. Throws when the commit is unknown.
 */
export async function readFileAt(config: Config, repo: string, sha: string, path: string, clone?: string): Promise<string | undefined> {
  if (clone || (await gitAvailable())) {
    const dir = clone ?? (await checkoutRepo(config.home, repo)).dir;
    // A commit the clone doesn't have is an error, not a missing file.
    await git(dir, ['cat-file', '-e', `${sha}^{commit}`]);
    try {
      return await git(dir, ['show', `${sha}:${path}`]);
    } catch {
      return undefined;
    }
  }
  return githubSource(repo, { token: config.githubToken }).read(sha, path);
}

/**
 * The example as the page reads at `sha` (a pull request that edits the page): found by
 * its section and position in that section, else by its position on the page. `null`
 * when the page at `sha` no longer has it; undefined when the page can't be read.
 */
export async function exampleAtCommit(config: Config, example: ExampleForRun, indexedSha: string, sha: string, clone?: string): Promise<ExampleForRun | null | undefined> {
  let then: string | undefined;
  let now: string | undefined;
  try {
    [then, now] = await Promise.all([readFileAt(config, example.repo, indexedSha, example.path, clone), readFileAt(config, example.repo, sha, example.path, clone)]);
  } catch {
    return undefined;
  }
  if (now === undefined) return then === undefined ? undefined : null;
  if (then === undefined) return undefined;
  const index = Number(example.id.split(':').at(-1));
  const before = scanDoc(example.path, then).examples;
  const after = scanDoc(example.path, now).examples;
  const orig = before.find((e) => e.index === index);
  if (!orig) return undefined;
  const nth = before.filter((e) => e.sectionAnchor === orig.sectionAnchor).indexOf(orig);
  const match = after.filter((e) => e.sectionAnchor === orig.sectionAnchor)[nth] ?? (after.length === before.length ? after.find((e) => e.index === index) : undefined);
  if (!match) return null;
  return {
    ...example,
    lang: match.lang,
    code: match.code,
    earlier: after.filter((e) => e.index < match.index).map((e) => ({ id: `${example.repo}:${example.path}:${e.index}`, lang: e.lang, code: e.code })),
  };
}
