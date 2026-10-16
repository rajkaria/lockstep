import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import { buildDocsPatch } from '../patch.js';
import { parsePrUrl } from '../pr/github.js';
import { packageVersion } from '../pkg.js';
import { ALL_TOOLS, inputJsonSchema } from '../tools/index.js';
import type { ToolDef, ToolResult } from '../tools/types.js';
import { unknownParamsError } from '../tools/types.js';

/** A tool only MCP clients get: the docs patch, for the human driving Claude Code to apply locally. */
const docsPatchTool: ToolDef<{ pr_url: string }, { diff: string; title: string; body: string; files: string[] }> = {
  name: 'docs_patch',
  description:
    'The docs fix for a checked pull request as a git-apply-able unified diff, plus a PR description with the evidence path behind each edited section. Built from the latest proposed edits.',
  input: z.object({ pr_url: z.string() }),
  queries: [Q.verdictsForPr],
  async run(ctx, input) {
    const patch = await buildDocsPatch(ctx, parsePrUrl(input.pr_url).url);
    return {
      tool: 'docs_patch',
      summary: patch.files.length
        ? `${patch.files.length} file(s) changed: ${patch.files.map((f) => `${f.repo}:${f.path}`).join(', ')}.`
        : 'No proposed edits for this pull request yet.',
      data: { diff: patch.diff, title: patch.title, body: patch.body, files: patch.files.map((f) => `${f.repo}:${f.path}`) },
      queries: [],
    };
  },
};

export const MCP_TOOLS: ToolDef[] = [...ALL_TOOLS, docsPatchTool];

/** Tool description for MCP clients: what it does, then the Cypher it runs. */
export function mcpDescription(tool: ToolDef): string {
  const primary = tool.queries[0];
  return primary ? `${tool.description}\n\nCypher (${primary.name}):\n${primary.cypher}` : tool.description;
}

export function mcpToolList(): Tool[] {
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    description: mcpDescription(t),
    inputSchema: inputJsonSchema(t) as Tool['inputSchema'],
  }));
}

export function formatResult(r: ToolResult): CallToolResult {
  const cypher = r.queries
    .filter((q) => q.name !== 'adhoc')
    .map((q) => `-- ${q.name} (${q.rows} rows, ${q.ms.toFixed(2)} ms)\n${q.cypher}`)
    .join('\n\n');
  return {
    content: [
      { type: 'text', text: r.summary },
      { type: 'text', text: JSON.stringify(r.data, null, 2) },
      ...(cypher ? [{ type: 'text' as const, text: `Cypher run on FalkorDB:\n${cypher}` }] : []),
    ],
  };
}

export function createMcpServer(graph: OrgGraph, config: Config): Server {
  const server = new Server(
    { name: 'lockstep', version: packageVersion() },
    {
      capabilities: { tools: {} },
      instructions:
        'Lockstep keeps docs true to code over a FalkorDB graph of an organisation\'s repositories. For a pull request: call impact first, ' +
        'read_section and run_example to judge each impacted section, decisions_for before editing, then propose_edit or record_verdict for every impacted section, ' +
        'and docs_patch to get the diff. Every result lists the Cypher it ran.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = MCP_TOOLS.find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const unknownError = unknownParamsError(tool, args);
    if (unknownError) return { isError: true, content: [{ type: 'text', text: unknownError }] };
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) {
      return {
        isError: true,
        content: [{ type: 'text', text: `invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` }],
      };
    }
    try {
      const prUrl = (parsed.data as { pr_url?: string }).pr_url;
      return formatResult(await tool.run({ graph, config, prUrl }, parsed.data));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
    }
  });
  return server;
}

/** `lockstep-docs mcp`: serve the tools over stdio until the client disconnects. */
export async function serveMcp(graph: OrgGraph, config: Config): Promise<void> {
  const server = createMcpServer(graph, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on('end', () => resolve());
  });
}
