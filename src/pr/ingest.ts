import { join } from 'node:path';
import type { Config } from '../config.js';
import type { OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import { symbolId, GENERIC } from '../indexer/resolve.js';
import { checkoutRepo } from '../indexer/repo.js';
import { fileId, writeBatched } from '../indexer/write.js';
import { diffPullRequest, type ChangedSymbol, type PrDiff } from './changes.js';
import { fetchPullRequest, parsePrUrl, type PullRequestInfo } from './github.js';

export interface IngestedPr {
  pr: PullRequestInfo;
  diff: PrDiff;
  /** Changed symbols attached to the PR (ids). */
  changed: { id: string; change: ChangedSymbol }[];
  /** Removed symbols recreated because the graph was indexed after the PR. */
  recreated: string[];
  lateLinks: number;
}

export class NotIndexedError extends Error {}

/**
 * Turn a pull request into graph facts: a PullRequest node, the symbols it
 * changed (CHANGED_IN with the kind of change), and — for symbols the PR removed
 * that the graph no longer has — recreated Symbol nodes linked to the docs that
 * still name them.
 */
export async function ingestPullRequest(graph: OrgGraph, config: Config, prUrl: string): Promise<IngestedPr> {
  const ref = parsePrUrl(prUrl);
  const repoRow = await graph.run<{ name: string }>(`MATCH (r:Repo {name: $name}) RETURN r.name AS name`, { name: ref.fullName });
  if (repoRow.rows.length === 0) {
    throw new NotIndexedError(
      `${ref.fullName} is not indexed in the "${graph.name}" graph. Run: lockstep-docs index ${ref.fullName} (plus the repositories that document it).`,
    );
  }
  const pr = await fetchPullRequest(ref, { token: config.githubToken, cacheDir: join(config.home, 'cache') });
  const checkout = await checkoutRepo(config.home, ref.fullName);
  const diff = await diffPullRequest(checkout.dir, ref.fullName, pr);
  return recordPullRequest(graph, pr, diff);
}

/** Write a pull request's symbol-level diff into the graph. */
export async function recordPullRequest(graph: OrgGraph, pr: PullRequestInfo, diff: PrDiff): Promise<IngestedPr> {
  await graph.run(Q.upsertPullRequest, {
    url: pr.url,
    props: {
      url: pr.url,
      repo: pr.fullName,
      number: pr.number,
      title: pr.title,
      author: pr.author,
      state: pr.mergedAt ? 'merged' : pr.state,
      merged_at: pr.mergedAt ?? '',
      head_sha: pr.headSha,
      merge_sha: pr.mergeSha ?? '',
      before_sha: diff.before,
      after_sha: diff.after,
      docs_touched: diff.docsTouched,
      ingested_at: Date.now(),
    },
  });

  const changed: IngestedPr['changed'] = diff.symbols.map((c) => ({
    id: symbolId(pr.fullName, c.change === 'export-removed' && c.exportTarget ? c.exportTarget : c.qualname),
    change: c,
  }));

  // Symbols that only existed before the PR.
  const existing = new Set(
    (
      await graph.run<{ id: string }>(`MATCH (s:Symbol) WHERE s.id IN $ids RETURN s.id AS id`, {
        ids: changed.map((c) => c.id),
      })
    ).rows.map((r) => r.id),
  );
  const missing = changed.filter((c) => !existing.has(c.id) && c.change.change !== 'added');
  await writeBatched(
    graph,
    Q.upsertMissingSymbols,
    missing.map(({ id, change: c }) => ({
      id,
      file: fileId(pr.fullName, c.path),
      props: {
        repo: pr.fullName,
        qualname: c.qualname,
        name: c.name,
        kind: c.kind,
        path: c.path,
        lineno: c.lineno,
        end_lineno: c.endLineno,
        signature: c.before ?? '',
        doc: c.doc ?? '',
        visibility: c.name.startsWith('_') ? 'private' : 'public',
        decorators: [],
        removed_by: pr.url,
      },
    })),
  );
  let lateLinks = 0;
  const linkable = missing.filter(({ change: c }) => c.name.length >= 4 && !GENERIC.has(c.name) && !c.name.startsWith('_'));
  if (linkable.length) {
    const rows = linkable.map(({ id, change: c }) => ({
      id,
      name: c.name,
      dotted: c.qualname.split('.').slice(-2).join('.'),
    }));
    lateLinks += (await graph.run<{ linked: number }>(Q.lateLinkSections, { rows })).rows[0]?.linked ?? 0;
    lateLinks += (await graph.run<{ linked: number }>(Q.lateLinkExamples, { rows })).rows[0]?.linked ?? 0;
  }

  await writeBatched(
    graph,
    Q.upsertChangedIn,
    changed.map(({ id, change: c }) => ({
      id,
      kind: c.change,
      before: c.before ?? '',
      after: c.after ?? '',
      renamed_to: c.renamedTo ?? '',
    })),
    { url: pr.url },
  );
  return { pr, diff, changed, recreated: missing.map((m) => m.id), lateLinks };
}
