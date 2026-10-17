import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { GraphStore, OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import { buildDocsPatch } from '../patch.js';
import { runGraphCheck } from '../agent/graph-check.js';
import { checkReport } from '../format/report.js';
import { ensureIndexed } from '../indexer/ensure.js';
import { repoOfArgs } from './args.js';
import { canonicalPrUrl, refreshIfMoved } from '../pr/ingest.js';
import { parsePrUrl } from '../pr/github.js';
import { packageVersion } from '../pkg.js';
import { ALL_TOOLS, inputJsonSchema } from '../tools/index.js';
import type { ToolContext, ToolDef, ToolResult } from '../tools/types.js';
import { unknownParamsError } from '../tools/types.js';
import { auditTool } from '../audit.js';
import { docsForTool } from '../tools/docs-for.js';
import { checkChangesTool, repoOfCheckout } from '../pr/local.js';
import { parseRepoName } from '../indexer/repo.js';
import { DEFAULT_TARBALL_LIMITS } from '../indexer/tarball.js';
import { lintGitHubRepo, lintNew } from '../lint/diff.js';
import { lintRepo } from '../lint/engine.js';
import { lintSummaryLine } from '../lint/format.js';
import { isRuleId } from '../lint/rules.js';
import type { LintResult, RuleId } from '../lint/types.js';

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

/**
 * One call for the whole answer: the graph check (impact, clearance, ranking) as the
 * Markdown report the GitHub Action posts. Hosted servers index the repository first.
 */
export const checkPullRequestTool: ToolDef<{ pr_url: string; run_examples?: boolean }, { report: string; checkId: string; status: string }> = {
  name: 'check_pull_request',
  description:
    'Check a GitHub pull request for docs it can make false, in one call: the references in the docs and AI agent files it makes wrong (paths, links, commands, ' +
    'env vars; linted at both commits), every doc section and example the changed code reaches (with the evidence path), ' +
    'the changed symbols no doc reaches, ranked by PageRank, as a Markdown report. Start here; use impact/read_section/decisions_for to dig into one section.',
  input: z.object({
    pr_url: z.string().describe('https://github.com/<owner>/<repo>/pull/<n>'),
    run_examples: z.boolean().optional().describe('Also run up to 3 affected examples before and after the PR (local servers only; takes minutes)'),
  }),
  queries: [Q.impact, Q.clearance, Q.rankSections],
  async run(ctx, input) {
    const pr = parsePrUrl(input.pr_url).url;
    await refreshIfMoved(ctx.graph, ctx.config, pr);
    const r = await runGraphCheck(ctx, pr, { maxRuns: input.run_examples ? 3 : 0 });
    const report = await checkReport(ctx, ctx.graph.name, pr);
    return { tool: 'check_pull_request', summary: r.summary, data: { report, checkId: r.checkId, status: r.status }, queries: [] };
  },
};

type LintDocsInput = { repo?: string; ref?: string; dir?: string; new_only?: boolean; base?: string; rules?: string[]; files?: string[] };

/**
 * Graph-free: the stale references in a repository's docs, READMEs and AI agent files. By
 * repository (its public tarball, cached 10 minutes) anywhere; by local checkout on a local
 * server, where `new_only` keeps what the working tree introduced.
 */
export const lintDocsTool: ToolDef<LintDocsInput, LintResult> = {
  name: 'lint_docs',
  description:
    'Lint the docs, READMEs and AI agent instruction files (AGENTS.md, CLAUDE.md, Cursor and Copilot rules) of a repository: every path, link, anchor, command, ' +
    'CLI flag, env var and docstring parameter they name that the repository does not have, with the exact line and where Staleproof looked. No graph and no index needed. ' +
    'Pass repo (owner/name of a public GitHub repository, optionally ref), or on a local server dir (a checkout); with dir, new_only keeps only findings the working tree ' +
    'introduced (absent at base, default HEAD when there are uncommitted changes, else the merge base with the default branch).',
  input: z.object({
    repo: z.string().optional().describe('owner/name of a GitHub repository to lint from its tarball'),
    ref: z.string().optional().describe('With repo: a branch, tag or commit (default: the default branch)'),
    dir: z.string().optional().describe('Local servers only: a checkout to lint'),
    new_only: z.boolean().optional().describe('With dir: only findings absent at the base commit'),
    base: z.string().optional().describe('With dir and new_only: the commit to compare with'),
    rules: z.array(z.string()).optional().describe('Only these rule ids (see https://staleproof.dev/#/docs/rules)'),
    files: z.array(z.string()).optional().describe('Only findings in these files or about them'),
  }),
  queries: [],
  async run(ctx, input) {
    const bad = (input.rules ?? []).filter((r) => !isRuleId(r));
    if (bad.length) throw new Error(`unknown rule ${bad.join(', ')} (see https://staleproof.dev/#/docs/rules)`);
    const lint = { ...(input.rules?.length ? { rules: input.rules as RuleId[] } : {}), ...(input.files?.length ? { files: input.files } : {}) };
    let r: LintResult;
    if (input.dir !== undefined) {
      if (!ctx.allowDir) throw new Error('this server cannot read your disk: pass repo (owner/name) to lint a GitHub repository instead');
      const repo = input.repo ? parseRepoName(input.repo) : undefined;
      r = input.new_only
        ? await lintNew({ dir: input.dir, base: input.base, ...lint, ...(repo ? { repo } : {}) })
        : await lintRepo({ dir: input.dir, ...lint, ...(repo ? { repo } : {}) });
    } else {
      if (!input.repo) throw new Error('pass repo (owner/name), or dir on a local server');
      if (input.new_only) throw new Error('new_only needs dir (a local checkout to compare with its base commit)');
      if (input.ref !== undefined && (!/^[\w./-]{1,200}$/.test(input.ref) || input.ref.includes('..'))) throw new Error('ref must be a branch, tag or commit');
      // A token only on a local server: the hosted one reads public repositories only.
      r = await lintGitHubRepo(parseRepoName(input.repo), {
        ref: input.ref,
        home: ctx.config.home,
        token: ctx.allowDir ? ctx.config.githubToken : undefined,
        limits: DEFAULT_TARBALL_LIMITS,
        fetchImpl: (ctx as ToolContext & { fetchImpl?: typeof fetch }).fetchImpl,
        lint,
      });
    }
    const first = r.findings.slice(0, 5).map((f) => `${f.path}:${f.line} ${f.message}`);
    return { tool: 'lint_docs', summary: [lintSummaryLine(r), ...first].join('\n'), data: r, queries: [] };
  },
};

/** Tools that read no graph: they run without resolving (or indexing) one. */
const GRAPH_FREE = new Set(['lint_docs']);

export const MCP_TOOLS: ToolDef[] = [checkPullRequestTool, checkChangesTool, lintDocsTool, docsForTool, auditTool, ...ALL_TOOLS, docsPatchTool];

export const MCP_INSTRUCTIONS =
  "Staleproof keeps docs true to code over a FalkorDB graph of an organisation's repositories. For a pull request, call check_pull_request first: " +
  'it returns every doc section and example the change can make false, with the evidence path for each. To judge sections one by one: impact, ' +
  'read_section and run_example, decisions_for before editing, then propose_edit or record_verdict for every impacted section, and docs_patch for the diff. ' +
  'Before a pull request exists: docs_for_symbol says which docs depend on a function you are about to change, and check_changes says which docs your edits ' +
  'make false and which examples they break. With no change at all, audit_docs reports which examples no longer fit the code and which public API no doc covers. ' +
  'lint_docs needs no graph: it lists the paths, links, commands and env vars a repository\'s docs and AI agent files (AGENTS.md, CLAUDE.md) name that do not exist. ' +
  'Every graph result lists the Cypher it ran.';

/** Tool description for MCP clients: what it does, then the Cypher it runs. */
export function mcpDescription(tool: ToolDef): string {
  const primary = tool.queries[0];
  return primary ? `${tool.description}\n\nCypher (${primary.name}):\n${primary.cypher}` : tool.description;
}

export function mcpToolList(tools: ToolDef[] = MCP_TOOLS): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: mcpDescription(t),
    inputSchema: inputJsonSchema(t) as Tool['inputSchema'],
  }));
}

