import { githubJson, type GitHubOptions, type PullRequestInfo } from './github.js';
import { changedLinesFromPatch, type ChangedFile, type DiffSource, type Hunks } from './changes.js';

interface CompareFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  previous_filename?: string;
  patch?: string;
}

const STATUS: Record<CompareFile['status'], string> = {
  added: 'A',
  removed: 'D',
  modified: 'M',
  changed: 'M',
  unchanged: 'M',
  renamed: 'R100',
  copied: 'C100',
};

/**
 * Read a pull request's commits through the GitHub API instead of a local clone,
 * for hosts without `git` (serverless). File contents come from
 * raw.githubusercontent.com, which is not counted against the API rate limit.
 */
export function githubSource(fullName: string, opts: GitHubOptions = {}): DiffSource {
  const f = opts.fetchImpl ?? fetch;
  const compares = new Map<string, Promise<CompareFile[]>>();
  const compare = (before: string, after: string) => {
    const key = `${before}...${after}`;
    let p = compares.get(key);
    if (!p) {
      p = githubJson<{ files?: CompareFile[] }>(`/repos/${fullName}/compare/${key}`, opts).then((r) => r.files ?? []);
      compares.set(key, p);
    }
    return p;
  };
  return {
    async changedFiles(before, after) {
      return (await compare(before, after)).map(
        (x): ChangedFile => ({ status: STATUS[x.status], path: x.filename, ...(x.previous_filename ? { oldPath: x.previous_filename } : {}) }),
      );
    },
    async files(sha) {
      const tree = await githubJson<{ tree: { path: string; type: string }[]; truncated: boolean }>(
        `/repos/${fullName}/git/trees/${sha}?recursive=1`,
        opts,
      );
      return tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);
    },
    async read(sha, path) {
      const url = `https://raw.githubusercontent.com/${fullName}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
      const res = await f(url, { headers: { 'User-Agent': 'staleproof' } });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`GitHub raw ${path}@${sha.slice(0, 7)} failed: ${res.status}`);
      return res.text();
    },
    async hunks(before, after, oldPath, path): Promise<Hunks | undefined> {
      const file = (await compare(before, after)).find((x) => x.filename === path || x.previous_filename === oldPath);
      return file?.patch ? changedLinesFromPatch(file.patch) : undefined;
    },
  };
}

/** The commits a PR changed the code between, resolved through the API. */
export async function prRangeGitHub(pr: PullRequestInfo, opts: GitHubOptions = {}): Promise<{ before: string; after: string }> {
  if (pr.mergeSha) {
    const c = await githubJson<{ parents: { sha: string }[] }>(`/repos/${pr.fullName}/commits/${pr.mergeSha}`, opts);
    const parent = c.parents[0]?.sha;
    if (!parent) throw new Error(`merge commit ${pr.mergeSha} has no parent`);
    return { before: parent, after: pr.mergeSha };
  }
  const cmp = await githubJson<{ merge_base_commit: { sha: string } }>(`/repos/${pr.fullName}/compare/${pr.baseSha}...${pr.headSha}`, opts);
  return { before: cmp.merge_base_commit.sha, after: pr.headSha };
}
