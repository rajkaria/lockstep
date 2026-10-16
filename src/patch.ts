import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { structuredPatch } from 'diff';
import * as Q from './graph/queries.js';
import { git } from './indexer/repo.js';
import { githubSource } from './pr/github-diff.js';
import type { ToolContext } from './tools/types.js';

export interface VerdictRow {
  section: string;
  repo: string;
  path: string;
  heading: string;
  lineno: number;
  endLineno: number;
  url: string;
  id: string;
  verdict: 'stale' | 'ok' | 'governed' | 'skipped';
  status: string;
  reason: string;
  newText: string | null;
  oldText: string | null;
  evidence: string[] | null;
  cites: string[];
  runs: { id: string | null; status: string | null; side: string | null; error: string | null }[];
}

export interface PatchedFile {
  repo: string;
  path: string;
  sha: string;
  before: string;
  after: string;
  diff: string;
  sections: string[];
}

export interface DocsPatch {
  pr: { url: string; title: string; repo: string; number: number };
  files: PatchedFile[];
  /** Unified diff of every file, `git apply`-able per repository. */
  diff: string;
  /** Pull request description: one entry per edited section with its evidence path. */
  title: string;
  body: string;
  verdicts: VerdictRow[];
  /** Sections whose file changed since indexing, so the edit could not be placed. */
  conflicts: { section: string; reason: string }[];
}

export async function loadVerdicts(ctx: ToolContext, prUrl: string): Promise<VerdictRow[]> {
  const rows = (await ctx.graph.run<VerdictRow>(Q.verdictsForPr, { pr: prUrl })).rows;
  for (const r of rows) {
    r.runs = (r.runs ?? []).filter((x) => x.id);
    r.cites = (r.cites ?? []).filter(Boolean);
  }
  return rows;
}

/**
 * Build the docs patch for a pull request from its latest per-section verdicts.
 * Files are read at the commit the graph indexed: from the local clone when there is
 * one, otherwise from GitHub (serverless hosts have no clones).
 */
export async function buildDocsPatch(ctx: ToolContext, prUrl: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<DocsPatch> {
  const pr = (
    await ctx.graph.run<{ url: string; title: string; repo: string; number: number }>(
      `MATCH (pr:PullRequest {url: $url}) RETURN pr.url AS url, pr.title AS title, pr.repo AS repo, pr.number AS number`,
      { url: prUrl },
    )
  ).rows[0];
  if (!pr) throw new Error(`${prUrl} has not been checked`);
  const verdicts = await loadVerdicts(ctx, prUrl);
  const edits = verdicts.filter((v) => v.verdict === 'stale' && v.newText && v.status !== 'rejected');
  const byFile = new Map<string, VerdictRow[]>();
  for (const e of edits) {
    const key = `${e.repo}\u0000${e.path}`;
    byFile.set(key, [...(byFile.get(key) ?? []), e]);
  }
  const files: PatchedFile[] = [];
  const conflicts: DocsPatch['conflicts'] = [];
  for (const [key, list] of byFile) {
    const [repo, path] = key.split('\u0000') as [string, string];
    const sha = (await ctx.graph.run<{ sha: string }>(`MATCH (r:Repo {name: $repo}) RETURN r.sha AS sha`, { repo })).rows[0]?.sha;
    if (!sha) continue;
    const dir = ctx.checkouts?.[repo] ?? join(ctx.config.home, 'repos', ...repo.split('/'));
    const before = existsSync(dir) ? await git(dir, ['show', `${sha}:${path}`]) : await githubSource(repo, opts).read(sha, path);
    if (before === undefined) {
      for (const v of list) conflicts.push({ section: v.section, reason: `${path} not found in ${repo}@${sha.slice(0, 7)}` });
      continue;
    }
    const lines = before.split('\n');
    const applied: string[] = [];
    for (const v of [...list].sort((a, b) => b.lineno - a.lineno)) {
      let start = v.lineno - 1;
      let end = Math.min(v.endLineno, lines.length) - 1;
      while (start <= end && !lines[start]!.trim()) start++;
      while (end >= start && !lines[end]!.trim()) end--;
      const current = lines.slice(start, end + 1).join('\n').trim();
      if (v.oldText !== null && current !== v.oldText.trim()) {
        conflicts.push({ section: v.section, reason: `${path} changed since it was indexed at ${sha.slice(0, 7)}` });
        continue;
      }
      lines.splice(start, end - start + 1, ...v.newText!.replace(/\s+$/, '').split('\n'));
      applied.push(v.section);
    }
    if (!applied.length) continue;
    const after = lines.join('\n');
    files.push({ repo, path, sha, before, after, diff: unifiedDiff(path, before, after), sections: applied.reverse() });
  }
  const title = `docs: update for ${pr.repo}#${pr.number} (${pr.title})`;
  return { pr, files, diff: files.map((f) => f.diff).join(''), title, body: prBody(pr, verdicts, files, conflicts), verdicts, conflicts };
}

/** A `git apply`-able unified diff for one file. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const p = structuredPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 });
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const h of p.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    out.push(...h.lines);
  }
  return `${out.join('\n')}\n`;
}

function prBody(pr: DocsPatch['pr'], verdicts: VerdictRow[], files: PatchedFile[], conflicts: DocsPatch['conflicts']): string {
  const edited = new Set(files.flatMap((f) => f.sections));
  const out: string[] = [];
  out.push(
    `${pr.url} changed code that these docs describe. Each edit below comes with the path in the code graph that connects the change to the paragraph, and the example runs that prove it where Lockstep could run them.`,
    '',
  );
  for (const v of verdicts.filter((x) => edited.has(x.section))) {
    out.push(`### [${v.heading}](${v.url})`, '', v.reason, '');
    if (v.evidence?.length) out.push(`Path: ${v.evidence.map((n) => `\`${n}\``).join(' ← ')}`, '');
    for (const r of v.runs) out.push(`- Run ${r.side}: **${r.status}**${r.error ? ` — \`${r.error}\`` : ''}`);
    if (v.runs.length) out.push('');
    if (v.cites.length) out.push(`Decisions: ${v.cites.join(', ')}`, '');
  }
  const others = verdicts.filter((x) => !edited.has(x.section));
  if (others.length) {
    out.push('<details><summary>Sections checked and left unchanged</summary>', '');
    for (const v of others) out.push(`- **${v.verdict}** [${v.heading}](${v.url}): ${v.reason}`);
    out.push('', '</details>', '');
  }
  if (conflicts.length) {
    out.push('Not applied (file changed since indexing):', ...conflicts.map((c) => `- ${c.section}: ${c.reason}`), '');
  }
  out.push('_Generated by [Lockstep](https://github.com/rajkaria/lockstep). Review every paragraph before merging._');
  return out.join('\n');
}
