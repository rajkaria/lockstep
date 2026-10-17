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
import { clearanceText, dim, impactText, newFindingsText, runText, traceLine } from './format/text.js';
import { AnthropicModel, claudeCredentialsAvailable, type Effort } from './agent/anthropic.js';
import { runAgentCheck } from './agent/loop.js';
import { prNewFindings, runGraphCheck } from './agent/graph-check.js';
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
import { canonicalPrUrl, refreshIfMoved } from './pr/ingest.js';
import { impactTool } from './tools/graph-tools.js';
import type { ToolContext } from './tools/types.js';
import { auditDocs } from './audit.js';
import { auditMarkdown, auditText } from './format/audit.js';
import { docsForTool } from './tools/docs-for.js';
import { analyzeChanges, localChanges, worktreeFindings } from './pr/local.js';
import { checkMarkdown } from './format/markdown.js';
import { lintRepo } from './lint/engine.js';
import { cacheEnabled, ParseCache } from './lint/cache.js';
import { lintNew, lintStaged } from './lint/diff.js';
import { formatGithub, formatLint, lintExitCode, lintSummaryLine, LINT_FORMATS, type LintFormat } from './lint/format.js';
import { isRuleId } from './lint/rules.js';
import type { RuleId } from './lint/types.js';

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
  .description('Check a pull request against the org graph: impacted docs with evidence paths, clearance, ranking. With no pull request: your working tree')
  .argument('[pr-url]', 'https://github.com/<owner>/<repo>/pull/<n> (omit to check the uncommitted and unpushed changes of the checkout you are in)')
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
  .option('--dir <path>', 'without a pull request: the checkout to check (default: the current directory)')
  .option('--base <ref>', 'without a pull request: compare with this commit (default: merge base with the remote default branch)')
  .option('--repo <owner/name>', 'without a pull request: the GitHub repository the checkout is (default: from its origin remote)')
  .option('--fail-on-predicted', 'exit 1 when an example is predicted to break (a pre-push hook or CI gate)')
  .option('--annotations', 'also print the docs references the pull request makes wrong as GitHub workflow commands (annotations in a GitHub Actions job)')
  .action(async (prUrl: string | undefined, opts: { agent: boolean; model?: string; effort?: string; maxSteps: string; maxHops: string; runs: string; json?: boolean; format: string; out?: string; with: string[]; index: boolean; dir?: string; base?: string; repo?: string; failOnPredicted?: boolean; annotations?: boolean }) => {
    if (!prUrl) {
      await checkLocal(opts);
      return;
    }
    await checkPr(prUrl, opts);
  });

async function checkPr(prUrl: string, opts: { agent: boolean; model?: string; effort?: string; maxSteps: string; maxHops: string; runs: string; json?: boolean; format: string; out?: string; with: string[]; index: boolean; annotations?: boolean }) {
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
      if (await refreshIfMoved(ctx.graph, config, prUrl)) log(`${prUrl} has new commits since it was last checked: reading its current diff`);
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
        if (opts.annotations) await emitAnnotations(ctx, r.pr);
        if (r.status === 'error' || r.status === 'refused') process.exitCode = 1;
        return;
      }
      // Graph mode: the same tools in a fixed order, no model; stored as a Check like agent runs.
      const r = await runGraphCheck(ctx, prUrl, { maxRuns: Number(opts.runs), maxHops: Number(opts.maxHops), onEvent: opts.format === 'markdown' ? (e) => {
        const line = traceLine(e);
        if (line) log(line);
      } : undefined });
      if (opts.annotations) await emitAnnotations(ctx, r.pr);
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
      if (r.newFindings) console.log(`${newFindingsText(r.newFindings)}\n`);
      if (impact) console.log(impactText(impact, ranked));
      console.log('');
      console.log(clearanceText(cleared));
      for (const e of r.events) {
        if (e.type === 'tool_result' && e.name === 'run_example' && !e.isError) console.log(`\n${runText(e.data as RunExampleData)}`);
      }
      console.log(dim(`\n${r.summary}\nStored as ${r.checkId}.`));
    });
}

