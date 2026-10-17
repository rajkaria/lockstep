import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeLinkedFiles } from '../lint/fix-command.js';
import { applyFixes, addFixes, type AddFixesOptions } from '../lint/fixes.js';
import { checkoutRepo, gitAvailable } from '../indexer/repo.js';
import { lintTree, tarballTree, worktreeTree, type LintTree } from '../lint/sources.js';
import type { LintOptions } from '../lint/engine.js';
import type { Finding, LintResult } from '../lint/types.js';
import { githubJson, type GitHubOptions } from './github.js';

/**
 * Renovate for docs (spec R3.5): at the default branch, apply every verified fix, keep one
 * branch `staleproof/fix-docs` (rebuilt from the default branch each run) and one pull
 * request "Staleproof: fix N stale docs references"; close it when nothing is left. Uses
 * only the Git Data and Pulls APIs with a token, so the Action (GITHUB_TOKEN with
 * `contents: write`, `pull-requests: write`) and the GitHub App's cron share it. It writes
 * no ref outside `staleproof/*` and never touches another branch.
 */

export const FIX_BRANCH = 'staleproof/fix-docs';
/** Hidden in the pull request body: how a later run finds the pull request it opened. */
export const FIX_PR_MARKER = '<!-- staleproof:fix-docs -->';

export interface FixPrClient extends GitHubOptions {
  token: string;
}

export interface FixPrOptions {
  /** `owner/name`. */
  repo: string;
  /** The repository at the default branch head, as linted (a clone's working tree, or an archive extraction). */
  tree: LintTree;
  /** Its lint result (default: linted here). */
  result?: LintResult;
  /** Default `staleproof/fix-docs`; must start with `staleproof/`. */
  branch?: string;
  /** How to lint (and verify fixes). */
  lint?: Omit<LintOptions, 'dir' | 'paths' | 'rules' | 'files'>;
  /** Passed to `addFixes` (a parse cache, rules). */
  fixes?: Omit<AddFixesOptions, 'lint' | 'baseTree'>;
  /** Plan only: report what would change, call no write endpoint. */
  dryRun?: boolean;
}

export interface FixPrResult {
  /** `declined`: someone closed the pull request carrying these same fixes, so it is not opened again. */
  action: 'opened' | 'updated' | 'unchanged' | 'closed' | 'none' | 'declined';
  /** The verified fixes the branch carries. */
  fixes: Finding[];
  files: string[];
  branch: string;
  pr?: { number: number; url: string };
  commit?: string;
  /** The default branch and the commit the fixes are based on. */
  base: { branch: string; sha: string };
}

