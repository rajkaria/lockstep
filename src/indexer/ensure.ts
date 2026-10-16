import type { Config } from '../config.js';
import type { OrgGraph } from '../graph/client.js';
import { indexOrg, type IndexProgress, type IndexReport } from './index.js';
import { checkoutRepo, gitAvailable, parseRepoName, type Checkout } from './repo.js';
import { downloadRepo } from './tarball.js';

/** A repository at `ref` (default: its default branch head): a git clone, or a tarball where there is no git. */
export async function checkoutOrDownload(config: Config, repo: string, ref?: string): Promise<Checkout> {
  if (await gitAvailable()) return checkoutRepo(config.home, repo, ref);
  return downloadRepo(config.home, repo, ref ?? 'HEAD', { token: config.githubToken });
}

/** Which of `repos` the graph has no Repo node for. */
export async function missingRepos(graph: OrgGraph, repos: string[]): Promise<string[]> {
  const names = repos.map(parseRepoName);
  const have = new Set(
    (await graph.run<{ name: string }>(`MATCH (r:Repo) WHERE r.name IN $names RETURN r.name AS name`, { names })).rows.map((r) => r.name.toLowerCase()),
  );
  return names.filter((n) => !have.has(n.toLowerCase()));
}

/**
 * Index `repos` together unless the graph already has every one of them: the first check
 * of a repository needs no separate `index` step. They are indexed in one run so calls
 * and doc links across them resolve.
 */
export async function ensureIndexed(
  graph: OrgGraph,
  config: Config,
  repos: string[],
  onProgress: (p: IndexProgress | { phase: 'checkout'; repo: string; message: string }) => void = () => {},
): Promise<IndexReport | undefined> {
  const names = [...new Set(repos.map(parseRepoName))];
  if ((await missingRepos(graph, names)).length === 0) return undefined;
  const checkouts: Checkout[] = [];
  for (const repo of names) {
    onProgress({ phase: 'checkout', repo, message: `fetching ${repo}` });
    checkouts.push(await checkoutOrDownload(config, repo));
  }
  return indexOrg(graph, checkouts, onProgress);
}
