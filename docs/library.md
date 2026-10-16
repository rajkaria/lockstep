# Node.js library

The `lockstep-docs` package exports the engine the CLI is built on: configuration, the FalkorDB graph client, the indexer, pull request ingestion, the tools, the agent loop and graph mode, the docs patch, the HTTP app and the MCP server. This page lists every export with its signature and gives complete recipes, each type-checked against the source. It is for TypeScript and JavaScript developers who want to embed indexing or checks in their own tools, tests or servers instead of shelling out to the CLI.

## Install

```bash
npm i lockstep-docs
```

- **Node.js 20 or later** (`engines` in [package.json](../package.json)).
- **ESM only**. The package is `"type": "module"` and ships no CommonJS build: use `import`. From CommonJS, load it with `const lockstep = await import('lockstep-docs')`.
- **No type declarations yet.** The build compiles JavaScript only (`dts: false` in [tsup.config.ts](../tsup.config.ts)), so TypeScript sees the module as untyped. The signatures on this page come from the source. To run the recipes as written, use `npx tsx recipe.ts` (tsx strips types without checking them). In a type-checked project, add a declaration file with `declare module 'lockstep-docs';`; every import is then `any`, so annotate callback parameters yourself.
- **What it needs at run time** is the same as the CLI: a FalkorDB server, `git` to index and to ingest pull requests, `uv` or `python3` to run examples, and model credentials for agent mode. [Configuration](configuration.md) lists every variable.

## A first script

Check a pull request in graph mode (no model) against a graph you have already indexed with `lockstep-docs index`, and print what it reaches:

```ts
import { GraphStore, loadConfig, runGraphCheck } from 'lockstep-docs';

const config = loadConfig(); // FALKORDB_URL, LOCKSTEP_ORG, LOCKSTEP_HOME, ...
const store = await GraphStore.connect(config.falkordbUrl);
try {
  const result = await runGraphCheck({ graph: store.org(config.org), config }, 'https://github.com/FalkorDB/falkordb-py/pull/262');
  console.log(result.status, result.toolOrder.join(' → '));
  console.log(result.summary);
} finally {
  await store.close();
}
```

Every function that touches the graph takes either an `OrgGraph` or a `ToolContext` (`{ graph, config }`), so one connection serves many calls. Close the `GraphStore` when you are done, or the process keeps the connection open.

## Exports

Every export of [src/index.ts](../src/index.ts), grouped by purpose.

### Configuration

| Export | Signature | What it does |
|---|---|---|
| `loadConfig` | `(env?: NodeJS.ProcessEnv) => Config` | Builds a `Config` from environment variables (default `process.env`). Pass `{}` for the defaults alone. Throws on an invalid `LOCKSTEP_EFFORT`, an empty org name, or a `LOCKSTEP_SCRATCH_URL` that carries credentials or does not parse |
| `orgSlug` | `(raw: string) => string` | The graph name for an organisation: trimmed, lowercased, every run of characters outside `a-z`, `0-9`, `_` and `-` turned into `-`, leading and trailing `-` removed. Throws `invalid org name: "<raw>"` when nothing is left |
| `DEFAULT_MODEL` | `'claude-sonnet-5-5'` | The agent model when `LOCKSTEP_MODEL` is unset |
| `Config` | type | See below |

`Config` fields:

| Field | Type | From |
|---|---|---|
| `falkordbUrl` | `string` | `FALKORDB_URL` |
| `org` | `string` | `LOCKSTEP_ORG`, slugged |
| `home` | `string` | `LOCKSTEP_HOME` |
| `githubToken` | `string \| undefined` | `GITHUB_TOKEN`, else `GH_TOKEN` |
| `anthropicApiKey` | `string \| undefined` | `ANTHROPIC_API_KEY` |
| `modelBaseUrl` | `string \| undefined` | `ANTHROPIC_BASE_URL` |
| `modelCompatible` | `boolean` | `true` when `ANTHROPIC_BASE_URL` names a host other than `api.anthropic.com` |
| `model` | `string` | `LOCKSTEP_MODEL` |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | `LOCKSTEP_EFFORT` |
| `fallbacks` | `boolean` | `LOCKSTEP_FALLBACKS` is not `off` |
| `scratch` | `{ host: string; port: number; managed: boolean }` | `LOCKSTEP_SCRATCH_URL`, else `127.0.0.1` and `LOCKSTEP_SCRATCH_PORT` |
| `runTimeoutMs` | `number` | `LOCKSTEP_RUN_TIMEOUT_MS` |
| `checkBudgetMs` | `number \| undefined` | `LOCKSTEP_CHECK_BUDGET_MS` |

