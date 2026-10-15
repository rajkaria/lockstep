/** Display helpers shared by the components. */

const PALETTE = ['repo-a', 'repo-b', 'repo-c', 'repo-d', 'repo-e', 'repo-f'];
const assigned = new Map<string, string>();

/** A stable color class per repository (first seen, first color). */
export function repoClass(repo: string): string {
  if (!assigned.has(repo)) assigned.set(repo, PALETTE[assigned.size % PALETTE.length]!);
  return assigned.get(repo)!;
}

/** Pre-assign colors in a fixed order so client, SDK and docs keep their colors across pages. */
export function seedRepoColors(repos: string[]): void {
  for (const r of repos) repoClass(r);
}

export function repoShort(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

export interface PathNode {
  label: string;
  title: string;
  repo?: string;
  kind: 'symbol' | 'section' | 'example';
}

/**
 * Evidence path nodes come as qualnames (symbols) or ids (`repo:path#anchor`,
 * `repo:path:index`). The repository of a symbol isn't in its qualname, so the
 * caller passes a qualname → repo guess from the package prefix.
 */
export function pathNode(raw: string, packageRepo: (qualname: string) => string | undefined): PathNode {
  const docMatch = /^([\w.-]+\/[\w.-]+):(.+)$/.exec(raw);
  if (docMatch) {
    const [, repo, rest] = docMatch as unknown as [string, string, string];
    const ex = /^(.*):(\d+)$/.exec(rest);
    if (ex) return { kind: 'example', repo, label: `${fileName(ex[1]!)} · example ${Number(ex[2]) + 1}`, title: raw };
    const [path, anchor] = rest.split('#');
    return { kind: 'section', repo, label: anchor ? `${fileName(path!)} #${anchor}` : fileName(path!), title: raw };
  }
  const parts = raw.split('.');
  return { kind: 'symbol', repo: packageRepo(raw), label: parts.slice(-2).join('.'), title: raw };
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

export function sevLabel(s: string): string {
  return s === 'api' ? 'signature' : s;
}

export function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function num(n: number | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}
