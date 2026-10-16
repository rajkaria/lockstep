#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { loadConfig, orgSlug, setting } from './config.js';
import { collectFacts, factsMarkdown } from './facts.js';
import { GraphStore, redact } from './graph/client.js';
import { serveMcp } from './mcp/server.js';
import { serve } from '@hono/node-server';
import { createApp, defaultModelFactory } from './server/app.js';
import { Workspaces } from './hosted/workspaces.js';
import { indexOrg } from './indexer/index.js';
import { parseRepoName, type Checkout } from './indexer/repo.js';
import { checkoutOrDownload } from './indexer/ensure.js';
import { packageRoot, packageVersion } from './pkg.js';
import { clearanceText, dim, impactText, runText, traceLine } from './format/text.js';
import { AnthropicModel, claudeCredentialsAvailable, type Effort } from './agent/anthropic.js';
import { runAgentCheck } from './agent/loop.js';
import { runGraphCheck } from './agent/graph-check.js';
import type { TraceEvent } from './agent/trace.js';
import type { ClearedSymbol, ImpactData, RankedSection } from './tools/graph-tools.js';
import type { RunExampleData } from './tools/run-example.js';
import { runExampleTool } from './tools/run-example.js';
import { reviewVerdict, writeDecisionTool } from './tools/memory-tools.js';
import { buildDocsPatch, loadVerdicts } from './patch.js';
import { checkReport } from './format/report.js';
import { ensureIndexed } from './indexer/ensure.js';
import { openDocsPr } from './pr/open-pr.js';
import { parsePrUrl } from './pr/github.js';
import { canonicalPrUrl } from './pr/ingest.js';
import { impactTool } from './tools/graph-tools.js';
import type { ToolContext } from './tools/types.js';

const program = new Command();

program
  .name('staleproof')
  .description(
    'Keep docs true to code: a FalkorDB graph of code, docs and decisions across repositories, and an agent that checks every pull request against it.',
  )
  .version(packageVersion())
  .option('--org <org>', 'graph name, one per organisation; env STALEPROOF_ORG (default: the owner of the repository the command is about, else falkordb)')
  .option('--db <url>', 'FalkorDB URL; env FALKORDB_URL (default falkor://localhost:6379)');

/**
 * The graph a command uses when neither --org nor STALEPROOF_ORG names one: the owner of
 * the repository it is about (one graph per organisation), so `check acme/x#1` reads `acme`.
 */
let ownerOrg: string | undefined;
function aboutRepo(repoOrId: string): void {
  const owner = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\//.exec(repoOrId.trim())?.[1];
  if (owner) ownerOrg ??= owner;
}

function settings() {
  const opts = program.opts<{ org?: string; db?: string }>();
  const config = loadConfig();
  if (opts.org) config.org = orgSlug(opts.org);
  else if (!setting('ORG') && ownerOrg) config.org = orgSlug(ownerOrg);
  if (opts.db) config.falkordbUrl = opts.db;
  return config;
}

/** FALKORDB_URL was not given, so the default local server may be started for the user. */
function defaultLocalDb(): boolean {
  return !program.opts<{ db?: string }>().db && !process.env.FALKORDB_URL;
}

/**
 * Connect to FalkorDB. With `autoStart`, and no server configured, start a local one
 * (falkordblite, installed on first use) instead of failing: `npx staleproof check <pr>`
 * works on a machine with nothing set up.
 */
async function connect(config: ReturnType<typeof settings>, autoStart: boolean): Promise<GraphStore> {
  try {
    return await GraphStore.connect(config.falkordbUrl);
  } catch (err) {
    if (!autoStart || !defaultLocalDb()) throw err;
    log('No FalkorDB on localhost:6379: starting a local one (falkordblite; the first start installs it, which takes a minute).');
    try {
      execFileSync('bash', [join(packageRoot(), 'scripts', 'falkordb-local.sh'), 'start', '6379'], { stdio: ['ignore', 2, 2] });
    } catch {
      throw new Error(
        'could not start a local FalkorDB (see above). Start one yourself, e.g. docker run -d -p 6379:6379 falkordb/falkordb, or set FALKORDB_URL to a FalkorDB you have.',
      );
    }
    return GraphStore.connect(config.falkordbUrl);
  }
}

