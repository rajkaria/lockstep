import type { OrgGraph } from '../graph/client.js';
import type { NamedQuery } from '../graph/queries.js';

const BATCH = 400;

/** Run an UNWIND query over `rows` in batches. */
export async function writeBatched(graph: OrgGraph, query: NamedQuery, rows: unknown[], extra: Record<string, unknown> = {}): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await graph.run(query, { ...extra, rows: rows.slice(i, i + BATCH) });
  }
}

export function fileId(repo: string, path: string): string {
  return `${repo}:${path}`;
}
