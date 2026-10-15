/**
 * Lockstep as a library: index an organisation into FalkorDB, check pull
 * requests with the graph tools or the agent, and serve MCP or the web demo.
 */
export { loadConfig, orgSlug, DEFAULT_MODEL, type Config } from './config.js';
export { GraphStore, OrgGraph, type QueryResult } from './graph/client.js';
export * as queries from './graph/queries.js';
export { indexOrg, type IndexReport } from './indexer/index.js';
export { checkoutRepo, parseRepoName, type Checkout } from './indexer/repo.js';
export { ingestPullRequest, recordPullRequest } from './pr/ingest.js';
export { diffPullRequest, diffRange, type ChangedSymbol } from './pr/changes.js';
export { parsePrUrl, fetchPullRequest } from './pr/github.js';
export { AGENT_TOOLS, ALL_TOOLS, modelTools } from './tools/index.js';
export type { ToolContext, ToolDef, ToolResult } from './tools/types.js';
export { runAgentCheck, type CheckResult } from './agent/loop.js';
export { runGraphCheck } from './agent/graph-check.js';
export { AnthropicModel } from './agent/anthropic.js';
export { ScriptedModel } from './agent/scripted.js';
export type { ModelClient } from './agent/model.js';
export type { TraceEvent } from './agent/trace.js';
export { buildDocsPatch } from './patch.js';
export { openDocsPr } from './pr/open-pr.js';
export { createMcpServer } from './mcp/server.js';
export { createApp, defaultModelFactory, DEFAULT_PRELOADED } from './server/app.js';
export { collectFacts, factsMarkdown } from './facts.js';