/** `staleproof check` with no pull request: the working tree, statically (nothing runs, nothing is written). */
async function checkLocal(opts: { dir?: string; base?: string; repo?: string; json?: boolean; format: string; out?: string; with: string[]; index: boolean; failOnPredicted?: boolean }) {
  const local = await localChanges(opts.dir ?? process.cwd(), { base: opts.base, repo: opts.repo });
  aboutRepo(local.repo);
  await withGraph(async (store, org) => {
    const config = settings();
    const graph = store.org(org);
    if (opts.index) {
      const report = await ensureIndexed(graph, config, [local.repo, ...opts.with], (p) => log(`${p.phase.padEnd(9)} ${p.message}`));
      if (report) log(`indexed ${report.repos.map((r) => `${r.repo}@${r.sha.slice(0, 7)}`).join(', ')} into graph "${org}" in ${(report.ms / 1000).toFixed(1)}s`);
    }
    const label = {
      url: `https://github.com/${local.repo}/compare/${local.base}...${local.branch}`,
      title: `Working tree of ${local.branch} against ${local.base.slice(0, 7)}`,
    };
    const r = await analyzeChanges(graph, config.home, local.repo, local.diff, label);
    // Docs references the working tree makes wrong (lint at the base and on disk).
    const newFindings = await worktreeFindings(local).catch((err: Error) => void log(`docs references not checked: ${err.message}`));
    if (newFindings) r.data.newFindings = newFindings;
    if (opts.json) console.log(JSON.stringify({ summary: r.summary, ...r.data }, null, 2));
    else if (opts.format === 'markdown') {
      const md = checkMarkdown({ impact: r.data.impact, summary: r.summary, cleared: r.data.cleared, org, ...(newFindings ? { newFindings } : {}) });
      if (opts.out) await writeFile(opts.out, `${md}\n`);
      else console.log(md);
    } else {
      if (newFindings) console.log(`${newFindingsText(newFindings, 'these changes')}\n`);
      console.log(impactText(r.data.impact));
      console.log('');
      console.log(clearanceText(r.data.cleared));
      console.log(dim(`\n${r.summary}\nStatic check of the working tree: nothing was run or written to the graph. Push and open a pull request to run the examples before and after.`));
    }
    if (opts.failOnPredicted && r.data.impact.predicted.length) process.exitCode = 1;
  });
}

program
  .command('docs-for')
  .description('Which docs depend on a symbol, with the path for each: what to update before you change it')
  .argument('<symbol>', 'owner/repo:pkg.mod.Class.method, pkg.mod.Class.method, Class.method or a bare name')
  .option('--repo <owner/name...>', 'only symbols defined in these repositories', [])
  .option('--json', 'print JSON')
  .action(async (symbol: string, opts: { repo: string[]; json?: boolean }) => {
    if (opts.repo[0]) aboutRepo(opts.repo[0]);
    else aboutRepo(symbol);
    await withGraph(async (store, org) => {
      const r = await docsForTool.run({ graph: store.org(org), config: settings(), log }, { symbol, repos: opts.repo.length ? opts.repo.map(parseRepoName) : undefined });
      if (opts.json) {
        console.log(JSON.stringify({ summary: r.summary, ...r.data }, null, 2));
        return;
      }
      for (const s of r.data.symbols) console.log(`${s.qualname} ${dim(`${s.kind} · ${s.repo}`)}\n  ${dim(s.signature)}`);
      if (r.data.symbols.length) console.log('');
      for (const s of r.data.sections) {
        console.log(`  ${s.heading} ${dim(`[${s.repo}] ${s.hops} hops, ${s.confidence}${s.examples.length ? `, ${s.examples.length} example(s)` : ''}`)}`);
        console.log(`    ${dim('path:')} ${s.evidence.join(dim(' ← '))}`);
        console.log(`    ${dim(s.url)}`);
      }
      for (const m of r.data.mismatched) console.log(`  ! ${m.example} line ${m.line}: ${m.detail}`);
      console.log(dim(`\n${r.summary}`));
    });
  });

