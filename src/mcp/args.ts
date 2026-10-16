import { parseRepoName } from '../indexer/repo.js';
import { parsePrUrl } from '../pr/github.js';

/** The repository a tool call is about: from `pr_url`, else from the first `owner/repo:` id it names. */
export function repoOfArgs(input: Record<string, unknown>): string | undefined {
  if (typeof input.pr_url === 'string') {
    try {
      return parsePrUrl(input.pr_url).fullName;
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(input.repos) && typeof input.repos[0] === 'string') {
    try {
      return parseRepoName(input.repos[0]);
    } catch {
      return undefined;
    }
  }
  const ids = Object.values(input).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === 'string');
  for (const id of ids) {
    const m = /^([\w.-]+\/[\w.-]+):/.exec(id);
    if (m) return m[1];
  }
  return undefined;
}

