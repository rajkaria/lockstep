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
  /** Local clones by repository, overriding `<home>/repos` (tests, offline use). */
  checkouts?: Record<string, string>;
  /** Re-run examples instead of answering from recorded runs (`run --fresh`). */
  freshRuns?: boolean;
  /** A local server: tools may read a checkout on this machine (check_changes with dir). */
  allowDir?: boolean;
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

/**
 * The error for parameters a tool does not declare (zod would drop them silently, and the
 * caller would get the same answer again), or undefined when every parameter is known.
 */
export function unknownParamsError(tool: ToolDef, input: Record<string, unknown>): string | undefined {
  const known = 'shape' in tool.input ? Object.keys((tool.input as unknown as { shape: object }).shape) : undefined;
  const unknown = known ? Object.keys(input).filter((k) => !known.includes(k)) : [];
  return unknown.length ? `${tool.name} has no parameter ${unknown.join(', ')}; its parameters are ${known!.join(', ')}` : undefined;
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