program
  .command('audit')
  .description('Audit docs with no pull request: health score, examples that no longer fit the code, API coverage, example runs')
  .argument('[repos...]', 'repositories to audit as owner/name (default: every repository in the graph); indexed together on first use')
  .option('--run <n>', 'first run up to n examples at the indexed commits (Python needs 3.12+ and uv; JavaScript and TypeScript need Node)', '0')
  .option('--limit <n>', 'how many undocumented symbols to list', '25')
  .option('--format <format>', 'text | markdown | json', 'text')
  .option('--out <file>', 'write the report to a file instead of stdout')
  .option('--fail-under <score>', 'exit 1 when the health score is below this')
  .option('--fail-on-mismatch', 'exit 1 when any example no longer fits the code')
  .option('--no-index', 'fail instead of indexing repositories the graph does not have yet')
  .action(async (repos: string[], opts: { run: string; limit: string; format: string; out?: string; failUnder?: string; failOnMismatch?: boolean; index: boolean }) => {
    if (!['text', 'markdown', 'json'].includes(opts.format)) throw new Error(`unknown --format ${opts.format} (text, markdown or json)`);
    for (const flag of ['run', 'limit'] as const) {
      if (!/^\d+$/.test(opts[flag])) throw new Error(`--${flag} must be a whole number, got ${opts[flag]}`);
    }
    if (opts.failUnder !== undefined && !/^\d+$/.test(opts.failUnder)) throw new Error(`--fail-under must be a score from 0 to 100, got ${opts.failUnder}`);
    if (repos[0]) aboutRepo(repos[0]);
    await withGraph(async (store, org) => {
      const config = settings();
      const ctx: ToolContext = { graph: store.org(org), config, log };
      const names = repos.map(parseRepoName);
      if (names.length && opts.index) {
        const report = await ensureIndexed(ctx.graph, config, names, (p) => log(`${p.phase.padEnd(9)} ${p.message}`));
        if (report) log(`indexed ${report.repos.map((r) => `${r.repo}@${r.sha.slice(0, 7)}`).join(', ')} into graph "${org}" in ${(report.ms / 1000).toFixed(1)}s`);
      }
      const r = await auditDocs(ctx, { repos: names.length ? names : undefined, run: Number(opts.run), limit: Number(opts.limit) });
      const body =
        opts.format === 'json' ? JSON.stringify({ summary: r.summary, ...r.data }, null, 2) : opts.format === 'markdown' ? auditMarkdown(r.data, r.summary) : auditText(r.data, r.summary);
      if (opts.out) {
        await writeFile(opts.out, `${body}\n`);
        log(`wrote ${opts.out}: ${r.summary}`);
      } else {
        console.log(body);
      }
      if (opts.failUnder !== undefined && r.data.score < Number(opts.failUnder)) {
        log(`health score ${r.data.score} is below --fail-under ${opts.failUnder}`);
        process.exitCode = 1;
      }
      if (opts.failOnMismatch && r.data.mismatches.length) {
        log(`${r.data.examples.mismatched} example(s) no longer fit the code (--fail-on-mismatch)`);
        process.exitCode = 1;
      }
    });
  });

