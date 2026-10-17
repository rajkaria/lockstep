import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { structuredPatch } from 'diff';
import { z } from 'zod';
import * as Q from '../graph/queries.js';
import type { OrgGraph } from '../graph/client.js';
import { git, parseRepoName } from '../indexer/repo.js';
import { symbolId } from '../indexer/resolve.js';
import { countMatches, groupImpact, shellQuote, type ClearedSymbol, type ImpactData, type ImpactRow, type Severity } from '../tools/graph-tools.js';
import { result, Tracer, type ToolContext, type ToolDef } from '../tools/types.js';
import { prFindingsSummary, type PrFindings } from '../agent/graph-check.js';
import { diffResults, lintNew } from '../lint/diff.js';
import { commitTree, lintTree, overlayTree } from '../lint/sources.js';
import { diffWith, parseHunks, parseNameStatus, type ChangedFile, type DiffSource, type Hunks, type PrDiff } from './changes.js';
import { knownMismatches, predictBreaksForChanges, type ChangeRow } from './predict.js';

/** The "after" side of a diff that is not a commit: the files on disk, or the files an editor sent. */
export const WORKTREE = 'WORKTREE';

/** Changed lines between two texts, the way `git diff -U0` reports them. */
export function textHunks(before: string, after: string): Hunks {
  const h: Hunks = { old: [], new: [] };
  for (const hunk of structuredPatch('a', 'b', before, after, '', '', { context: 0 }).hunks) {
    let o = hunk.oldStart;
    let n = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith('-')) h.old.push([o, o]), o++;
      else if (line.startsWith('+')) h.new.push([n, n]), n++;
      else if (!line.startsWith('\\')) o++, n++;
    }
  }
  return h;
}

