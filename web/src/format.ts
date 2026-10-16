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

type RunRow = { example: string; side: string; status: string };

/**
 * One line per pull request card: what the before/after runs proved, most telling first.
 * Breaks and fixes are named; the rest are counted.
 */
export function runSummary(runs: RunRow[]): string {
  const byExample = new Map<string, Record<string, string>>();
  for (const r of runs) byExample.set(r.example, { ...(byExample.get(r.example) ?? {}), [r.side]: r.status });
  const failed = (s: string) => s === 'fail' || s === 'timeout';
  const named: Record<'breaks' | 'fixes', string[]> = { breaks: [], fixes: [] };
  const counts = { 'already broken': 0, pass: 0, "can't install": 0 };
  for (const [ex, { before, after }] of byExample) {
    if (!before || !after) continue;
    const name = ex.split(':').slice(1).join(':');
    if (before === 'error' || after === 'error') counts["can't install"]++;
    else if (!failed(before) && failed(after)) named.breaks.push(name);
    else if (failed(before) && !failed(after)) named.fixes.push(name);
    else if (failed(before) && failed(after)) counts['already broken']++;
    else if (before === 'pass' && after === 'pass') counts.pass++;
  }
  const parts = [
    ...named.breaks.map((n) => `${n}: breaks (passes before, fails after)`),
    ...named.fixes.map((n) => `${n}: fixed by this PR (fails before, passes after)`),
    ...Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([label, n]) => `${n} ${label === 'pass' ? (n === 1 ? 'passes' : 'pass') : label}`),
  ];
  return parts.slice(0, 4).join(' · ');
}