program
  .command('lint')
  .description('Check every claim the docs, READMEs and AI agent files (AGENTS.md, CLAUDE.md, Cursor rules) make about the repository: paths, links, anchors and docs examples. No graph, no network.')
  .argument('[dir]', 'the checkout to lint', '.')
  .option('--format <format>', `${LINT_FORMATS.join(' | ')}`, 'text')
  .option('--out <file>', 'write the report to a file instead of stdout')
  .option('--fail-on <level>', 'exit 1 when a finding is at or above: error | warning | info | never', 'error')
  .option('--rule <ids...>', 'only these rules')
  .option('--disable <ids...>', 'skip these rules')
  .option('--files <paths...>', 'report only findings in these files or about them')
  .option('--with <dirs...>', 'other local checkouts whose code the docs examples call (an SDK next to a docs repo)', [])
  .option('--no-examples', 'skip the static checks of docs code examples (the symbol and docstring rules still parse the code)')
  .option('--repo <owner/name>', 'the GitHub repository the checkout is (default: from its origin remote)')
  .option('--new', 'only findings the changes introduced: absent at the base commit')
  .option('--base <ref>', 'with --new: the commit to compare with (default: HEAD with uncommitted changes, else the merge base with the default branch)')
  .option('--staged', 'lint the git index (what the next commit contains) instead of the files on disk')
  .option('--no-cache', 'parse every file again instead of reading the local parse cache (.staleproof/cache)')
  .action(
    async (
      dir: string,
      opts: { format: string; out?: string; failOn: string; rule?: string[]; disable?: string[]; files?: string[]; with: string[]; examples: boolean; repo?: string; new?: boolean; base?: string; staged?: boolean; cache: boolean },
    ) => {
      if (opts.base && !opts.new) throw new Error('--base needs --new (compare with that commit)');
      if (!LINT_FORMATS.includes(opts.format as LintFormat)) throw new Error(`unknown --format ${opts.format} (${LINT_FORMATS.join(', ')})`);
      if (!['error', 'warning', 'info', 'never'].includes(opts.failOn)) throw new Error(`--fail-on must be error, warning, info or never (got ${opts.failOn})`);
      const ids = (xs?: string[]): RuleId[] | undefined => {
        if (!xs) return undefined;
        const bad = xs.filter((x) => !isRuleId(x));
        if (bad.length) throw new Error(`unknown rule ${bad.join(', ')} (see https://staleproof.dev/#/docs/rules)`);
        return xs as RuleId[];
      };
      const lintOpts = {
        dir,
        rules: ids(opts.rule),
        disable: ids(opts.disable),
        files: opts.files,
        with: opts.with,
        examples: opts.examples,
        ...(opts.repo ? { repo: parseRepoName(opts.repo) } : {}),
        // One cache instance, so the temporary trees of --new and --staged read and fill the checkout's own.
        ...(opts.cache && cacheEnabled() ? { cache: await ParseCache.open(dir) } : {}),
      };
      // --new: findings absent at the base commit; --staged: the index instead of the disk (src/lint/diff.ts).
      const diff = opts.new ? await lintNew({ ...lintOpts, base: opts.base, staged: opts.staged }) : undefined;
      const r = diff ?? (opts.staged ? await lintStaged(lintOpts) : await lintRepo(lintOpts));
      if (diff) log(`new findings only: ${diff.head.label} against ${diff.base.label} (${diff.base.why}); ${diff.fixed} fixed`);
      const body = formatLint(r, opts.format as LintFormat);
      if (opts.out) {
        await writeFile(opts.out, `${body}\n`);
        log(`wrote ${opts.out}: ${lintSummaryLine(r)}`);
      } else if (body) {
        console.log(body);
      }
      process.exitCode = lintExitCode(r, opts.failOn as 'error' | 'warning' | 'info' | 'never');
    },
  );

program
  .command('hook')
  .description('Coding-agent hooks (Claude Code, Cursor): read the hook JSON on stdin, print what the agent should know about the docs its edits made wrong. Silent when nothing is; never fails the agent; nothing leaves the machine.')
  .argument('<event>', 'session-start | post-edit | stop')
  .option('--cursor', "Cursor's hook JSON (default: read from the input)")
  .option('--no-graph', 'stop: skip predicted breaks from a FalkorDB already running on this machine')
  .action(async (event: string, opts: { cursor?: boolean; graph: boolean }) => {
    const { HOOK_EVENTS, readStdin, runHook } = await import('./hooks/index.js');
    if (!HOOK_EVENTS.includes(event as (typeof HOOK_EVENTS)[number])) throw new Error(`unknown hook ${event} (${HOOK_EVENTS.join(', ')})`);
    const r = await runHook(event as (typeof HOOK_EVENTS)[number], await readStdin(process.stdin), { dialect: opts.cursor ? 'cursor' : undefined, graph: opts.graph });
    // Exit at once: a hook that gave up must not wait for the work it abandoned.
    process.stdout.write(r.stdout ? `${r.stdout}\n` : '', () => process.exit(0));
  });

