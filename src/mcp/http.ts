import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Config } from '../config.js';
import type { GraphStore, OrgGraph } from '../graph/client.js';
import type { Workspaces } from '../hosted/workspaces.js';
import { canonicalPrUrl } from '../pr/ingest.js';
import { ensureIndexed } from '../indexer/ensure.js';
import type { ToolContext, ToolDef } from '../tools/types.js';
import { repoOfArgs } from './args.js';
import { createMcpServer, MCP_INSTRUCTIONS, MCP_TOOLS } from './server.js';

export interface McpHttpOptions {
  store: GraphStore;
  config: Config;
  /** The org graph (the only graph when the server is not hosted). */
  graph: OrgGraph;
  workspaces?: Workspaces;
}

/** Tools that read a pull request and may index its repository first on a hosted server. */
const INDEXING_TOOLS = new Set(['check_pull_request', 'impact', 'clearance', 'audit_docs']);

export { repoOfArgs } from './args.js';

/**
 * MCP over Streamable HTTP (stateless: one server per request), so any MCP client can use
 * Staleproof by URL with nothing installed. On a hosted server, tools route to the
 * workspace graph of the repository they name, indexing it on first use; examples can't
 * run there (no sandbox), so `run_example` is left out.
 */
export async function handleMcpRequest(request: Request, opts: McpHttpOptions): Promise<Response> {
  if (request.method === 'GET' || request.method === 'DELETE') {
    // Stateless server: no standalone SSE stream and no sessions to end.
    return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: POST JSON-RPC messages to this endpoint' }, id: null }, { status: 405, headers: { Allow: 'POST' } });
  }
  const { config, graph, workspaces } = opts;
  const tools: ToolDef[] = workspaces ? MCP_TOOLS.filter((t) => t.name !== 'run_example') : MCP_TOOLS;
  const resolve = async (tool: ToolDef, input: Record<string, unknown>): Promise<ToolContext> => {
    const prUrl = typeof input.pr_url === 'string' ? input.pr_url : undefined;
    if (!workspaces) {
      // A local server indexes a repository on its first check, like the stdio server.
      const repo = repoOfArgs(input);
      if (repo && INDEXING_TOOLS.has(tool.name)) await ensureIndexed(graph, config, [repo]);
      if (prUrl) input.pr_url = await canonicalPrUrl(graph, prUrl);
      return { graph, config, prUrl: input.pr_url as string | undefined };
    }
    // Examples never run on a hosted server.
    if (tool.name === 'check_pull_request') input.run_examples = false;
    const repo = repoOfArgs(input);
    if (!repo) {
      if (tool.name === 'decisions_for' || tool.name === 'write_decision') return { graph, config, prUrl };
      throw new Error('name a repository: pass a pull request URL (pr_url), repos: ["owner/name"], or ids that start with owner/repo:');
    }
    const target = INDEXING_TOOLS.has(tool.name) ? (await workspaces.ensure(repo)).graph : (await workspaces.locate(repo))?.graph;
    if (!target) throw new Error(`${repo} is not indexed yet: call check_pull_request with one of its pull requests first`);
    // Nodes are keyed by the repository's indexed spelling; the tool reads pr_url from its input.
    if (prUrl) input.pr_url = await canonicalPrUrl(target, prUrl);
    return { graph: target, config, prUrl: input.pr_url as string | undefined };
  };
  const server = createMcpServer(resolve, config, {
    tools,
    instructions: workspaces
      ? `${MCP_INSTRUCTIONS} This is the hosted server: any public GitHub repository is indexed on first use (into a workspace graph named ${workspaces.prefix}<owner>); ` +
        'examples are not executed here; run them with the CLI (npx -y staleproof run <example-id> --pr <url>) or the GitHub Action.'
      : undefined,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}
