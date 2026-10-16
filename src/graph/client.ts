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
      // Give up quickly on a server that isn't there, but survive idle drops (serverless, cloud proxies).
      const reconnectStrategy = (retries: number) => (retries >= 4 ? new Error('FalkorDB unreachable') : Math.min(200 * 2 ** retries, 2000));
      db = await FalkorDB.connect({ url, socket: { connectTimeout: 5000, reconnectStrategy } as never });
    } catch (err) {
      throw new Error(
        `cannot reach FalkorDB at ${redact(url)}: ${(err as Error).message}\n` +
          `Start one locally with \`npx staleproof db start\` (or scripts/falkordb-local.sh start), ` +
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

  /** FalkorDB module version, e.g. `4.18.3`. */
  async serverVersion(): Promise<string> {
    try {
      const conn = (await this.db.connection) as unknown as { moduleList(): Promise<{ name: string; ver: number }[]> };
      const graph = (await conn.moduleList()).find((m) => m.name === 'graph');
      if (!graph) return 'unknown';
      const v = graph.ver;
      return `${Math.floor(v / 10000)}.${Math.floor(v / 100) % 100}.${v % 100}`;
    } catch {
      return 'unknown';
    }
  }

  async listGraphs(): Promise<string[]> {
    return this.db.list();
  }

  private async command<T>(args: string[]): Promise<T> {
    const conn = (await this.db.connection) as unknown as { sendCommand(args: string[]): Promise<T> };
    return conn.sendCommand(args);
  }

  /** Server memory in MB: what the instance uses now, and its cap (0 when uncapped). */
  async memoryMb(): Promise<{ used: number; max: number }> {
    const info = await this.command<string>(['INFO', 'memory']);
    const num = (key: string) => Number(new RegExp(`^${key}:(\\d+)`, 'm').exec(info)?.[1] ?? 0) / 1024 / 1024;
    return { used: num('used_memory'), max: num('maxmemory') };
  }

  /** One graph's memory in MB (`GRAPH.MEMORY USAGE`); undefined when the server can't say. */
  async graphMemoryMb(name: string): Promise<number | undefined> {
    try {
      const reply = await this.command<unknown[]>(['GRAPH.MEMORY', 'USAGE', name]);
      const i = reply.indexOf('total_graph_sz_mb');
      return i >= 0 ? Number(reply[i + 1]) : undefined;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export interface QueryEvent {
  name: string;
  cypher: string;
  params: Params;
  ms: number;
  rows: number;
}

export class OrgGraph {
  constructor(
    private readonly graph: Graph,
    readonly name: string,
    private readonly listener?: (e: QueryEvent) => void,
  ) {}

  /** A view of the same graph that reports every query it runs (for traces). */
  traced(listener: (e: QueryEvent) => void): OrgGraph {
    return new OrgGraph(this.graph, this.name, listener);
  }

  async run<T = Record<string, unknown>>(query: NamedQuery | string, params: Params = {}): Promise<QueryResult<T>> {
    const cypher = typeof query === 'string' ? query : query.cypher;
    const name = typeof query === 'string' ? 'adhoc' : query.name;
    let reply;
    try {
      reply = await this.graph.query<T>(cypher, { params: params as never });
    } catch (err) {
      throw new Error(`FalkorDB ${name} failed on graph "${this.name}": ${(err as Error).message}`);
    }
    const stats = (reply.metadata ?? []).map(String);
    const result = { rows: (reply.data ?? []) as T[], cypher, params, ms: executionMs(stats), stats };
    this.listener?.({ name, cypher, params, ms: result.ms, rows: result.rows.length });
    return result;
  }

  /** Delete the whole graph (tests only). */
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
