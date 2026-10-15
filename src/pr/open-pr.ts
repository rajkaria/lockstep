import type { DocsPatch } from '../patch.js';
import { githubJson, type GitHubOptions } from './github.js';

export interface OpenPrOptions extends GitHubOptions {
  token: string;
  /** `fork` (default): the PR is opened inside your fork. `upstream`: against the original repository. */
  target: 'fork' | 'upstream';
  /** Poll interval while GitHub creates a fork. */
  pollMs?: number;
}

export interface OpenedPr {
  repo: string;
  url: string;
  target: 'fork' | 'upstream';
  branch: string;
}

/**
 * Open the docs fix as a pull request. Default target is the caller's fork, never
 * the upstream repository, unless `target: 'upstream'` is passed explicitly.
 */
export async function openDocsPr(patch: DocsPatch, opts: OpenPrOptions): Promise<OpenedPr[]> {
  if (!opts.token) throw new Error('opening a pull request needs GITHUB_TOKEN');
  if (patch.files.length === 0) throw new Error('the patch is empty: no proposed edits to open a pull request for');
  const gh = <T>(path: string, init: RequestInit = {}) => githubJson<T>(path, opts, init);
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
    const branch = `lockstep/${patch.pr.repo.replace('/', '-')}-${patch.pr.number}`;
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
