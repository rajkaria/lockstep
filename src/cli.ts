#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { loadConfig, orgSlug } from './config.js';
import { collectFacts, factsMarkdown } from './facts.js';
import { GraphStore } from './graph/client.js';
import { indexOrg } from './indexer/index.js';
import { checkoutRepo, parseRepoName, type Checkout } from './indexer/repo.js';
import { packageRoot, packageVersion } from './pkg.js';
import { clearanceText, dim, impactText, runText } from './format/text.js';
import { runExampleTool } from './tools/run-example.js';
import { reviewVerdict, writeDecisionTool } from './tools/memory-tools.js';
import { buildDocsPatch } from './patch.js';
import { openDocsPr } from './pr/open-pr.js';
import { parsePrUrl } from './pr/github.js';
import { clearanceTool, impactTool, rankSectionsTool } from './tools/graph-tools.js';
import type { ToolContext } from './tools/types.js';

const program = new Command();

program
  .name('lockstep-docs')
  .description(
    'Keep docs true to code: a FalkorDB graph of code, docs and decisions across repositories, and an agent that checks every pull request against it.',
  )
  .version(packageVersion())
  .option('--org <org>', 'organisation (one graph per org); env LOCKSTEP_ORG')
  .option('--db <url>', 'FalkorDB URL; env FALKORDB_URL (default falkor://localhost:6379)');

function settings() {
  const opts = program.opts<{ org?: string; db?: string }>();
  const config = loadConfig();
  if (opts.org) config.org = orgSlug(opts.org);
  if (opts.db) config.falkordbUrl = opts.db;
  return config;
}

async function withGraph<T>(fn: (store: GraphStore, org: string) => Promise<T>): Promise<T> {
  const config = settings();
  const store = await GraphStore.connect(config.falkordbUrl);
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
    const config = settings();
    const refs = new Map(opts.ref.map((r) => r.split('=') as [string, string]).map(([k, v]) => [parseRepoName(k), v]));
    const names = repos.map(parseRepoName);
    const checkouts: Checkout[] = [];
    for (const name of names) {
      log(`checkout  ${name}${refs.has(name) ? `@${refs.get(name)}` : ''}`);
      checkouts.push(await checkoutRepo(config.home, name, refs.get(name)));
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
            `${d.uses.exact + d.uses.byName} uses  ${d.mentions} mentions  ${d.links} links`,
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
  .option('--max-hops <n>', 'maximum call hops between a changed symbol and a doc', '3')
  .option('--json', 'print JSON')
  .action(async (prUrl: string, opts: { agent: boolean; maxHops: string; json?: boolean }) => {
    await withGraph(async (store, org) => {
      const ctx: ToolContext = { graph: store.org(org), config: settings(), log };
      if (opts.agent) {
        throw new Error('the agent loop lands in a later release of this command; run with --no-agent for now');
      }
      const impact = await impactTool.run(ctx, { pr_url: prUrl, max_hops: Number(opts.maxHops) });
      const clearance = await clearanceTool.run(ctx, { pr_url: prUrl });
      const ids = [...new Set(impact.data.sections.map((s) => s.section).filter((id) => id.includes('#')))];
      const ranked = ids.length ? await rankSectionsTool.run(ctx, { section_ids: ids }) : undefined;
      if (opts.json) {
        console.log(JSON.stringify({ impact, clearance, ranked }, null, 2));
        return;
      }
      console.log(impactText(impact.data, ranked?.data.ranked));
      console.log('');
      console.log(clearanceText(clearance.data.cleared));
      console.log('');
      console.log(dim(`${impact.summary}\n${clearance.summary}${ranked ? `\n${ranked.summary}` : ''}`));
    });
  });

program
  .command('run')
  .description('Run a docs code example in the sandbox (before and after a PR with --pr)')
  .argument('<example-id>', 'CodeExample id, e.g. FalkorDB/docs:commands/graph.explain.mdx:3')
  .option('--pr <url>', 'run at the commit before the pull request and at the pull request')
  .option('--json', 'print JSON')
  .action(async (exampleId: string, opts: { pr?: string; json?: boolean }) => {
    await withGraph(async (store, org) => {
      const ctx: ToolContext = { graph: store.org(org), config: settings(), log };
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
  .command('facts')
  .description('Write FACTS.md: every number Lockstep quotes, computed from the graph')
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

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`lockstep-docs: ${err.message}`);
  process.exit(1);
});