`Config` is a plain object: build one with `loadConfig()` and override fields (`{ ...loadConfig(), org: 'acme' }`).

### Graph

| Export | Signature | What it does |
|---|---|---|
| `GraphStore.connect` | `(url: string) => Promise<GraphStore>` | Connects to a FalkorDB server (`falkor://`, `falkors://`, `redis://` or `rediss://`). Gives up after a 5 s connect timeout with `cannot reach FalkorDB at <url, password redacted>: ...` |
| `store.org` | `(name: string) => OrgGraph` | The graph of one organisation; the name is slugged with `orgSlug` |
| `store.serverVersion` | `() => Promise<string>` | The FalkorDB module version, for example `4.22.0`, or `unknown` |
| `store.listGraphs` | `() => Promise<string[]>` | Every graph on the server (one per organisation) |
| `store.close` | `() => Promise<void>` | Closes the connection |
| `graph.name` | `string` | The graph name |
| `graph.run` | `<T = Record<string, unknown>>(query: NamedQuery \| string, params?: Record<string, unknown>) => Promise<QueryResult<T>>` | Runs one Cypher statement. Errors read `FalkorDB <query name or adhoc> failed on graph "<graph>": <message>` |
| `graph.traced` | `(listener: (e: { name; cypher; params; ms; rows }) => void) => OrgGraph` | A view of the same graph that reports every query it runs; the tools use it to build their traces |
| `graph.drop` | `() => Promise<void>` | Deletes the whole graph. Meant for tests |
| `QueryResult<T>` | type | `{ rows: T[]; cypher: string; params; ms: number; stats: string[] }`; `ms` is FalkorDB's server-side execution time |
| `queries` | namespace | Every named Cypher statement as `{ name, purpose, cypher, group }` (for example `queries.impact`, `queries.prChanges`), plus `queries.ALL_QUERIES`. Their text and parameters are in [Graph model and Cypher](GRAPH-MODEL.md) |

### Indexing