interface GhPull {
  number: number;
  merged_at?: string | null;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  head: { ref: string; sha: string };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The pull request title for `n` fixes. */
export function fixPrTitle(n: number): string {
  return `Staleproof: fix ${n} stale docs reference${n === 1 ? '' : 's'}`;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** What the fixes change, independent of line numbers: a closed pull request with the same set is not reopened. */
export function fixSetId(fixes: readonly Finding[]): string {
  const parts = fixes.map((f) => `${f.fingerprint}\0${f.fix!.edits.map((e) => `${e.path}\0${e.newText}`).join('\0')}`).sort();
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}

const markerFor = (fixes: readonly Finding[]) => `<!-- staleproof:fix-docs fixes=${fixSetId(fixes)} -->`;

/** The pull request body: a table of the fixes with the evidence for each. */
export function fixPrBody(fixes: readonly Finding[], base: { branch: string; sha: string }): string {
  const rows = fixes.map((f) => {
    const where = f.evidence?.url ? `[\`${f.path}:${f.line}\`](${f.evidence.url})` : `\`${f.path}:${f.line}\``;
    const evidence = f.evidence?.looked ? cell(f.evidence.looked) : '';
    return `| ${where} | \`${f.rule}\` | ${cell(f.message)} | ${cell(f.fix!.description)} | ${evidence} |`;
  });
  const files = new Set(fixes.flatMap((f) => f.fix!.edits.map((e) => e.path)));
  return [
    `${FIX_PR_MARKER}\n${markerFor(fixes)}`,
    `Staleproof found ${plural(fixes.length, 'docs reference')} in ${plural(files.size, 'file')} that no longer match the code at \`${base.branch}\` (${base.sha.slice(0, 7)}), and a fix for each. Every fix was re-checked before it was proposed: applying it clears the finding and adds none.`,
    '',
    '| Where | Rule | What is stale | Fix | Where Staleproof looked |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    `This branch is rebuilt from \`${base.branch}\` on every run, so edits pushed to it are replaced; merge it, or close it to skip these fixes until the next run finds them again. Run \`npx staleproof fix\` to apply the same fixes locally.`,
  ].join('\n');
}

async function fileMode(path: string): Promise<'100644' | '100755'> {
  try {
    return (await stat(path)).mode & 0o111 ? '100755' : '100644';
  } catch {
    return '100644';
  }
}

/**
 * Lint the default branch, apply the verified fixes on `staleproof/fix-docs`, and open,
 * update or close the one fix pull request.
 */
export async function runFixPr(opts: FixPrOptions, client: FixPrClient): Promise<FixPrResult> {
  const branch = opts.branch ?? FIX_BRANCH;
  if (!branch.startsWith('staleproof/') || branch.includes('..') || /\s/.test(branch)) throw new Error(`the fix branch must be under staleproof/ (got ${branch})`);
  const [owner] = opts.repo.split('/') as [string, string];
  const api = `/repos/${opts.repo}`;
  const gh = <T>(path: string, init: RequestInit = {}) => githubJson<T>(path, client, init);
  const send = <T>(path: string, method: string, body: unknown) => gh<T>(path, { method, body: JSON.stringify(body) });

  const info = await gh<{ default_branch: string }>(api);
  const defaultBranch = info.default_branch;
  const head = await gh<{ object: { sha: string } }>(`${api}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  const result = opts.result ?? (await lintTree(opts.tree, { ...opts.lint, repo: opts.repo }));
  // The fixes are computed on the content linted; that commit is the new branch's parent.
  const baseSha = result.sha ?? opts.tree.sha ?? head.object.sha;
  const base = { branch: defaultBranch, sha: baseSha };

  const fixed = await addFixes(result, opts.tree, { ...opts.fixes, ...(opts.lint ? { lint: opts.lint } : {}) });
  const all = fixed.findings.filter((f) => f.fix?.verified);
  const paths = [...new Set(all.flatMap((f) => f.fix!.edits.map((e) => e.path)))];
  const originals = new Map<string, string>();
  for (const p of paths) originals.set(p, await readFile(join(opts.tree.dir, ...p.split('/')), 'utf8'));
  // A link (`CLAUDE.md` → `AGENTS.md`) is committed as the file it points to; it never becomes a copy.
  const merged = await mergeLinkedFiles(opts.tree.dir, applyFixes(originals, all.map((f) => f.fix!)));
  const changed = merged.changed;
  const verified = all.filter((f) => f.fix!.edits.every((e) => !merged.conflicts.includes(e.path)));

  const open = (await gh<GhPull[]>(`${api}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`)).filter((p) => p.head.ref === branch);
  const existing = open[0];
  if (!changed.size) {
    if (existing && !opts.dryRun) {
      await send(`${api}/issues/${existing.number}/comments`, 'POST', { body: `${FIX_PR_MARKER}\nNothing left to fix at \`${defaultBranch}\` (${baseSha.slice(0, 7)}): closing.` });
      await send(`${api}/pulls/${existing.number}`, 'PATCH', { state: 'closed' });
      return { action: 'closed', fixes: [], files: [], branch, pr: { number: existing.number, url: existing.html_url }, base };
    }
    return { action: 'none', fixes: [], files: [], branch, base };
  }

  const files = [...changed.keys()].sort();
  if (!existing) {
    // Someone closed the pull request with exactly these fixes: respect it until the fixes change.
    const closed = await gh<GhPull[]>(`${api}/pulls?state=closed&head=${encodeURIComponent(`${owner}:${branch}`)}&sort=updated&direction=desc&per_page=5`);
    const last = closed.find((p) => p.head.ref === branch);
    if (last && !last.merged_at && (last.body ?? '').includes(markerFor(verified))) {
      return { action: 'declined', fixes: verified, files, branch, pr: { number: last.number, url: last.html_url }, base };
    }
  }
  const title = fixPrTitle(verified.length);
  const body = fixPrBody(verified, base);
  if (opts.dryRun) return { action: existing ? 'updated' : 'opened', fixes: verified, files, branch, ...(existing ? { pr: { number: existing.number, url: existing.html_url } } : {}), base };

  // The tree of the fixed files on top of the base commit's tree.
  const parent = await gh<{ tree: { sha: string } }>(`${api}/git/commits/${baseSha}`);
  const entries = [];
  for (const p of files) {
    const blob = await send<{ sha: string }>(`${api}/git/blobs`, 'POST', { content: changed.get(p)!, encoding: 'utf-8' });
    entries.push({ path: p, mode: await fileMode(join(opts.tree.dir, ...p.split('/'))), type: 'blob', sha: blob.sha });
  }
  const tree = await send<{ sha: string }>(`${api}/git/trees`, 'POST', { base_tree: parent.tree.sha, tree: entries });

  // The branch already holds exactly this change on this base: nothing to push.
  const current = await gh<{ object: { sha: string } }>(`${api}/git/ref/heads/${branch}`).catch((err: Error) => {
    if (/not found|404/.test(err.message)) return undefined;
    throw err;
  });
  let commit = current?.object.sha;
  let same = false;
  if (current) {
    const c = await gh<{ tree: { sha: string }; parents: { sha: string }[] }>(`${api}/git/commits/${current.object.sha}`);
    same = c.tree.sha === tree.sha && c.parents.length === 1 && c.parents[0]!.sha === baseSha;
  }
  if (!same) {
    const made = await send<{ sha: string }>(`${api}/git/commits`, 'POST', {
      message: `${title}\n\n${verified.map((f) => `- ${f.path}:${f.line} ${f.fix!.description}`).join('\n')}`,
      tree: tree.sha,
      parents: [baseSha],
    });
    commit = made.sha;
    if (current) await send(`${api}/git/refs/heads/${branch}`, 'PATCH', { sha: commit, force: true });
    else await send(`${api}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: commit });
  }

  if (existing) {
    if (existing.title !== title || (existing.body ?? '') !== body) await send(`${api}/pulls/${existing.number}`, 'PATCH', { title, body });
    return { action: same && existing.title === title && (existing.body ?? '') === body ? 'unchanged' : 'updated', fixes: verified, files, branch, pr: { number: existing.number, url: existing.html_url }, ...(commit ? { commit } : {}), base };
  }
  const pr = await send<{ number: number; html_url: string }>(`${api}/pulls`, 'POST', { title, head: branch, base: defaultBranch, body });
  return { action: 'opened', fixes: verified, files, branch, pr: { number: pr.number, url: pr.html_url }, ...(commit ? { commit } : {}), base };
}

export interface FixPrCommandOptions {
  /** `owner/name`. */
  repo: string;
  token: string;
  /** Where clones and downloads live (`config.home`). */
  home: string;
  /** A checkout of the default branch to use as it is (the Action's `actions/checkout`); default: clone or download it. */
  dir?: string;
  branch?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  lint?: FixPrOptions['lint'];
}

/** `staleproof fix-pr <owner/name>` and the Action's `mode: fix`: get the default branch, then `runFixPr`. */
export async function runFixPrCommand(opts: FixPrCommandOptions): Promise<FixPrResult & { output: string }> {
  let tree: LintTree;
  if (opts.dir) tree = worktreeTree(opts.dir, opts.repo);
  else if (await gitAvailable()) {
    const c = await checkoutRepo(opts.home, opts.repo);
    tree = { ...worktreeTree(c.dir, opts.repo), sha: c.sha };
  } else tree = await tarballTree(opts.home, opts.repo, 'HEAD', { token: opts.token, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  try {
    const r = await runFixPr(
      { repo: opts.repo, tree, ...(opts.branch ? { branch: opts.branch } : {}), ...(opts.dryRun ? { dryRun: true } : {}), ...(opts.lint ? { lint: opts.lint } : {}) },
      { token: opts.token, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
    );
    const n = r.fixes.length === 1 ? '1 verified fix' : `${r.fixes.length} verified fixes`;
    const where = r.pr ? ` ${r.pr.url}` : '';
    const output = {
      opened: `${opts.dryRun ? 'Would open' : 'Opened'} the fix pull request with ${n} in ${plural(r.files.length, 'file')}:${where || ` ${r.branch}`}`,
      updated: `${opts.dryRun ? 'Would update' : 'Updated'} the fix pull request with ${n} in ${plural(r.files.length, 'file')}:${where}`,
      unchanged: `The fix pull request is up to date (${n}):${where}`,
      closed: `Nothing left to fix at ${r.base.branch}: closed${where}`,
      none: `Nothing to fix at ${r.base.branch} (${r.base.sha.slice(0, 7)}).`,
      declined: `The fix pull request with these ${n} was closed without merging:${where}; not opening it again until the fixes change.`,
    }[r.action];
    return { ...r, output };
  } finally {
    await tree.dispose();
  }
}
