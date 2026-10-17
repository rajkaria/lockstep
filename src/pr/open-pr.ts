import { applyPatch } from 'diff';
import type { DocsPatch, PatchedFile } from '../patch.js';
import { actionsMayNotOpenPulls, ALLOW_ACTIONS_PULLS, githubJson, type GitHubOptions } from './github.js';

export interface OpenPrOptions extends GitHubOptions {
  token: string;
  /**
   * `fork` (default): the PR is opened inside your fork. `upstream`: from your fork against the original repository.
   * `same-repo`: a branch in the repository itself and a PR there — what a CI token can do (no fork, no user account).
   */
  target: 'fork' | 'upstream' | 'same-repo';
  /** `same-repo`: the branch the PR targets (default: the repository's default branch), e.g. the checked PR's own branch. */
  base?: string;
  /** `same-repo`: only these repositories (a CI token can write to its own repository only); others are skipped. */
  only?: string[];
  /** Poll interval while GitHub creates a fork. */
  pollMs?: number;
  /** Progress and files left out (`same-repo`). */
  log?: (msg: string) => void;
}

export interface OpenedPr {
  repo: string;
  url: string;
  target: OpenPrOptions['target'];
  branch: string;
  /** `same-repo`: files left out because the target branch changed them where the edit applies. */
  skipped?: { path: string; reason: string }[];
}

/**
 * Open the docs fix as a pull request. Default target is the caller's fork, never
 * the upstream repository, unless `target: 'upstream'` is passed explicitly.
 */