program
  .command('init')
  .description('Set Staleproof up in a repository: .staleproof.toml, the GitHub workflow, a README badge, the pre-commit hook, Claude Code or Cursor hooks. Asks first; --yes takes the detected defaults; idempotent.')
  .argument('[dir]', 'the repository', '.')
  .option('-y, --yes', 'take the detected defaults without asking')
  .option('--dry-run', 'print what would be written, and write nothing')
  .option('--claude', 'add the Staleproof hooks to .claude/settings.json (without the plugin)')
  .option('--cursor', 'add the Staleproof hooks to .cursor/hooks.json')
  .option('--docs-repo <owner/name>', 'the docs live in another repository: index it with this one in the workflow')
  .option('--skip <items...>', 'leave these out: config, workflow, badge, pre-commit, gitignore, vscode')
  .action(async (dir: string, opts: { yes?: boolean; dryRun?: boolean; claude?: boolean; cursor?: boolean; docsRepo?: string; skip?: string[] }) => {
    const { INIT_SKIPS, runInit, terminalAsker } = await import('./init/index.js');
    const bad = (opts.skip ?? []).filter((s) => !INIT_SKIPS.includes(s as (typeof INIT_SKIPS)[number]));
    if (bad.length) throw new Error(`unknown --skip ${bad.join(', ')} (${INIT_SKIPS.join(', ')})`);
    const interactive = !opts.yes && !!process.stdin.isTTY && !!process.stdout.isTTY;
    const r = await runInit({
      dir,
      dryRun: opts.dryRun,
      claude: opts.claude,
      cursor: opts.cursor,
      docsRepo: opts.docsRepo ? parseRepoName(opts.docsRepo) : undefined,
      skip: (opts.skip ?? []) as (typeof INIT_SKIPS)[number][],
      ask: interactive ? terminalAsker() : undefined,
    });
    console.log(r.text);
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
  .option('--in-repo', 'with --open-pr: a branch and pull request in the docs repository itself, no fork (what a CI token can do)')
  .option('--base <branch>', 'with --in-repo: the branch the fix targets (default: the default branch), e.g. the checked pull request\'s branch')
  .option('--only <repos...>', 'with --in-repo: only these repositories (others are skipped)')
  .action(async (prUrl: string, opts: { out?: string; openPr?: boolean; upstream?: boolean; inRepo?: boolean; base?: string; only?: string[] }) => {
    if (opts.upstream && opts.inRepo) throw new Error('--upstream and --in-repo are different targets: pick one');
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
        const opened = await openDocsPr(patch, {
          token: config.githubToken ?? '',
          target: opts.inRepo ? 'same-repo' : opts.upstream ? 'upstream' : 'fork',
          base: opts.base,
          only: opts.only?.map(parseRepoName),
        });
        if (!opened.length) log('no pull request opened: no proposed edit is in a repository this token may write to');
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

/** The docs references a pull request makes wrong, as GitHub workflow commands: annotations on the job (and its Files tab). */
async function emitAnnotations(ctx: ToolContext, prUrl: string): Promise<void> {
  const nf = await prNewFindings(ctx, prUrl).catch((err: Error) => void log(`docs references not checked: ${err.message}`));
  const lines = nf ? formatGithub({ version: 1, findings: nf.findings, summary: nf.summary, warnings: [] }) : '';
  if (lines) console.log(lines);
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`staleproof: ${err.message}`);
  process.exit(1);
});
