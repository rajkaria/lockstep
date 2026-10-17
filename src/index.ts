/**
 * Staleproof as a library: index an organisation into FalkorDB, check pull
 * requests with the graph tools or the agent, and serve MCP or the web demo.
 */
export { loadConfig, orgSlug, setting, DEFAULT_MODEL, type Config } from './config.js';
export { GraphStore, OrgGraph, type QueryResult } from './graph/client.js';
export * as queries from './graph/queries.js';
export { indexOrg, type IndexReport } from './indexer/index.js';
export { checkoutRepo, parseRepoName, type Checkout } from './indexer/repo.js';
export { downloadRepo } from './indexer/tarball.js';
export { ensureIndexed, checkoutOrDownload } from './indexer/ensure.js';
export { Workspaces, DEFAULT_HOSTED_LIMITS, type HostedLimits } from './hosted/workspaces.js';
export { checkReport } from './format/report.js';
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
export { handleMcpRequest } from './mcp/http.js';
export { createApp, defaultModelFactory, DEFAULT_PRELOADED } from './server/app.js';
export { collectFacts, factsMarkdown } from './facts.js';
export { auditDocs, auditTool, scoreAudit, type AuditData } from './audit.js';
export { auditMarkdown, auditText } from './format/audit.js';
export { registerVerifiedRoutes, graphVerifiedSource, verifiedData, type VerifiedData, type VerifiedPage } from './server/verified.js';
export { stampScript } from './server/stamp.js';
export { runDigestCommand, buildDigest, digestState, slackPayload, discordPayload, jsonPayload, webhookKind, type Digest, type DigestState } from './digest.js';
export { parseCodeowners, loadCodeowners, ownersOf, ownersForAudit, ownersForCheck, affectedOwnersMarkdown, auditOwnersMarkdown, type Codeowners } from './codeowners.js';
export { releaseReport, runReleaseCommand, formatRelease, type ReleaseReport, type BreakingChange } from './release.js';
export { docsForTool } from './tools/docs-for.js';
export { analyzeChanges, checkChangesTool, localChanges, contentSource, worktreeSource } from './pr/local.js';
export { predictBreaks, type PredictedBreak } from './pr/predict.js';
export { canonicalPrUrl, refreshIfMoved } from './pr/ingest.js';
export { INDEX_VERSION } from './indexer/index.js';
export * from './lint/index.js';
export { ParseCache } from './lint/cache.js';
export { runHook, type HookEvent, type HookResult } from './hooks/index.js';
export { runInit } from './init/index.js';
export {
  registerGitHubAppRoutes,
  GitHubAppService,
  githubAppEnv,
  githubAppHealth,
  isPrivateGraph,
  assertPublicGraph,
  privateGraphName,
  type GitHubAppDeps,
} from './app/index.js';
