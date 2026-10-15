import { FalkorDB, type Graph } from 'falkordb';
import { orgSlug } from '../config.js';
import type { NamedQuery } from './queries.js';

export type Params = Record<string, unknown>;

export interface QueryResult<T> {
  rows: T[];
  /** The exact Cypher text sent to FalkorDB. */
  cypher: string;
  params: Params;
  /** Server-side execution time reported by FalkorDB, in milliseconds. */
  ms: number;
  /** FalkorDB statistics lines ("Nodes created: 3", ...). */
  stats: string[];
}

/** A connection to one FalkorDB server, holding one graph per organisation. */
export class GraphStore {
  private constructor(
    private readonly db: FalkorDB,
    readonly url: string,
  ) {}

  static async connect(url: string): Promise<GraphStore> {
    let db: FalkorDB;
    try {
      db = await FalkorDB.connect({ url, socket: { connectTimeout: 5000, reconnectStrategy: false } as never });
    } catch (err) {
      throw new Error(
        `cannot reach FalkorDB at ${redact(url)}: ${(err as Error).message}\n` +
          `Start one locally with \`npx lockstep-docs db start\` (or scripts/falkordb-local.sh start), ` +
          `or set FALKORDB_URL.`,
      );
    }
    return new GraphStore(db, url);
  }

  /** The graph for an organisation. Graph name = org slug. */
  org(name: string): OrgGraph {
    const slug = orgSlug(name);
    return new OrgGraph(this.db.selectGraph(slug), slug);
  }

  async listGraphs(): Promise<string[]> {
    return this.db.list();
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export class OrgGraph {
  constructor(
    private readonly graph: Graph,
    readonly name: string,
  ) {}

  async run<T = Record<string, unknown>>(query: NamedQuery | string, params: Params = {}): Promise<QueryResult<T>> {
    const cypher = typeof query === 'string' ? query : query.cypher;
    let reply;
    try {
      reply = await this.graph.query<T>(cypher, { params: params as never });
    } catch (err) {
      const name = typeof query === 'string' ? 'query' : query.name;
      throw new Error(`FalkorDB ${name} failed on graph "${this.name}": ${(err as Error).message}`);
    }
    const stats = (reply.metadata ?? []).map(String);
    return { rows: (reply.data ?? []) as T[], cypher, params, ms: executionMs(stats), stats };
  }

  /** Delete the whole graph (tests and `index --fresh` only). */
  async drop(): Promise<void> {
    try {
      await this.graph.delete();
    } catch (err) {
      if (!/empty key|invalid graph|not found/i.test((err as Error).message)) throw err;
    }
  }
}

function executionMs(stats: string[]): number {
  for (const line of stats) {
    const m = /execution time:\s*([\d.]+)\s*milliseconds/i.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
}

export function redact(url: string): string {
  return url.replace(/\/\/([^:@/]*):([^@/]*)@/, '//$1:***@');
}
