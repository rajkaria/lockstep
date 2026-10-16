import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface PrRef {
  owner: string;
  repo: string;
  /** `owner/repo` */
  fullName: string;
  number: number;
  url: string;
}

export interface PullRequestInfo extends PrRef {
  title: string;
  body: string;
  author: string;
  state: 'open' | 'closed';
  mergedAt: string | null;
  mergeSha: string | null;
  baseSha: string;
  baseRef: string;
  headSha: string;
  headRef: string;
}

/** Parse `https://github.com/owner/repo/pull/123` (also `owner/repo#123`). */
export function parsePrUrl(input: string): PrRef {
  const s = input.trim();
  const m =
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(s) ??
    /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s);
  if (!m) throw new Error(`not a GitHub pull request URL: "${input}" (expected https://github.com/<owner>/<repo>/pull/<n>)`);
  const [, owner, repo, num] = m as unknown as [string, string, string, string];
  return { owner, repo, fullName: `${owner}/${repo}`, number: Number(num), url: `https://github.com/${owner}/${repo}/pull/${num}` };
}

export interface GitHubOptions {
  token?: string;
  /** Directory for the response cache (merged PRs never change). */
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}

/** Fetch PR metadata from the GitHub REST API (public repos work without a token, 60 requests/hour). */
export async function fetchPullRequest(ref: PrRef, opts: GitHubOptions = {}): Promise<PullRequestInfo> {
  const cacheFile = opts.cacheDir ? join(opts.cacheDir, 'github', ref.owner, ref.repo, 'pulls', `${ref.number}.json`) : undefined;
  if (cacheFile && existsSync(cacheFile)) {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as PullRequestInfo;
    if (cached.mergedAt) return cached;
  }
  const data = await githubJson<GhPull>(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, opts);
  const info: PullRequestInfo = {
    ...ref,
    title: data.title,
    body: data.body ?? '',
    author: data.user?.login ?? 'unknown',
    state: data.state,
    mergedAt: data.merged_at,
    mergeSha: data.merged_at ? data.merge_commit_sha : null,
    baseSha: data.base.sha,
    baseRef: data.base.ref,
    headSha: data.head.sha,
    headRef: data.head.ref,
  };
  if (cacheFile) {
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(info, null, 2));
  }
  return info;
}

interface GhPull {
  title: string;
  body: string | null;
  user: { login: string } | null;
  state: 'open' | 'closed';
  merged_at: string | null;
  merge_commit_sha: string | null;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
}

export async function githubJson<T>(path: string, opts: GitHubOptions = {}, init: RequestInit = {}): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'staleproof',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 403 && /rate limit/i.test(text)) {
      throw new Error('GitHub API rate limit reached (60/hour without a token). Set GITHUB_TOKEN to raise it.');
    }
    if (res.status === 404) throw new Error(`GitHub: ${path} not found (private repositories are not supported)`);
    throw new Error(`GitHub ${init.method ?? 'GET'} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}
