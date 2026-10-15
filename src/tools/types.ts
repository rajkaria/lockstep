import type { z } from 'zod';
import type { Config } from '../config.js';
import type { OrgGraph, Params } from '../graph/client.js';
import type { NamedQuery } from '../graph/queries.js';

export interface QueryTrace {
  name: string;
  cypher: string;
  params: Params;
  ms: number;
  rows: number;
}

export interface ToolResult<T = unknown> {
  tool: string;
  /** One or two sentences the agent (and the UI) reads first. */
  summary: string;
  data: T;
  /** Every Cypher statement the tool ran, with timing: the trace behind the answer. */
  queries: QueryTrace[];
}

export interface ToolContext {
  graph: OrgGraph;
  config: Config;
  /** The agent run this call belongs to, when there is one. */
  checkId?: string;
  /** Pull request under check, for tools that default to it. */
  prUrl?: string;
  log?: (msg: string) => void;
}

export interface ToolDef<I = any, O = any> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** The named queries this tool can run (for the README and MCP descriptions). */
  queries: NamedQuery[];
  /** Actions write outside the graph (GitHub); they need a human click or an explicit flag. */
  action?: boolean;
  run(ctx: ToolContext, input: I): Promise<ToolResult<O>>;
}

/** A traced view of the org graph: every query any helper runs through it is recorded. */
export class Tracer {
  readonly queries: QueryTrace[] = [];
  readonly graph: OrgGraph;
  constructor(graph: OrgGraph) {
    this.graph = graph.traced((e) => this.queries.push(e));
  }

  run<T>(query: NamedQuery | string, params: Params = {}) {
    return this.graph.run<T>(query, params);
  }
}

export function result<O>(tool: string, tracer: Tracer, summary: string, data: O): ToolResult<O> {
  return { tool, summary, data, queries: tracer.queries };
}
