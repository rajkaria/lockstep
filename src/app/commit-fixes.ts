import { applyTextEdits } from '../lint/fixes.js';
import type { Fix } from '../lint/types.js';
import type { InstallationClient } from './github-app.js';
import { patchOf } from './patch.js';

/**
 * The Apply fixes button: verified fixes committed to the pull request's branch through
 * the Git Data API (blobs in a tree on top of the head commit, one commit, the branch
 * moved forward without force). Only the head the fixes were computed for is ever
 * changed: if the branch moved, nothing is written.
 */

export class BranchMovedError extends Error {}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/**
 * Apply fixes in order, skipping any whose edits overlap an earlier accepted one's. Every
 * edit is in the original file's coordinates, so the accepted edits are applied together.
 */
export function applyEach(files: ReadonlyMap<string, string>, fixes: readonly Fix[]): { changed: Map<string, string>; applied: Fix[]; skipped: Fix[] } {
  const accepted = new Map<string, Fix['edits']>();
  const applied: Fix[] = [];
  const skipped: Fix[] = [];
  for (const fix of fixes) {
    const byPath = new Map<string, Fix['edits']>();
    for (const e of fix.edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
    try {
      for (const [path, edits] of byPath) {
        const content = files.get(path);
        if (content === undefined) throw new Error(`no content for ${path}`);
        // Throws when an edit overlaps one already accepted.
        applyTextEdits(content, [...(accepted.get(path) ?? []), ...edits]);
      }
      for (const [path, edits] of byPath) accepted.set(path, [...(accepted.get(path) ?? []), ...edits]);
      applied.push(fix);
    } catch {
      skipped.push(fix);
    }
  }
  const changed = new Map<string, string>();
  for (const [path, edits] of accepted) {
    const before = files.get(path)!;
    const after = applyTextEdits(before, edits);
    if (after !== before) changed.set(path, after);
  }
  return { changed, applied, skipped };
}

/** The files the fixes edit, at a commit. */
export async function readFixedFiles(client: InstallationClient, repo: string, sha: string, fixes: readonly Fix[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of new Set(fixes.flatMap((f) => f.edits.map((e) => e.path)))) {
    const text = await client.fileText(repo, path, sha);
    if (text !== undefined) files.set(path, text);
  }
  return files;
}

/** The patch a fork gets instead of a commit. */
export async function fixesPatch(client: InstallationClient, repo: string, sha: string, fixes: readonly Fix[]): Promise<{ patch: string; applied: Fix[] }> {
  const files = await readFixedFiles(client, repo, sha, fixes);
  const { changed, applied } = applyEach(files, fixes.filter((f) => f.edits.every((e) => files.has(e.path))));
  return { patch: patchOf(new Map([...changed].map(([path, after]) => [path, { before: files.get(path)!, after }]))), applied };
}

/** A file's mode in a tree, walking one directory level at a time (no recursive listing of big trees). */
async function modeOf(client: InstallationClient, repo: string, treeSha: string, path: string): Promise<string | undefined> {
  const parts = path.split('/');
  let tree = treeSha;
  for (let i = 0; i < parts.length; i++) {
    const listing = await client.get<{ tree: TreeEntry[] }>(`/repos/${repo}/git/trees/${tree}`);
    const entry = listing?.tree.find((t) => t.path === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) return entry.type === 'blob' ? entry.mode : undefined;
    if (entry.type !== 'tree') return undefined;
    tree = entry.sha;
  }
  return undefined;
}

export interface CommitFixesInput {
  /** The repository the branch is in (the pull request's head repository). */
  repo: string;
  branch: string;
  /** The commit the fixes were computed for: the branch must still point at it. */
  head: string;
  fixes: readonly Fix[];
  message?: string;
}

export interface CommittedFixes {
  sha: string;
  files: string[];
  applied: Fix[];
  skipped: Fix[];
}

export async function commitFixes(client: InstallationClient, input: CommitFixesInput): Promise<CommittedFixes | undefined> {
  const refPath = `/repos/${input.repo}/git/refs/heads/${encodePath(input.branch)}`;
  const ref = await client.get<{ object: { sha: string } }>(`/repos/${input.repo}/git/ref/heads/${encodePath(input.branch)}`);
  if (!ref || ref.object.sha !== input.head) {
    throw new BranchMovedError(`${input.branch} has moved past ${input.head.slice(0, 7)} since the check ran; nothing was committed. Re-run the check to compute fixes for the new head.`);
  }
  const commit = await client.get<{ tree: { sha: string } }>(`/repos/${input.repo}/git/commits/${input.head}`);
  if (!commit) throw new Error(`commit ${input.head.slice(0, 7)} not found in ${input.repo}`);
  const files = await readFixedFiles(client, input.repo, input.head, input.fixes);
  const { changed, applied, skipped } = applyEach(files, input.fixes.filter((f) => f.edits.every((e) => files.has(e.path))));
  if (!changed.size) return undefined;
  const entries: { path: string; mode: string; type: 'blob'; content: string }[] = [];
  for (const [path, content] of changed) {
    const mode = await modeOf(client, input.repo, commit.tree.sha, path);
    // Symlinks and submodules are never rewritten.
    if (mode !== '100644' && mode !== '100755') continue;
    entries.push({ path, mode, type: 'blob', content });
  }
  if (!entries.length) return undefined;
  const tree = await client.post<{ sha: string }>(`/repos/${input.repo}/git/trees`, { base_tree: commit.tree.sha, tree: entries });
  const n = applied.length;
  const message =
    input.message ??
    [
      `Staleproof: fix ${n} stale docs reference${n === 1 ? '' : 's'}`,
      '',
      ...applied.map((f) => `- ${f.edits[0]!.path}:${f.edits[0]!.line} ${f.description}`),
      '',
      'Verified fixes from the Staleproof check run (Apply fixes).',
    ].join('\n');
  const created = await client.post<{ sha: string }>(`/repos/${input.repo}/git/commits`, { message, tree: tree.sha, parents: [input.head] });
  // Never forced: if the branch moved in the meantime GitHub refuses the update.
  await client.patch(refPath, { sha: created.sha, force: false });
  return { sha: created.sha, files: entries.map((e) => e.path), applied, skipped };
}