export function formatResult(r: ToolResult): CallToolResult {
  if (r.tool === 'check_pull_request') {
    const d = r.data as { report: string; checkId: string };
    return { content: [{ type: 'text', text: d.report }, { type: 'text', text: `Stored as check ${d.checkId}. ${r.summary}` }] };
  }
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

/** Where a tool call runs: the graph (and context) for its arguments. */
export type McpResolver = (tool: ToolDef, input: Record<string, unknown>) => Promise<ToolContext>;

export function createMcpServer(
  target: OrgGraph | McpResolver,
  config: Config,
  opts: { tools?: ToolDef[]; instructions?: string; /** A local server (stdio): graph-free tools may read the disk and use the token. */ local?: boolean } = {},
): Server {
  const tools = opts.tools ?? MCP_TOOLS;
  const resolve: McpResolver =
    typeof target === 'function' ? target : async (_tool, input) => ({ graph: target, config, prUrl: (input as { pr_url?: string }).pr_url });
  const server = new Server(
    { name: 'staleproof', version: packageVersion() },
    { capabilities: { tools: {} }, instructions: opts.instructions ?? MCP_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolList(tools) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
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
      // Graph-free tools skip the resolver: no graph to find, nothing to index first.
      const ctx = GRAPH_FREE.has(tool.name)
        ? ({ graph: typeof target === 'function' ? undefined : target, config, allowDir: opts.local === true } as ToolContext)
        : await resolve(tool, parsed.data as Record<string, unknown>);
      return formatResult(await tool.run(ctx, parsed.data));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
    }
  });
  return server;
}