export async function openDocsPr(patch: DocsPatch, opts: OpenPrOptions): Promise<OpenedPr[]> {
  if (!opts.token) throw new Error('opening a pull request needs GITHUB_TOKEN');
  if (patch.files.length === 0) throw new Error('the patch is empty: no proposed edits to open a pull request for');
  const gh = <T>(path: string, init: RequestInit = {}) => githubJson<T>(path, opts, init);
  if (opts.target === 'same-repo') return openInRepo(patch, opts, gh);
  const me = await gh<{ login: string }>('/user');
  const opened: OpenedPr[] = [];
  const repos = [...new Set(patch.files.map((f) => f.repo))];
  for (const repo of repos) {
    const files = patch.files.filter((f) => f.repo === repo);
    const [owner, name] = repo.split('/') as [string, string];
    const upstream = await gh<{ default_branch: string }>(`/repos/${owner}/${name}`);
    const fork = await gh<{ full_name: string; default_branch: string }>(`/repos/${owner}/${name}/forks`, {
      method: 'POST',
      body: JSON.stringify({ default_branch_only: true }),
    });
    await waitForRepo(gh, fork.full_name, opts.pollMs ?? 2000);
    // Bring the fork up to date so the base commit exists in it.
    await gh(`/repos/${fork.full_name}/merge-upstream`, { method: 'POST', body: JSON.stringify({ branch: fork.default_branch }) }).catch(() => undefined);
    const branch = `staleproof/${patch.pr.repo.replace('/', '-')}-${patch.pr.number}`;
    const baseSha = files[0]!.sha;
    await gh(`/repos/${fork.full_name}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    }).catch(async (err: Error) => {
      if (!/already exists|422/.test(err.message)) throw err;
      await gh(`/repos/${fork.full_name}/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: baseSha, force: true }) });
    });
    for (const f of files) {
      const current = await gh<{ sha: string }>(`/repos/${fork.full_name}/contents/${encodePath(f.path)}?ref=${encodeURIComponent(branch)}`);
      await gh(`/repos/${fork.full_name}/contents/${encodePath(f.path)}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `docs: update ${f.path} for ${patch.pr.repo}#${patch.pr.number}`,
          content: Buffer.from(f.after, 'utf8').toString('base64'),
          sha: current.sha,
          branch,
        }),
      });
    }
    const target = opts.target === 'upstream' ? `${owner}/${name}` : fork.full_name;
    const pr = await gh<{ html_url: string }>(`/repos/${target}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: patch.title,
        body: patch.body,
        head: opts.target === 'upstream' ? `${me.login}:${branch}` : branch,
        base: opts.target === 'upstream' ? upstream.default_branch : fork.default_branch,
      }),
    });
    opened.push({ repo: target, url: pr.html_url, target: opts.target, branch });
  }
  return opened;
}

type Gh = <T>(path: string, init?: RequestInit) => Promise<T>;

/**
 * A file's edited text on the target branch. The edit was written against the indexed commit
 * (`f.before`); the target branch (a pull request's own branch, or a default branch that moved)
 * may differ. Unchanged: the edited file as it is. Changed elsewhere: the edit applied like
 * `git apply` (its context lines must match). Changed where the edit applies: undefined, so the
 * branch's own changes are never overwritten with the indexed text.
 */
export function rebaseEdit(f: Pick<PatchedFile, 'before' | 'after' | 'diff'>, onBranch: string): string | undefined {
  if (onBranch === f.before) return f.after;
  const merged = applyPatch(onBranch, f.diff);
  return merged === false ? undefined : merged;
}

interface GhContent {
  sha: string;
  content?: string;
  encoding?: string;
}

/** A file's text at a commit (contents API; files over 1 MB through the blob), or undefined when it is not there. */
async function readAt(gh: Gh, repo: string, path: string, ref: string): Promise<{ sha: string; text: string } | undefined> {
  const file = await gh<GhContent>(`/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`).catch((err: Error) => {
    if (/not found|404/i.test(err.message)) return undefined;
    throw err;
  });
  if (!file?.sha) return undefined;
  const b64 = file.encoding === 'base64' && file.content ? file.content : (await gh<GhContent>(`/repos/${repo}/git/blobs/${file.sha}`)).content;
  if (b64 === undefined) return undefined;
  return { sha: file.sha, text: Buffer.from(b64, 'base64').toString('utf8') };
}

/**
 * A branch in each docs repository itself (no fork), its files updated, and a pull request into `base`.
 * Each edit is re-applied to the file as it is on `base`; a file `base` changed where the edit applies is
 * left out (and named in the pull request), and a repository with nothing left gets no pull request.
 */
async function openInRepo(patch: DocsPatch, opts: OpenPrOptions, gh: Gh): Promise<OpenedPr[]> {
  const opened: OpenedPr[] = [];
  const refused: string[] = [];
  const repos = [...new Set(patch.files.map((f) => f.repo))].filter((r) => !opts.only || opts.only.some((o) => o.toLowerCase() === r.toLowerCase()));
  for (const repo of repos) {
    const files = patch.files.filter((f) => f.repo === repo);
    const info = await gh<{ default_branch: string }>(`/repos/${repo}`);
    const base = opts.base ?? info.default_branch;
    const baseSha = (await gh<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`)).object.sha;
    const writes: { path: string; sha: string; text: string }[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const f of files) {
      const at = await readAt(gh, repo, f.path, baseSha);
      const text = at ? rebaseEdit(f, at.text) : undefined;
      if (at && text !== undefined) writes.push({ path: f.path, sha: at.sha, text });
      else skipped.push({ path: f.path, reason: at ? `${base} has other text where the edit applies (the edit was written against ${f.sha.slice(0, 7)})` : `not on ${base}` });
    }
    if (!writes.length) {
      refused.push(`${repo}: ${skipped.map((x) => `${x.path} (${x.reason})`).join(', ')}`);
      opts.log?.(`no pull request in ${repo}: ${skipped.map((x) => `${x.path}: ${x.reason}`).join('; ')}`);
      continue;
    }
    for (const x of skipped) opts.log?.(`left out of the pull request in ${repo}: ${x.path}: ${x.reason}`);
    const branch = `staleproof/docs-${patch.pr.repo.replace('/', '-')}-${patch.pr.number}`;
    await gh(`/repos/${repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }) }).catch(async (err: Error) => {
      if (!/already exists|422/.test(err.message)) throw err;
      await gh(`/repos/${repo}/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: baseSha, force: true }) });
    });
    for (const w of writes) {
      // The branch is at baseSha, so the file's blob there is the one just read.
      await gh(`/repos/${repo}/contents/${encodePath(w.path)}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `docs: update ${w.path} for ${patch.pr.repo}#${patch.pr.number}`,
          content: Buffer.from(w.text, 'utf8').toString('base64'),
          sha: w.sha,
          branch,
        }),
      });
    }
    const body = skipped.length
      ? `${patch.body}\n\n**Not included** (\`${base}\` has other text where these edits apply; check the pull request again for edits that fit it):\n\n${skipped.map((x) => `- \`${x.path}\`: ${x.reason}`).join('\n')}`
      : patch.body;
    const existing = await gh<{ html_url: string }[]>(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}`);
    const pr =
      existing[0] ??
      (await gh<{ html_url: string }>(`/repos/${repo}/pulls`, { method: 'POST', body: JSON.stringify({ title: patch.title, body, head: branch, base }) }).catch((err: Error) => {
        if (!actionsMayNotOpenPulls(err)) throw err;
        throw new Error(
          `GitHub Actions may not open pull requests in ${repo}, so the docs fix waits on the branch ${branch}: ${ALLOW_ACTIONS_PULLS}. ` +
            `To open this one by hand: https://github.com/${repo}/compare/${base}...${branch}?expand=1`,
        );
      }));
    opened.push({ repo, url: pr.html_url, target: 'same-repo', branch, ...(skipped.length ? { skipped } : {}) });
  }
  if (!opened.length && refused.length) {
    throw new Error(`the docs fix was not opened: the target branch has other text where each edit applies (${refused.join('; ')}). Check the pull request again so the edits are written against its branch.`);
  }
  return opened;
}

async function waitForRepo(gh: <T>(path: string) => Promise<T>, fullName: string, pollMs: number): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await gh(`/repos/${fullName}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  throw new Error(`fork ${fullName} did not become available`);
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