/** A git checkout's working tree (staged, unstaged and untracked files) against a base commit. */
export function worktreeSource(dir: string): DiffSource {
  const untracked = async () => (await git(dir, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  return {
    async changedFiles(before) {
      const tracked = parseNameStatus(await git(dir, ['diff', '--name-status', '-M', '-z', before]));
      const added = (await untracked()).map((path): ChangedFile => ({ status: 'A', path }));
      return [...tracked, ...added];
    },
    async files(sha) {
      if (sha !== WORKTREE) return (await git(dir, ['ls-tree', '-r', '--name-only', sha])).split('\n').filter(Boolean);
      const listed = (await git(dir, ['ls-files', '--cached', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
      return listed.filter((p) => existsSync(join(dir, p)));
    },
    async read(sha, path) {
      if (sha === WORKTREE) return existsSync(join(dir, path)) ? readFile(join(dir, path), 'utf8') : undefined;
      try {
        return await git(dir, ['show', `${sha}:${path}`]);
      } catch {
        return undefined;
      }
    },
    async hunks(before, _after, oldPath, path) {
      return parseHunks(await git(dir, ['diff', '-U0', before, '--', oldPath, path]));
    },
  };
}

/**
 * Files an editor or agent sent (new contents; `null` deletes) against a base commit read
 * through `readBase`. What the hosted MCP server checks: no clone, no commit, no push.
 */
export function contentSource(baseFiles: string[], files: { path: string; content: string | null }[], readBase: (path: string) => Promise<string | undefined>): DiffSource {
  const byPath = new Map(files.map((f) => [f.path.replace(/^\.?\//, ''), f.content]));
  const inBase = new Set(baseFiles);
  return {
    async changedFiles() {
      return [...byPath].map(([path, content]): ChangedFile => ({ status: content === null ? 'D' : inBase.has(path) ? 'M' : 'A', path }));
    },
    async files(sha) {
      if (sha !== WORKTREE) return baseFiles;
      const out = new Set(baseFiles);
      for (const [path, content] of byPath) content === null ? out.delete(path) : out.add(path);
      return [...out];
    },
    async read(sha, path) {
      if (sha === WORKTREE && byPath.has(path)) return byPath.get(path) ?? undefined;
      return readBase(path);
    },
    async hunks(_before, _after, oldPath, path) {
      const before = await readBase(oldPath);
      const after = byPath.get(path);
      return before !== undefined && typeof after === 'string' ? textHunks(before, after) : undefined;
    },
  };
}

/** `owner/name` of a checkout's `origin` remote on GitHub. */
export async function repoOfCheckout(dir: string): Promise<string> {
  const url = (await git(dir, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new Error(`cannot tell which GitHub repository ${dir} is (origin: ${url || 'none'}); pass --repo owner/name`);
  return `${m[1]}/${m[2]}`;
}

/** Where the working tree's changes start: the merge base with the remote default branch, else HEAD. */
export async function defaultBase(dir: string): Promise<string> {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    try {
      return (await git(dir, ['merge-base', 'HEAD', ref])).trim();
    } catch {
      // try the next one
    }
  }
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

export interface LocalChanges {
  repo: string;
  base: string;
  branch: string;
  diff: PrDiff;
  /** The top of the checkout. */
  root: string;
}

/** The symbol-level diff of a checkout's working tree (and its unpushed commits) against a base. */
export async function localChanges(dir: string, opts: { base?: string; repo?: string } = {}): Promise<LocalChanges> {
  const root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  const repo = opts.repo ? parseRepoName(opts.repo) : await repoOfCheckout(root);
  const base = opts.base ? (await git(root, ['rev-parse', opts.base])).trim() : await defaultBase(root);
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim();
  const diff = await diffWith(worktreeSource(root), repo, base, WORKTREE);
  return { repo, base, branch, diff, root };
}

export interface ChangesReport {
  impact: ImpactData;
  cleared: ClearedSymbol[];
  /** Docs references the changes make wrong: lint at the base commit and with the changes (`head` is `WORKTREE`). */
  newFindings?: PrFindings;
  /** Why the docs references could not be checked, when they could not. */
  newFindingsError?: string;
}

const COMMIT = /^[0-9a-f]{40}$/;
/** Examples are the graph's part (predicted breaks); lint adds every other reference. */
const LINT = { examples: false } as const;

/** Docs references a checkout's working tree makes wrong against a base commit (`lint --new`). */
export async function worktreeFindings(local: Pick<LocalChanges, 'root' | 'repo' | 'base'>): Promise<PrFindings> {
  const started = Date.now();
  const d = await lintNew({ dir: local.root, repo: local.repo, base: local.base, ...LINT });
  return { repo: local.repo, base: d.base.sha ?? local.base, head: WORKTREE, findings: d.findings, total: d.findings.length, fixed: d.fixed, summary: d.summary, files: d.summary.files, ms: Date.now() - started };
}

/**
 * Docs references edited files make wrong: the base commit (a local clone, else its tarball)
 * linted as it is and with the files replaced. Undefined when the base is not a commit.
 */
export async function editedFindings(
  ctx: ToolContext,
  repo: string,
  sha: string,
  files: { path: string; content: string | null }[],
  clone?: string,
): Promise<PrFindings | undefined> {
  if (!COMMIT.test(sha)) return undefined;
  const started = Date.now();
  const base = await commitTree(repo, sha, { home: ctx.config.home, clone, token: ctx.allowDir ? ctx.config.githubToken : undefined });
  try {
    const head = await overlayTree(base, files);
    try {
      const b = await lintTree(base, { ...LINT, repo });
      const h = await lintTree(head, { ...LINT, repo, sha });
      const d = diffResults(b, h, { base: { ref: sha, sha, label: sha.slice(0, 7) }, head: { label: head.label } });
      return { repo, base: sha, head: WORKTREE, findings: d.findings, total: d.findings.length, fixed: d.fixed, summary: d.summary, files: d.summary.files, ms: Date.now() - started };
    } finally {
      await head.dispose();
    }
  } finally {
    await base.dispose();
  }
}

/**
 * Impact, predicted breaks and clearance for changes that are not a pull request: nothing
 * is written to the graph (the walk starts from the changed symbols themselves).
 */
export async function analyzeChanges(
  graph: OrgGraph,
  home: string,
  repo: string,
  diff: PrDiff,
  label: { url: string; title: string },
  tracer = new Tracer(graph),
): Promise<{ data: ChangesReport; summary: string; tracer: Tracer }> {
  const canonical = (await tracer.run<{ name: string }>(`MATCH (r:Repo) WHERE toLower(r.name) = toLower($name) RETURN r.name AS name`, { name: repo })).rows[0]?.name;
  if (!canonical) throw new Error(`${repo} is not indexed in the "${graph.name}" graph: staleproof index ${repo}`);
  const changes: ChangeRow[] = diff.symbols.map((c) => ({
    id: symbolId(canonical, c.change === 'export-removed' && c.exportTarget ? c.exportTarget : c.qualname),
    kind: c.change,
    before: c.before ?? '',
    after: c.after ?? '',
    renamed_to: c.renamedTo ?? '',
  }));
  const rows = changes.length ? (await tracer.run<ImpactRow>(Q.impactOfChanges, { changes })).rows : [];
  const sections = groupImpact(rows);
  for (const s of sections) s.crossRepo = s.repo !== canonical;
  const counts = { breaking: 0, api: 0, behavior: 0 } as Record<Severity, number>;
  for (const s of sections) counts[s.severity]++;
  const predicted = await predictBreaksForChanges(tracer, changes);
  const mismatched = await knownMismatches(tracer, [...new Set(sections.flatMap((s) => s.examples))]);

  const clearedRows = changes.length
    ? (await tracer.run<Omit<ClearedSymbol, 'textMatches' | 'grep'>>(Q.clearanceOfChanges, { changes })).rows
    : [];
  const docsRepos = (await tracer.run<{ name: string }>(`MATCH (d:DocSection) RETURN DISTINCT d.repo AS name`)).rows.map((r) => r.name);
  const cleared: ClearedSymbol[] = [];
  for (const r of clearedRows) {
    let textMatches = 0;
    for (const d of docsRepos) {
      const dir = join(home, 'repos', ...d.split('/'));
      if (existsSync(dir)) textMatches += await countMatches(dir, r.name);
    }
    cleared.push({ ...r, textMatches, grep: `git grep -nw ${shellQuote(r.name)} -- '*.md' '*.mdx' '*.rst'` });
  }

  const impact: ImpactData = {
    pr: { url: label.url, title: label.title, repo: canonical, state: 'local', before: diff.before, after: diff.after, docsTouched: diff.docsTouched },
    changed: diff.symbols.map((c) => ({ symbol: c.qualname, change: c.change, before: c.before, after: c.after, renamedTo: c.renamedTo })),
    sections,
    totalSections: sections.length,
    offset: 0,
    truncated: false,
    counts,
    predicted,
    mismatched,
  };
  const changedCount = changes.filter((c) => c.kind !== 'added').length;
  const examples = new Set(predicted.map((p) => p.example)).size;
  const summary =
    diff.symbols.length === 0
      ? `These changes touch no Python, TypeScript or JavaScript symbol in ${canonical}; no docs can be falsified through the code.`
      : `${changedCount} changed symbol${changedCount === 1 ? '' : 's'} reach${changedCount === 1 ? 'es' : ''} ${sections.length} doc section${sections.length === 1 ? '' : 's'} ` +
        `(${counts.breaking} breaking, ${counts.api} signature, ${counts.behavior} behavior; ${sections.filter((s) => s.crossRepo).length} in other repositories).` +
        (examples ? ` ${examples} example${examples === 1 ? ' is' : 's are'} predicted to break, the call no longer fitting the changed code.` : '') +
        (cleared.length ? ` ${cleared.length} changed symbol${cleared.length === 1 ? '' : 's'} reach${cleared.length === 1 ? 'es' : ''} no doc.` : '');
  return { data: { impact, cleared }, summary, tracer };
}

/** Python files at the indexed commit, from the graph's File nodes (no GitHub call). */
async function indexedFiles(graph: OrgGraph, repo: string): Promise<string[]> {
  return (await graph.run<{ path: string }>(`MATCH (f:File {repo: $repo}) RETURN f.path AS path`, { repo })).rows.map((r) => r.path);
}

/** Read a file of a public repository at a commit (raw.githubusercontent.com, not rate-limited like the API). */
export function rawReader(repo: string, sha: string, token?: string, fetchImpl: typeof fetch = fetch): (path: string) => Promise<string | undefined> {
  return async (path) => {
    const res = await fetchImpl(`https://raw.githubusercontent.com/${repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { 'User-Agent': 'staleproof', ...(token ? { Authorization: `token ${token}` } : {}) },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GitHub raw ${path}@${sha.slice(0, 7)} failed: ${res.status}`);
    return res.text();
  };
}

/**
 * MCP: which docs do these edits make false, before there is a commit? An editor or agent
 * sends the new contents of the files it changed; the base is the commit the graph indexed.
 * On a local server (stdio) it can instead read a checkout's working tree.
 */
export const checkChangesTool: ToolDef<
  { repo?: string; files?: { path: string; content: string | null }[]; dir?: string; base?: string },
  ChangesReport
> = {
  name: 'check_changes',
  description:
    'Check edits that are not a pull request yet: which doc sections and examples they can make false (with the evidence path), which examples are predicted to break ' +
    '(their calls no longer fit the changed code), and which changed symbols no doc reaches. Send the new contents of the changed files ' +
    '(content null deletes a file); they are compared with the commit the graph indexed. Nothing is written to the graph. ' +
    'On a local server, pass dir (a git checkout) instead of files to check its working tree.',
  input: z.object({
    repo: z.string().optional().describe('owner/name of the repository the files belong to (needed with files)'),
    files: z
      .array(z.object({ path: z.string().min(1), content: z.string().nullable() }))
      .max(50)
      .optional()
      .describe('Changed files: repository-relative path and full new content (null when deleted)'),
    dir: z.string().optional().describe('Local servers only: a git checkout whose working tree to check (default: the server\'s directory)'),
    base: z.string().optional().describe('With dir: the commit or ref to compare against (default: merge base with the remote default branch)'),
  }),
  queries: [Q.impactOfChanges, Q.predictedCallsOfChanges, Q.clearanceOfChanges, Q.mismatchesFor],
  async run(ctx: ToolContext, input) {
    const tracer = new Tracer(ctx.graph);
    let repo: string;
    let diff: PrDiff;
    let label: { url: string; title: string };
    let findings: () => Promise<PrFindings | undefined>;
    if (input.files) {
      if (!input.repo) throw new Error('repo (owner/name) is required with files');
      repo = (await tracer.run<{ name: string }>(`MATCH (r:Repo) WHERE toLower(r.name) = toLower($name) RETURN r.name AS name`, { name: parseRepoName(input.repo) })).rows[0]?.name ?? parseRepoName(input.repo);
      const sha = input.base ?? (await tracer.run<{ sha: string }>(`MATCH (r:Repo {name: $name}) RETURN r.sha AS sha`, { name: repo })).rows[0]?.sha;
      if (!sha) throw new Error(`${repo} is not indexed in the "${ctx.graph.name}" graph`);
      const clone = ctx.checkouts?.[repo] ?? join(ctx.config.home, 'repos', ...repo.split('/'));
      const readBase = existsSync(join(clone, '.git'))
        ? (path: string) => git(clone, ['show', `${sha}:${path}`]).catch(() => undefined)
        : rawReader(repo, sha, ctx.config.githubToken);
      diff = await diffWith(contentSource(await indexedFiles(ctx.graph, repo), input.files, readBase), repo, sha, WORKTREE);
      label = { url: `https://github.com/${repo}/tree/${sha}`, title: `${input.files.length} edited file${input.files.length === 1 ? '' : 's'} on ${repo}@${sha.slice(0, 7)}` };
      const edited = input.files;
      findings = () => editedFindings(ctx, repo, sha, edited, existsSync(join(clone, '.git')) ? clone : undefined);
    } else {
      if (!ctx.allowDir) throw new Error('send the changed files: files: [{path, content}] with repo (this server cannot read your disk)');
      const local = await localChanges(input.dir ?? process.cwd(), { base: input.base, repo: input.repo });
      repo = local.repo;
      diff = local.diff;
      label = { url: `https://github.com/${repo}/compare/${local.base}...${local.branch}`, title: `Working tree of ${local.branch} against ${local.base.slice(0, 7)}` };
      findings = () => worktreeFindings(local);
    }
    const r = await analyzeChanges(ctx.graph, ctx.config.home, repo, diff, label, tracer);
    // Docs references the edits make wrong (graph-free), next to what the graph says they reach.
    let summary = r.summary;
    try {
      const nf = await findings();
      if (nf) r.data.newFindings = nf;
      if (nf?.total) summary += ` ${prFindingsSummary(nf, 'These changes')}`;
    } catch (err) {
      r.data.newFindingsError = (err as Error).message;
    }
    return result('check_changes', tracer, summary, r.data);
  },
};
