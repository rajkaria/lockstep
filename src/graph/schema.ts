import type { OrgGraph } from './client.js';
import { SCHEMA_INDEXES } from './queries.js';

/** Create the exact-match indexes every lookup relies on. Safe to run repeatedly. */
export async function ensureSchema(graph: OrgGraph): Promise<void> {
  for (const [label, prop] of SCHEMA_INDEXES) {
    try {
      await graph.run(`CREATE INDEX FOR (n:${label}) ON (n.${prop})`);
    } catch (err) {
      if (!/already indexed|already exists/i.test((err as Error).message)) throw err;
    }
  }
}
