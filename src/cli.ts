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