| Export | Signature | What it does |
|---|---|---|
| `parseRepoName` | `(input: string) => string` | `owner/name` from `owner/name`, `https://github.com/owner/name[.git]` or `git@github.com:owner/name[.git]`. Throws `not a GitHub repository: "<input>" (expected owner/name or a github.com URL)` |
| `checkoutRepo` | `(home: string, repo: string, ref?: string) => Promise<Checkout>` | Clones a public repository (blob-less, unauthenticated HTTPS) into `<home>/repos/<owner>/<name>`, or fetches if it is there, then checks out `ref` detached (default: the remote's default branch head). `ref` goes to `git checkout --detach` as is: use `origin/<branch>`, a tag or a SHA |
| `Checkout` | type | `{ repo: string; dir: string; sha: string }`. `dir` can be any local directory: without `.git` the indexer walks the tree, and `sha` is only used in links |
| `indexOrg` | `(graph: OrgGraph, checkouts: Checkout[], onProgress?: (p: { phase: 'checkout' \| 'parse' \| 'write' \| 'resolve' \| 'docs' \| 'done'; repo?: string; message: string }) => void) => Promise<IndexReport>` | Parses every repository, resolves calls across all of them, links docs and examples to code, and writes `DEPENDS_ON`. Re-running is idempotent; see [Indexing](indexing.md) |
| `IndexReport` | type | `{ org, run, repos, docs, dependsOn, ms }`. `repos[]`: `{ repo, sha, files, symbols, calls: { exact, byName, crossRepo }, gone, parseErrors }`. `docs[]`: `{ repo, pages, sections, examples: { total, python }, mentions, uses: { exact, byName }, links, gone }`. `dependsOn[]`: `{ from, to, spec }` |

Cross-repository calls resolve only between repositories passed to the same `indexOrg` call. Index an organisation's repositories together.

### Pull requests

| Export | Signature | What it does |
|---|---|---|
| `parsePrUrl` | `(input: string) => { owner; repo; fullName; number; url }` | Accepts `https://github.com/<owner>/<repo>/pull/<n>` (trailing `/files`, query or fragment allowed) and `<owner>/<repo>#<n>`; `url` is the canonical form the graph stores. Throws `not a GitHub pull request URL: ...` |
| `fetchPullRequest` | `(ref, opts?: { token?: string; cacheDir?: string; fetchImpl?: typeof fetch }) => Promise<PullRequestInfo>` | PR metadata from the GitHub REST API: the `parsePrUrl` fields plus `title`, `body`, `author`, `state` (`open` \| `closed`), `mergedAt`, `mergeSha`, `baseSha`, `baseRef`, `headSha`, `headRef`. With `cacheDir`, the answer is written to `<cacheDir>/github/<owner>/<repo>/pulls/<n>.json` and read back only for merged PRs |
| `diffPullRequest` | `(dir: string, repo: string, pr: PullRequestInfo) => Promise<PrDiff>` | The symbol-level diff of a PR in a local clone: first parent to merge commit when merged, merge base to head otherwise |
| `diffRange` | `(dir: string, repo: string, before: string, after: string) => Promise<PrDiff>` | The same diff between any two commits |
| `ChangedSymbol` | type | `{ repo, qualname, name, kind, change, before?, after?, renamedTo?, exportTarget?, path, lineno, endLineno, doc? }`; `change` is `removed`, `renamed`, `signature`, `modified`, `added` or `export-removed` (see [Change kinds](concepts.md#change-kinds)) |
| `ingestPullRequest` | `(graph: OrgGraph, config: Config, prUrl: string) => Promise<IngestedPr>` | Fetches the PR, diffs it (local git, or the GitHub API when git is missing or `LOCKSTEP_INGEST=github`) and records it. Always re-ingests: the tools skip PRs the graph already ingested, this function does not. Throws `<owner/repo> is not indexed in the "<graph>" graph. ...` when the repository is not in the graph |
| `recordPullRequest` | `(graph: OrgGraph, pr: PullRequestInfo, diff: PrDiff) => Promise<IngestedPr>` | Writes a PR you diffed yourself: the `PullRequest` node, `CHANGED_IN` edges, recreated removed symbols and their late links. Returns `{ pr, diff, changed: { id, change }[], recreated: string[], lateLinks: number }` |

`PrDiff` is `{ before: string; after: string; files: { status, path, oldPath? }[]; symbols: ChangedSymbol[]; docsTouched: string[] }`.

### Tools

| Export | Signature | What it does |
|---|---|---|
| `AGENT_TOOLS` | `ToolDef[]` | The eight tools the agent chooses from, in this order: `impact`, `clearance`, `read_section`, `run_example`, `decisions_for`, `rank_sections`, `propose_edit`, `record_verdict` |
| `ALL_TOOLS` | `ToolDef[]` | `AGENT_TOOLS` plus `write_decision` (nine). `docs_patch` exists only in the MCP server; in the library, call `buildDocsPatch` |
| `modelTools` | `(tools?: ToolDef[]) => { name; description; input_schema }[]` | Tool definitions in the Anthropic Messages format, with JSON Schema generated from each tool's zod schema (default `AGENT_TOOLS`) |
| `ToolDef<I, O>` | type | `{ name; description; input: z.ZodType<I>; queries: NamedQuery[]; action?: boolean; run(ctx: ToolContext, input: I): Promise<ToolResult<O>> }` |
| `ToolResult<T>` | type | `{ tool: string; summary: string; data: T; queries: { name; cypher; params; ms; rows }[] }`: the sentence the agent reads first, the data, and every Cypher statement the call ran |
| `ToolContext` | type | See below |

`ToolContext` fields:

| Field | Type | Meaning |
|---|---|---|
| `graph` | `OrgGraph` | The org graph |
| `config` | `Config` | Settings |
| `checkId` | `string?` | The check verdicts are attributed to; `''` is stored without one |
| `prUrl` | `string?` | Default `pr_url` for `propose_edit` and `record_verdict` |
| `log` | `(msg: string) => void` | Progress lines (ingestion, venv builds, runs) |
| `checkouts` | `Record<string, string>?` | Local clones by `owner/name`, used instead of `<home>/repos/<owner>/<name>` for example installs and the patch |
| `freshRuns` | `boolean?` | Re-run examples even when an identical run is recorded (what `run --fresh` sets) |

`tool.run` does not validate its input. Parse it first with `tool.input.parse(input)`, as the agent loop and the MCP server do; zod then drops parameters the tool does not declare (both of those callers reject them instead). Parameters, results and errors of each tool are in the [Tools reference](tools.md).

### Agent and checks

| Export | Signature | What it does |
|---|---|---|
| `runAgentCheck` | `(ctx: ToolContext, model: ModelClient, prUrl: string, opts?: { maxSteps?: number; maxNudges?: number; budgetMs?: number; onEvent?: (e: TraceEvent) => void }) => Promise<CheckResult>` | The agent loop (defaults: 40 turns, 2 nudges, no time budget). Ingests the PR if needed, stores a `Check` node with the trace. Failures inside the loop end the check with status `error`; invalid URLs and ingestion errors throw before the check starts |
| `runGraphCheck` | `(ctx: ToolContext, prUrl: string, opts?: { maxRuns?: number; maxHops?: number; onEvent?: (e: TraceEvent) => void }) => Promise<CheckResult>` | Graph mode: `impact` (default 3 hops), `clearance`, `rank_sections` on the first impact page, and up to `maxRuns` (default 3) example runs before and after the PR. No model, no verdicts |
| `CheckResult` | type | `{ checkId, pr, status, summary, events, impacted, missing, toolOrder, since? }`. `status` is `done`, `incomplete`, `refused` or `error`. In graph mode `impacted` and `missing` are empty |
| `TraceEvent` | type | The union of `check_started`, `delta`, `thinking`, `text`, `tool_call`, `tool_result`, `nudge` and `check_finished`; fields in [HTTP API](http-api.md#trace-events) |
| `AnthropicModel` | `new (opts: { model: string; effort?: Effort; fallbacks?: boolean; apiKey?: string; maxTokens?: number; baseURL?: string; compatible?: boolean })` | The model client for the Claude API (defaults: effort `medium`, fallbacks on, 32,000 max tokens per turn) or, with `compatible: true`, an Anthropic-compatible provider. The constructor throws for a `claude-*` model name in compatible mode, and `the agent needs model API credentials: ...` when there is no `apiKey` and no credentials in the environment |
| `ScriptedModel` | `new (script: (history, turn: number) => { thinking?: string; calls?: { name: string; input: Record<string, unknown> }[]; text?: string })` | A deterministic model for tests: each turn is computed from the conversation so far. `name` is `scripted`; `requests` keeps every request it received. Calls in one turn run one after another, in order |
| `ModelClient` | type | `{ readonly name: string; turn(req: { system; tools; messages }, cb?: { onText?(delta: string): void; onThinking?(delta: string): void }): Promise<Message> }`, with the Anthropic SDK's beta Messages types. Implement it to plug in another model; the loop reads `content` (`text`, `thinking`, `tool_use` blocks), `stop_reason` and `usage` |

### Output

| Export | Signature | What it does |
|---|---|---|
| `buildDocsPatch` | `(ctx: ToolContext, prUrl: string, opts?: { fetchImpl?: typeof fetch }) => Promise<DocsPatch>` | The docs fix for a checked PR from the latest verdict per section. `prUrl` must be the canonical URL (`parsePrUrl(x).url`). Files are read at the indexed commit from the local clone, or from `raw.githubusercontent.com` when there is none. Throws `<prUrl> has not been checked` |
| `openDocsPr` | `(patch: DocsPatch, opts: { token: string; target: 'fork' \| 'upstream'; pollMs?: number }) => Promise<{ repo; url; target; branch }[]>` | Opens the patch as a pull request per docs repository: in your fork by default, against the original repository with `target: 'upstream'`. Throws `opening a pull request needs GITHUB_TOKEN` and `the patch is empty: no proposed edits to open a pull request for` |
| `collectFacts` | `(graph: OrgGraph, falkordbVersion?: string) => Promise<Facts>` | Every number FACTS.md quotes, computed from the graph (the `GET /api/stats` object) |
| `factsMarkdown` | `(facts: Facts) => string` | FACTS.md as Markdown |

`DocsPatch` is `{ pr: { url, title, repo, number }, files: { repo, path, sha, before, after, diff, sections }[], diff, title, body, verdicts, conflicts: { section, reason }[] }`. `diff` concatenates every file's unified diff; each is `git apply`-able in its own repository.

### Servers

| Export | Signature | What it does |
|---|---|---|
| `createApp` | `(opts: { store: GraphStore; config: Config; model?: () => ModelClient; preloaded?: string[]; webDir?: string; rateLimit?: number }) => Hono` | The HTTP API and web app of `lockstep-docs serve` as a [Hono](https://hono.dev) app. Without `model`, agent mode answers 409. `preloaded` defaults to `DEFAULT_PRELOADED`, `webDir` to the package's `web/dist` (any missing directory gives an API-only app), `rateLimit` to 30 POST requests per client per hour. Routes: [HTTP API](http-api.md) |
| `defaultModelFactory` | `(config: Config) => (() => ModelClient) \| undefined` | What `serve` passes as `model`: an `AnthropicModel` factory built from `config`, or `undefined` when no credentials are found |
| `DEFAULT_PRELOADED` | `string[]` | falkordb-py pull requests #262, #267 and #276 |
| `createMcpServer` | `(graph: OrgGraph, config: Config) => Server` | An MCP `Server` (from `@modelcontextprotocol/sdk`) with the ten tools, not yet connected to a transport. `lockstep-docs mcp` connects it to stdio; see [MCP server](mcp.md) |

## Recipes

Every recipe is a complete ES module (top-level `await`). Save it as `recipe.ts` and run `npx tsx recipe.ts` with the variables of [Configuration](configuration.md) set.

### Index an organisation

```ts
import { checkoutRepo, GraphStore, indexOrg, loadConfig, parseRepoName } from 'lockstep-docs';

const config = loadConfig(); // FALKORDB_URL, LOCKSTEP_ORG, LOCKSTEP_HOME, ...
const store = await GraphStore.connect(config.falkordbUrl);
try {
  const graph = store.org(config.org);
  const checkouts = [];
  for (const input of ['FalkorDB/falkordb-py', 'FalkorDB/GraphRAG-SDK', 'FalkorDB/docs']) {
    // Clones (blob-less) or fetches into <LOCKSTEP_HOME>/repos/<owner>/<name>, then checks out the default branch.
    checkouts.push(await checkoutRepo(config.home, parseRepoName(input)));
  }
  // Index all of them in one call: calls between repositories resolve only within one indexOrg run.
  const report = await indexOrg(graph, checkouts, (p) => console.error(`${p.phase.padEnd(8)} ${p.message}`));
  for (const r of report.repos) {
    console.log(`${r.repo} @ ${r.sha.slice(0, 7)}: ${r.symbols} symbols, ${r.calls.exact} exact calls, ${r.calls.byName} by name`);
  }
  for (const d of report.docs) console.log(`${d.repo}: ${d.sections} sections, ${d.examples.total} examples`);
  console.log(`graph "${report.org}", run ${report.run}, ${(report.ms / 1000).toFixed(1)} s`);
} finally {
  await store.close();
}
```

This is what `lockstep-docs index` does. To pin a repository, pass a ref: `checkoutRepo(config.home, 'FalkorDB/docs', 'origin/main')`.

### Check a pull request in graph mode and print the impacted sections

The tool results are in `result.events`. Their data types are not exported, so the script declares the fields it prints:

```ts
import { GraphStore, loadConfig, runGraphCheck, type TraceEvent } from 'lockstep-docs';

/** The fields of an impacted section this script prints (the full type is not exported). */
interface Impacted {
  section: string;
  severity: 'breaking' | 'api' | 'behavior';
  hops: number;
  confidence: 'exact' | 'by-name' | 'late';
  evidence: string[];
}

type ToolResultEvent = Extract<TraceEvent, { type: 'tool_result' }>;

const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
try {
  const ctx = { graph: store.org(config.org), config };
  // maxRuns: 0 skips the example runs (no sandbox needed); the default is 3.
  const result = await runGraphCheck(ctx, 'https://github.com/FalkorDB/falkordb-py/pull/267', { maxRuns: 0 });
  const impact = result.events.find((e): e is ToolResultEvent => e.type === 'tool_result' && e.name === 'impact' && !e.isError);
  const { sections } = (impact?.data ?? { sections: [] }) as { sections: Impacted[] };
  for (const s of sections) {
    console.log(`${s.severity.padEnd(8)} ${s.hops} hops (${s.confidence})  ${s.section}`);
    console.log(`         ${s.evidence.join(' ← ')}`);
  }
  console.log(`\n${result.status}: ${result.summary}\nStored as ${result.checkId}.`);
} finally {
  await store.close();
}
```

`sections` is the first page of at most 40; `totalSections` and `truncated` on the same object say whether there are more. The evidence path runs from the changed symbol to the doc ([Evidence path](concepts.md#evidence-path)).

### Run an agent check and stream its events

```ts
import { AnthropicModel, GraphStore, loadConfig, runAgentCheck } from 'lockstep-docs';

const config = loadConfig();
// Throws without credentials, or for a claude-* model name on an Anthropic-compatible provider.
const model = new AnthropicModel({
  model: config.model,
  effort: config.effort,
  fallbacks: config.fallbacks,
  apiKey: config.anthropicApiKey,
  baseURL: config.modelBaseUrl,
  compatible: config.modelCompatible,
});

const store = await GraphStore.connect(config.falkordbUrl);
try {
  const ctx = { graph: store.org(config.org), config, log: (m: string) => console.error(m) };
  const result = await runAgentCheck(ctx, model, 'https://github.com/FalkorDB/falkordb-py/pull/262', {
    maxSteps: 40,
    onEvent(e) {
      switch (e.type) {
        case 'delta':
          if (e.kind === 'text') process.stdout.write(e.text); // live tokens; not stored
          break;
        case 'tool_call':
          console.log(`\n→ ${e.name} ${JSON.stringify(e.input)}`);
          break;
        case 'tool_result':
          console.log(`${e.isError ? '!' : '←'} ${e.summary} (${e.queries.length} queries, ${e.ms} ms)`);
          break;
        case 'nudge':
          console.log(`! ${e.missing.length} section(s) still need a verdict`);
          break;
        case 'check_finished':
          console.log(`\n${e.status}: ${e.verdicts} verdicts, ${e.usage.input} input / ${e.usage.output} output tokens`);
          break;
      }
    },
  });
  console.log(result.summary);
  if (result.missing.length) console.log(`Still open: ${result.missing.join(', ')}`);
} finally {
  await store.close();
}
```

For DeepSeek, set `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and `LOCKSTEP_MODEL` (see [Configuration](configuration.md#model-agent-mode)); `config.modelCompatible` is then `true`. Pass `budgetMs` to stop starting new model turns after a wall-clock limit, as the server does on Vercel.

### Call one tool directly

`impactTool` and the other tool objects are not exported by name; find them in `ALL_TOOLS`:

```ts
import { ALL_TOOLS, GraphStore, loadConfig, type ToolContext } from 'lockstep-docs';

const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
try {
  const ctx: ToolContext = { graph: store.org(config.org), config };
  const impact = ALL_TOOLS.find((t) => t.name === 'impact')!;
  // Validate with the tool's own zod schema first, as the agent loop and the MCP server do.
  const input = impact.input.parse({ pr_url: 'https://github.com/FalkorDB/falkordb-py/pull/276', max_hops: 2 });
  const r = await impact.run(ctx, input);
  console.log(r.summary);
  for (const q of r.queries) console.log(`${q.name}: ${q.rows} rows, ${q.ms} ms`);
  console.log(JSON.stringify(r.data, null, 2));
} finally {
  await store.close();
}
```

`impact` ingests the pull request on first use. `propose_edit` and `record_verdict` need `pr_url` in the input or `prUrl` in the context, and write verdicts with `check: ''` unless the context has a `checkId`.

### Build the docs patch

```ts
import { writeFile } from 'node:fs/promises';
import { buildDocsPatch, GraphStore, loadConfig, openDocsPr, parsePrUrl } from 'lockstep-docs';

const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
try {
  const ctx = { graph: store.org(config.org), config };
  // Pass the canonical URL: the PullRequest node is keyed by it.
  const pr = parsePrUrl('FalkorDB/falkordb-py#267').url;
  const patch = await buildDocsPatch(ctx, pr);
  await writeFile('docs.patch', patch.diff);
  await writeFile('docs.patch.md', `# ${patch.title}\n\n${patch.body}\n`);
  console.log(`${patch.files.length} file(s): ${patch.files.map((f) => `${f.repo}:${f.path}`).join(', ') || 'none'}`);
  for (const c of patch.conflicts) console.log(`not applied: ${c.section} (${c.reason})`);
  if (process.argv.includes('--open-pr') && patch.files.length) {
    const opened = await openDocsPr(patch, { token: config.githubToken ?? '', target: 'fork' });
    for (const o of opened) console.log(`opened ${o.url} on ${o.branch}`);
  }
} finally {
  await store.close();
}
```

The patch is built from the latest verdicts the agent recorded; graph mode records none. For falkordb-py #267 it is empty, because every verdict on that pull request is `ok`. With `--open-pr`, `openDocsPr` forks each docs repository, pushes a branch named `lockstep/<repo>-<number>` and opens the pull request in your fork.

### Mount the HTTP API in your own server

`createApp` returns a Hono app. Mount it under a prefix in your own Hono app:

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createApp, defaultModelFactory, GraphStore, loadConfig } from 'lockstep-docs';

const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
const lockstep = createApp({
  store,
  config,
  model: defaultModelFactory(config), // undefined without credentials: graph mode only
  preloaded: ['https://github.com/FalkorDB/falkordb-py/pull/262'],
  webDir: '/nonexistent', // API only: no web UI, no catch-all route
  rateLimit: 10, // POST requests per client per hour
});

const app = new Hono();
app.get('/', (c) => c.text('my service'));
app.route('/lockstep', lockstep); // GET /lockstep/api/health, POST /lockstep/api/check, ...

serve({ fetch: app.fetch, port: 3000 });
```

Install `hono` and `@hono/node-server` in your project for this. The web app calls `/api/...` at the root of its origin, so serve it unprefixed (omit `webDir`) if you want the UI too. Without Hono, plug the app's `fetch` into `node:http`:

```ts
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { createApp, GraphStore, loadConfig } from 'lockstep-docs';

const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
const lockstep = createApp({ store, config, webDir: '/nonexistent' });
createServer(getRequestListener(lockstep.fetch)).listen(3000);
```

In tests and scripts you can skip the network: `await lockstep.request('/api/health')` returns a `Response`, which is how `npm run snapshot` reads the API.

### Serve MCP over another transport

`createMcpServer` returns an MCP `Server` without a transport, so any transport of `@modelcontextprotocol/sdk` works. Streamable HTTP, stateless, with a fresh server per request (the pattern of the SDK's own Hono example):

```ts
import { serve } from '@hono/node-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { createMcpServer, GraphStore, loadConfig } from 'lockstep-docs';

const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
const graph = store.org(config.org);

const app = new Hono();
// Stateless Streamable HTTP: a fresh MCP server and transport per request.
app.all('/mcp', async (c) => {
  const server = createMcpServer(graph, config);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

serve({ fetch: app.fetch, port: 3001, hostname: '127.0.0.1' });
```

Install the same major version of `@modelcontextprotocol/sdk` that `lockstep-docs` depends on (1.x). The tools write to the graph (`propose_edit`, `record_verdict`, `write_decision`) and this endpoint has no authentication: keep it on `127.0.0.1` or behind your own auth.

For tests, connect a client in the same process:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, GraphStore, loadConfig } from 'lockstep-docs';

const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
try {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(store.org(config.org), config).connect(serverSide);
  const client = new Client({ name: 'my-test', version: '0.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  console.log(tools.map((t) => t.name).join(', '));
  const r = await client.callTool({ name: 'impact', arguments: { pr_url: 'https://github.com/FalkorDB/falkordb-py/pull/262' } });
  console.log(r.content);
  await client.close();
} finally {
  await store.close();
}
```

Each successful call returns the summary and the data as JSON as two text items, plus a third with the named Cypher statements it ran, their row counts and timings, when there were any.

### Test with ScriptedModel (no API key)

`ScriptedModel` stands in for the model, and `recordPullRequest` stands in for GitHub, so a check runs with nothing but a FalkorDB. This is how the project's own tests drive the agent loop ([test/agent.test.ts](../test/agent.test.ts)).

```ts
import { GraphStore, indexOrg, loadConfig, recordPullRequest, runAgentCheck, ScriptedModel } from 'lockstep-docs';

// PullRequestInfo and PrDiff are not exported; take them from the function signature.
type PrInfo = Parameters<typeof recordPullRequest>[1];
type Diff = Parameters<typeof recordPullRequest>[2];

const store = await GraphStore.connect('falkor://localhost:6379');
const graph = store.org('lockstep-scripted-test'); // a throwaway graph
const config = loadConfig({}); // defaults only: ignores the environment

try {
  // Plain directories work: without .git the indexer walks the tree.
  await indexOrg(graph, [
    { repo: 'acme/client', dir: './fixtures/client', sha: 'fixture' },
    { repo: 'acme/docs', dir: './fixtures/docs', sha: 'fixture' },
  ]);

  // Record the pull request directly: no GitHub call, no git.
  const pr: PrInfo = {
    owner: 'acme', repo: 'client', fullName: 'acme/client', number: 1, url: 'https://github.com/acme/client/pull/1',
    title: 'Drop graph_names', body: '', author: 'dev', state: 'closed', mergedAt: '2026-10-01T00:00:00Z',
    mergeSha: 'after', baseSha: 'before', baseRef: 'main', headSha: 'head', headRef: 'drop-graph-names',
  };
  const diff: Diff = {
    before: 'before', after: 'after', files: [], docsTouched: [],
    symbols: [{
      repo: 'acme/client', qualname: 'client.Client.graph_names', name: 'graph_names', kind: 'method',
      change: 'removed', before: 'def graph_names(self)', path: 'client/__init__.py', lineno: 20, endLineno: 21,
    }],
  };
  await recordPullRequest(graph, pr, diff);

  // Each turn is computed from the conversation so far.
  const model = new ScriptedModel((history, turn) => {
    if (turn === 0) return { thinking: 'Start from what the PR reaches.', calls: [{ name: 'impact', input: {} }] };
    if (turn === 1) {
      const last = history.at(-1);
      const block = Array.isArray(last?.content) ? last.content.find((b) => b.type === 'tool_result') : undefined;
      // A tool result's content is JSON {summary, data}; an error result is plain text.
      const text = block?.type === 'tool_result' && !block.is_error && typeof block.content === 'string' ? block.content : '{}';
      const { data } = JSON.parse(text) as { data?: { sections: { section: string }[] } };
      const ids = (data?.sections ?? []).map((s) => s.section).filter((id) => id.includes('#'));
      if (ids.length) return { calls: [{ name: 'record_verdict', input: { section_ids: ids, verdict: 'skipped', reason: 'scripted test' } }] };
    }
    return { text: 'Every impacted section has a verdict.' };
  });

  const result = await runAgentCheck({ graph, config }, model, pr.url);
  console.log(result.status, result.toolOrder, result.missing); // e.g. done [ 'impact', 'record_verdict' ] []
  console.log(model.requests.length, 'model turns recorded');
} finally {
  await graph.drop();
  await store.close();
}
```

The fixtures are two small directories: `fixtures/client/client/__init__.py` defines `class Client` with a method `graph_names`, and a Markdown page in `fixtures/docs/` names it in inline code as `client.Client.graph_names()`. The tool inputs can omit `pr_url`: in a check it defaults to the pull request under check. `runAgentCheck` skips ingestion because `recordPullRequest` marked the pull request ingested. A test that also calls `run_example` needs the sandbox runtime (git, and `uv` or `python3`).

### Run your own Cypher

The named queries and `graph.run` are enough for reports. Precision, counted from maintainer reviews:

```ts
import { GraphStore, loadConfig } from 'lockstep-docs';

const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
try {
  const { rows } = await store.org(config.org).run<{ verdict: string; status: string; n: number }>(
    `MATCH (v:Verdict) WHERE v.status IN ['accepted', 'rejected']
     RETURN v.verdict AS verdict, v.status AS status, count(v) AS n ORDER BY verdict, status`,
  );
  console.table(rows);
} finally {
  await store.close();
}
```

The node and edge properties are listed in [Graph model and Cypher](GRAPH-MODEL.md). Variable-length patterns should bind a path variable (`MATCH p = (s)<-[:CALLS*0..3]-(t)`), for the reason in [Troubleshooting](troubleshooting.md#falkordb-version-notes).

## Types that are not exported

Even when compiling against the source, several types the functions use are not exported from the package entry: the tool data types (`ImpactData`, `ImpactedSection`, `SectionText`, `RunExampleData`), `RunRecord`, `DocsPatch`, `PullRequestInfo`, `PrRef`, `PrDiff`, `IngestedPr`, `IndexProgress`, `Facts`, `AppOptions`, `CheckOptions`, `AnthropicModelOptions`, `ScriptedTurn` and `QueryTrace`. Derive them from the functions that use them, for example `Parameters<typeof recordPullRequest>[1]` or `Awaited<ReturnType<typeof buildDocsPatch>>`; `queries.NamedQuery` is reachable through the `queries` namespace.

## Limits

- No type declarations are published, and the package is at version 0.1.0: exports may change between versions.
- Some functions shell out: `checkoutRepo`, PR ingestion with git, and example runs need `git`; example runs need `uv` or `python3`; the managed scratch server and `lockstep-docs db` run `bash` scripts.
- State is per process: example runs are serialised process-wide, and the git and sandbox availability checks are cached for the life of the process.
- A few internals read the environment directly rather than `Config`: `LOCKSTEP_INGEST` (PR ingestion) and the Anthropic credential variables (`AnthropicModel`, `defaultModelFactory`).
- Nothing in the library authenticates callers. Anything you expose over HTTP or MCP can write verdicts and decisions to the graph.

## Related

- [HTTP API](http-api.md): the routes `createApp` serves and the trace event fields
- [Tools reference](tools.md): inputs, results and errors of every tool
- [Core concepts](concepts.md): impact, verdicts, checks and ids
- [Configuration](configuration.md): what `loadConfig` reads
- [MCP server](mcp.md)