async function withGraph<T>(fn: (store: GraphStore, org: string) => Promise<T>, opts: { autoStart?: boolean } = {}): Promise<T> {
  const config = settings();
  const store = await connect(config, opts.autoStart ?? true);
  try {
    return await fn(store, config.org);
  } finally {
    await store.close();
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .command('index')
  .description('Index public GitHub repositories (code + docs) into the org graph')
  .argument('<repos...>', 'owner/name or GitHub URLs, e.g. FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs')
  .option('--ref <repo=ref>', 'check out a specific ref for one repository (repeatable)', collect, [])
  .option('--json', 'print the index report as JSON')
  .action(async (repos: string[], opts: { ref: string[]; json?: boolean }) => {
    aboutRepo(parseRepoName(repos[0] ?? ''));
    const config = settings();
    const refs = new Map(opts.ref.map((r) => r.split('=') as [string, string]).map(([k, v]) => [parseRepoName(k), v]));
    const names = repos.map(parseRepoName);
    aboutRepo(names[0]!);
    const checkouts: Checkout[] = [];
    for (const name of names) {
      log(`checkout  ${name}${refs.has(name) ? `@${refs.get(name)}` : ''}`);
      checkouts.push(await checkoutOrDownload(config, name, refs.get(name)));
    }
    await withGraph(async (store, org) => {
      const report = await indexOrg(store.org(org), checkouts, (p) => log(`${p.phase.padEnd(9)} ${p.message}`));
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(`\nIndexed ${report.repos.length} repositories into graph "${report.org}" in ${(report.ms / 1000).toFixed(1)}s\n`);
      for (const r of report.repos) {
        console.log(
          `  ${r.repo.padEnd(28)} ${r.sha.slice(0, 7)}  ${String(r.symbols).padStart(5)} symbols  ` +
            `${String(r.calls.exact + r.calls.byName).padStart(5)} calls (${r.calls.crossRepo} cross-repo)` +
            (r.parseErrors.length ? `  ${r.parseErrors.length} parse errors` : ''),
        );
      }
      for (const d of report.docs) {
        console.log(
          `  ${d.repo.padEnd(28)} docs     ${String(d.sections).padStart(5)} sections ${String(d.examples.total).padStart(5)} examples  ` +
            `${d.uses.exact + d.uses.byName} uses  ${d.mentions} mentions  ${d.links} links` +
            (d.mismatches ? `  ${d.mismatches} mismatch${d.mismatches === 1 ? '' : 'es'} (staleproof audit ${d.repo})` : ''),
        );
      }
      for (const dep of report.dependsOn) console.log(`  ${dep.from} → ${dep.to} (${dep.spec})`);
    });
  });

program
  .command('check')
  .description('Check a pull request against the org graph: impacted docs with evidence paths, clearance, ranking')
  .argument('<pr-url>', 'https://github.com/<owner>/<repo>/pull/<n>')
  .option('--no-agent', 'run the graph tools in a fixed order instead of the agent')
  .option('--model <id>', 'Claude model for the agent (env STALEPROOF_MODEL)')
  .option('--effort <level>', 'low | medium | high | xhigh | max (env STALEPROOF_EFFORT)')
  .option('--max-steps <n>', 'model turns before the agent stops', '40')
  .option('--max-hops <n>', 'maximum call hops between a changed symbol and a doc (--no-agent)', '3')
  .option('--runs <n>', 'with --no-agent: run up to n impacted examples before and after the PR', '3')
  .option('--json', 'print JSON')
  .option('--format <format>', 'text | markdown (a PR comment)', 'text')
  .option('--out <file>', 'write the markdown comment to a file')
  .option('--with <repos...>', 'repositories to index together with the pull request\'s on first use (e.g. a docs site)', [])
  .option('--no-index', 'fail instead of indexing the repository when the graph does not have it yet')
  .action(async (prUrl: string, opts: { agent: boolean; model?: string; effort?: string; maxSteps: string; maxHops: string; runs: string; json?: boolean; format: string; out?: string; with: string[]; index: boolean }) => {
    aboutRepo(parsePrUrl(prUrl).fullName);
    await withGraph(async (store, org) => {
      const config = settings();
      const ctx: ToolContext = { graph: store.org(org), config, log };
      if (opts.index) {
        const report = await ensureIndexed(ctx.graph, config, [parsePrUrl(prUrl).fullName, ...opts.with], (p) => log(`${p.phase.padEnd(9)} ${p.message}`));
        if (report) log(`indexed ${report.repos.map((r) => `${r.repo}@${r.sha.slice(0, 7)}`).join(', ')} into graph "${org}" in ${(report.ms / 1000).toFixed(1)}s`);
      }
      prUrl = await canonicalPrUrl(ctx.graph, prUrl);
      if (opts.agent && !config.anthropicApiKey && !claudeCredentialsAvailable()) {
        log('No model API key (ANTHROPIC_API_KEY): running graph mode. Set a key for agent mode, or pass --no-agent to skip this note.');
        opts.agent = false;
      }
      if (opts.agent) {
        const model = new AnthropicModel({
          model: opts.model ?? config.model,
          effort: (opts.effort as Effort | undefined) ?? config.effort,
          fallbacks: config.fallbacks,
          apiKey: config.anthropicApiKey,
          baseURL: config.modelBaseUrl,
          compatible: config.modelCompatible,
        });
        const r = await runAgentCheck(ctx, model, prUrl, {
          maxSteps: Number(opts.maxSteps),
          onEvent: (e) => {
            if (opts.json) return;
            if (e.type === 'delta') return;
            const line = traceLine(e);
            if (line) console.log(line);
          },
        });
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else console.log(dim(`\nPatch: staleproof patch ${r.pr}   Trace: stored on ${r.checkId}`));
        if (opts.format === 'markdown') await emitMarkdown(ctx, org, r.pr, opts.out, r.summary);
        if (r.status === 'error' || r.status === 'refused') process.exitCode = 1;
        return;
      }
      // Graph mode: the same tools in a fixed order, no model; stored as a Check like agent runs.
      const r = await runGraphCheck(ctx, prUrl, { maxRuns: Number(opts.runs), maxHops: Number(opts.maxHops), onEvent: opts.format === 'markdown' ? (e) => {
        const line = traceLine(e);
        if (line) log(line);
      } : undefined });
      if (opts.format === 'markdown') {
        await emitMarkdown(ctx, org, r.pr, opts.out);
        if (r.status === 'error') process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      const data = (name: string) =>
        r.events.find((e): e is Extract<TraceEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.name === name && !e.isError)?.data;
      const impact = data('impact') as ImpactData | undefined;
      const cleared = (data('clearance') as { cleared: ClearedSymbol[] } | undefined)?.cleared ?? [];
      const ranked = (data('rank_sections') as { ranked: RankedSection[] } | undefined)?.ranked;
      if (impact) console.log(impactText(impact, ranked));
      console.log('');
      console.log(clearanceText(cleared));
      for (const e of r.events) {
        if (e.type === 'tool_result' && e.name === 'run_example' && !e.isError) console.log(`\n${runText(e.data as RunExampleData)}`);
      }
      console.log(dim(`\n${r.summary}\nStored as ${r.checkId}.`));
    });
  });

program
  .command('run')
  .description('Run a docs code example in the sandbox (before and after a PR with --pr)')
  .argument('<example-id>', 'CodeExample id, e.g. FalkorDB/docs:commands/graph.explain.mdx:0')
  .option('--pr <url>', 'run at the commit before the pull request and at the pull request')
  .option('--fresh', 're-run even if an identical run is recorded (replaces it)')
  .option('--json', 'print JSON')
  .action(async (exampleId: string, opts: { pr?: string; fresh?: boolean; json?: boolean }) => {
    aboutRepo(exampleId);
    await withGraph(async (store, org) => {
      const ctx: ToolContext = { graph: store.org(org), config: settings(), log, freshRuns: opts.fresh };
      if (opts.pr) await impactTool.run(ctx, { pr_url: opts.pr });
      const r = await runExampleTool.run(ctx, { example_id: exampleId, pr_url: opts.pr });
      if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(runText(r.data));
      console.log('');
      console.log(r.summary);
    });
  });

program
  .command('decide')
  .description('Record a maintainer decision; future checks cite it instead of re-flagging')
  .argument('<text>', 'the decision, in one sentence')
  .requiredOption('--governs <id...>', 'DocSection and/or Symbol ids it governs')
  .option('--source <url>', 'where it was decided (issue, PR comment, ADR)')
  .option('--author <name>', 'who decided')
  .option('--supersedes <decision-id>', 'the decision this replaces')
  .action(async (text: string, opts: { governs: string[]; source?: string; author?: string; supersedes?: string }) => {
    aboutRepo(opts.governs[0] ?? '');
    await withGraph(async (store, org) => {
      const r = await writeDecisionTool.run(
        { graph: store.org(org), config: settings() },
        { text, governs: opts.governs, source_url: opts.source, author: opts.author, supersedes: opts.supersedes },
      );
      console.log(r.summary);
    });
  });

program
  .command('verdict')
  .description('Accept or reject a verdict (maintainer feedback; measures precision)')
  .argument('<action>', 'accept | reject')
  .argument('<verdict-id>')
  .option('--by <name>', 'reviewer', process.env.USER ?? 'maintainer')
  .action(async (action: string, id: string, opts: { by: string }) => {
    if (action !== 'accept' && action !== 'reject') throw new Error('action must be accept or reject');
    await withGraph(async (store, org) => {
      const ok = await reviewVerdict({ graph: store.org(org), config: settings() }, id, action === 'accept' ? 'accepted' : 'rejected', opts.by);
      if (!ok) throw new Error(`no verdict ${id}`);
      console.log(`${id} ${action}ed`);
    });
  });

program
  .command('patch')
  .description('Print the docs patch for a checked pull request (unified diff + PR description with evidence paths)')
  .argument('<pr-url>')
  .option('--out <file>', 'write the diff to a file (the description goes to <file>.md)')
  .option('--open-pr', 'open the fix as a pull request in your fork (needs GITHUB_TOKEN)')
  .option('--upstream', 'with --open-pr: target the original repository instead of your fork')
  .action(async (prUrl: string, opts: { out?: string; openPr?: boolean; upstream?: boolean }) => {
    aboutRepo(parsePrUrl(prUrl).fullName);
    await withGraph(async (store, org) => {
      const config = settings();
      const patch = await buildDocsPatch({ graph: store.org(org), config }, parsePrUrl(prUrl).url);
      if (opts.out) {
        await writeFile(opts.out, patch.diff);
        await writeFile(`${opts.out}.md`, `# ${patch.title}\n\n${patch.body}\n`);
        log(`wrote ${opts.out} and ${opts.out}.md (${patch.files.length} files)`);
      } else {
        console.log(patch.diff || dim('(no proposed edits)'));
        console.log(`# ${patch.title}\n\n${patch.body}`);
      }
      if (opts.openPr) {
        const opened = await openDocsPr(patch, { token: config.githubToken ?? '', target: opts.upstream ? 'upstream' : 'fork' });
        for (const o of opened) console.log(`opened ${o.url} (${o.target})`);
      }
    });
  });

program
  .command('mcp')
  .description('Serve the Staleproof tools over MCP (stdio). Claude Code: claude mcp add staleproof -- npx -y staleproof mcp')
  .action(async () => {
    await withGraph(async (store) => {
      const org = program.opts<{ org?: string }>().org ?? setting('ORG');
      log(`staleproof mcp: serving ${org ? `graph "${orgSlug(org)}"` : "each repository's owner graph"} from ${redact(settings().falkordbUrl)}`);
      await serveMcp(store, settings(), { org: org ? orgSlug(org) : undefined });
    });
  });

program
  .command('serve')
  .description('Serve the web demo and its API (paste a PR, watch the trace)')
  .option('--port <port>', 'port (env PORT)', process.env.PORT ?? '8080')
  .option('--host <host>', 'interface to bind', process.env.HOST ?? '127.0.0.1')
  .option('--preload <urls...>', 'pull requests listed on the home page (env STALEPROOF_PRELOADED, comma-separated)')
  .option('--hosted', 'index any public repository on demand into its own workspace graph, like staleproof.dev (env STALEPROOF_HOSTED=on)')
  .action(async (opts: { port: string; host: string; preload?: string[]; hosted?: boolean }) => {
    const config = settings();
    const store = await connect(config, true);
    const preloaded = opts.preload ?? setting('PRELOADED')?.split(',').map((s) => s.trim()).filter(Boolean);
    const model = defaultModelFactory(config);
    const hosted = opts.hosted || setting('HOSTED') === 'on';
    const workspaces = hosted ? new Workspaces(store, config, store.org(config.org)) : undefined;
    const app = createApp({ store, config, model, preloaded, workspaces, agentChecksPerDay: Number(setting('AGENT_CHECKS_PER_DAY') ?? 50) });
    serve({ fetch: app.fetch, port: Number(opts.port), hostname: opts.host }, (info) => {
      log(
        `staleproof serve: http://${opts.host}:${info.port} (graph "${config.org}"${hosted ? ', hosted: any public repository on demand' : ''}, ` +
          `agent ${model ? `on, ${config.model}` : 'off: no model credentials, graph mode only'}; MCP at /api/mcp)`,
      );
    });
  });

program
  .command('facts')
  .description('Write FACTS.md: every number Staleproof quotes, computed from the graph')
  .option('--out <file>', 'output file', 'docs/FACTS.md')
  .option('--json', 'print JSON instead of writing Markdown')
  .action(async (opts: { out: string; json?: boolean }) => {
    await withGraph(async (store, org) => {
      const facts = await collectFacts(store.org(org), await store.serverVersion());
      if (opts.json) {
        console.log(JSON.stringify(facts, null, 2));
        return;
      }
      await writeFile(opts.out, factsMarkdown(facts));
      log(`wrote ${opts.out}`);
    });
  });

program
  .command('db')
  .description('Run a local FalkorDB without Docker (falkordblite binaries, installed once via uv or pip)')
  .argument('<action>', 'start | stop | status')
  .option('--port <port>', 'port', '6379')
  .action((action: string, opts: { port: string }) => {
    execFileSync('bash', [join(packageRoot(), 'scripts', 'falkordb-local.sh'), action, opts.port], { stdio: 'inherit' });
  });

async function emitMarkdown(ctx: ToolContext, org: string, prUrl: string, out: string | undefined, agentSummary?: string): Promise<void> {
  const md = await checkReport(ctx, org, prUrl, agentSummary);
  if (out) {
    await writeFile(out, `${md}\n`);
    log(`wrote ${out}`);
  } else {
    console.log(md);
  }
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`staleproof: ${err.message}`);
  process.exit(1);
});
