import type { PullRequestInfo } from '../pr/github.js';

/** The parts of GitHub's webhook payloads the App reads. */

export interface GhRepository {
  id?: number;
  name?: string;
  full_name: string;
  private: boolean;
  default_branch?: string;
  owner?: { login: string };
}

export interface GhInstallationRef {
  id: number;
}

export interface GhPull {
  number: number;
  html_url?: string;
  title: string;
  body: string | null;
  user: { login: string } | null;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  base: { sha: string; ref: string; repo: GhRepository | null };
  head: { sha: string; ref: string; repo: GhRepository | null };
}

export interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: GhPull;
  repository: GhRepository;
  installation?: GhInstallationRef;
}

export interface GhCheckRun {
  id: number;
  head_sha: string;
  external_id?: string | null;
  name?: string;
  app?: { id: number } | null;
  pull_requests?: { number: number }[];
  output?: { title?: string | null; summary?: string | null };
}

export interface CheckRunEvent {
  action: string;
  check_run: GhCheckRun;
  requested_action?: { identifier: string };
  repository: GhRepository;
  installation?: GhInstallationRef;
}

export interface CheckSuiteEvent {
  action: string;
  check_suite: { id: number; head_sha: string; head_branch: string | null; pull_requests?: { number: number }[]; app?: { id: number } | null };
  repository: GhRepository;
  installation?: GhInstallationRef;
}

export interface PushEvent {
  ref: string;
  after: string;
  deleted?: boolean;
  repository: GhRepository;
  installation?: GhInstallationRef;
}

export interface GhInstallation {
  id: number;
  account: { login: string; type?: string } | null;
  repository_selection?: string;
  suspended_at?: string | null;
}

export interface InstallationEvent {
  action: string;
  installation: GhInstallation;
  repositories?: { full_name: string; private: boolean }[];
}

export interface InstallationRepositoriesEvent {
  action: string;
  installation: GhInstallation;
  repository_selection?: string;
  repositories_added?: { full_name: string; private: boolean }[];
  repositories_removed?: { full_name: string; private: boolean }[];
}

/** A pull request as the rest of Staleproof reads it (`fetchPullRequest`'s shape), from a webhook or API object. */
export function pullRequestInfo(raw: GhPull, fullName: string): PullRequestInfo {
  const [owner, repo] = fullName.split('/') as [string, string];
  return {
    owner,
    repo,
    fullName,
    number: raw.number,
    url: `https://github.com/${fullName}/pull/${raw.number}`,
    title: raw.title ?? '',
    body: raw.body ?? '',
    author: raw.user?.login ?? 'unknown',
    state: raw.state,
    mergedAt: raw.merged_at,
    mergeSha: raw.merged_at ? raw.merge_commit_sha : null,
    baseSha: raw.base.sha,
    baseRef: raw.base.ref,
    headSha: raw.head.sha,
    headRef: raw.head.ref,
  };
}

/** Whether the pull request comes from another repository (a fork): the App cannot push there. */
export function isFork(raw: GhPull, repo: string): boolean {
  return !raw.head.repo || raw.head.repo.full_name.toLowerCase() !== repo.toLowerCase();
}