/** `staleproof mcp`: serve the tools over stdio until the client disconnects. */
export async function serveMcp(store: GraphStore, config: Config, opts: { org?: string } = {}): Promise<void> {
  // The first check of a repository indexes it: nothing to set up before asking about a pull request.
  const server = createMcpServer(async (tool, input) => {
    const prUrl = typeof input.pr_url === 'string' ? input.pr_url : undefined;
    // Like the CLI: the graph named by --org/STALEPROOF_ORG, else the owner of the repository the call is about.
    // check_changes on a checkout names its repository through the checkout's origin remote.
    const checkoutRepo =
      tool.name === 'check_changes' && typeof input.repo !== 'string'
        ? await repoOfCheckout(typeof input.dir === 'string' ? input.dir : process.cwd()).catch(() => undefined)
        : undefined;
    const owner = (repoOfArgs(input) ?? checkoutRepo)?.split('/')[0];
    const graph = store.org(opts.org ?? owner ?? config.org);
    if (prUrl && ['check_pull_request', 'impact', 'clearance'].includes(tool.name)) {
      await ensureIndexed(graph, config, [parsePrUrl(prUrl).fullName], (p) => process.stderr.write(`staleproof: ${p.message}\n`));
    }
    const repos = Array.isArray(input.repos) ? (input.repos as string[]) : [];
    const progress = (p: { message: string }) => process.stderr.write(`staleproof: ${p.message}\n`);
    if ((tool.name === 'audit_docs' || tool.name === 'docs_for_symbol') && repos.length) await ensureIndexed(graph, config, repos, progress);
    if (tool.name === 'check_changes') {
      const repo = typeof input.repo === 'string' ? input.repo : checkoutRepo;
      if (!repo) throw new Error('name the repository (repo: owner/name), or run the server inside a GitHub checkout');
      await ensureIndexed(graph, config, [repo], progress);
    }
    if (prUrl) input.pr_url = await canonicalPrUrl(graph, prUrl);
    return { graph, config, prUrl: input.pr_url as string | undefined, allowDir: true };
  }, config, { local: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on('end', () => resolve());
  });
}
