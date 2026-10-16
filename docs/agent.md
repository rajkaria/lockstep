# The agent

This page explains how a check runs: the agent loop in [src/agent/loop.ts](../src/agent/loop.ts), its system prompt, the tools it offers the model, input validation, the stop condition, step and time limits, what is stored, the model providers it supports (Claude by default, or any Anthropic-compatible API such as DeepSeek), graph mode, the scripted model used in tests, and real traces from FalkorDB's pull requests. Read it to understand or tune a check, or to run the agent on a different model.

## Run an agent check

```bash
export ANTHROPIC_API_KEY=<your Claude API key>
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/262
```

The CLI streams the trace as it happens: the check id and model, the "since the last check" summary, the model's reasoning (dimmed), each tool call (`→ impact(pr_url=…)`) and its result (`← <summary>` with the Cypher queries it ran and the time it took), any reminder, and a final line with the status, turns, tool calls, tool order, verdicts and tokens, followed by the model's summary. It ends with `Patch: staleproof patch <pr>   Trace: stored on <check-id>`. The exit code is 1 when the check ends `error` or `refused`.

| Option | Default | Meaning |
|---|---|---|
| `--model <id>` | `STALEPROOF_MODEL`, else `claude-sonnet-5-5` | The model |
| `--effort <level>` | `STALEPROOF_EFFORT`, else `medium` | `low`, `medium`, `high`, `xhigh` or `max` |
| `--max-steps <n>` | `40` | Model turns before the loop stops |
| `--json` | off | Print the whole result (events included) as JSON instead of the trace |
| `--format markdown` | `text` | Also render the PR comment, with the agent's summary |
| `--out <file>` | none | Write the PR comment to a file |
| `--no-agent` | off | Run [graph mode](#graph-mode) instead |

To run on DeepSeek instead of Claude, see [The live demo's DeepSeek setup](#the-live-demos-deepseek-setup). The same loop runs behind `POST /api/check` in the [HTTP API](http-api.md) and the web UI.

## The loop

The model chooses every tool call. The loop validates and executes the calls, streams trace events, enforces the stop condition and stores everything on a `Check` node.

### Setup

1. Ingest the pull request if it was never ingested ([Pull request ingestion](concepts.md#pull-request-ingestion)).
2. Find the most recent finished check in the graph and summarise what was written since it started (see [Since your last check](memory.md#since-your-last-check)).
3. Create the `Check` node: `status: 'running'`, the model name, `started_at`, linked `FOR` the pull request. The id is `chk-` plus 12 hex characters.
4. Send the system prompt, the tool definitions and one user message: `Check <pr-url>.`, followed by `Since the last check: …` when there is something to report.

### Each turn

A step is one model turn, numbered from 1.

- **Time budget**: if the check has a budget and it is used up, no new turn starts (see [Time budget](#time-budget)).
- **The turn streams**: text and reasoning arrive as `delta` events (shown live, not stored); the complete message becomes `thinking` and `text` events.
- **Retries**: an error that is not an API error, such as an unparseable streamed tool input, re-issues the turn, up to 2 times in a row; each retry uses a step. An API error ends the check as `error`.
- **Stop reasons**: `refusal` ends the check as `refused` with the summary `The model declined to continue (<category>).`; `pause_turn` continues with the next turn. A tool call cut off by `max_tokens` ends the check as `error`: `a tool call was cut off at max_tokens; raise max_tokens and re-run the check`.
- **History** is append-only: the assistant message goes back to the model exactly as it came.
- **Tool calls** in one message run one after another, in the order given.

### Tools offered

The model gets the eight agent tools, with their JSON schemas: `impact`, `clearance`, `read_section`, `run_example`, `decisions_for`, `rank_sections`, `propose_edit` and `record_verdict`. `write_decision` is never offered: decisions come from people. `docs_patch` is for MCP clients. Each tool and its result are described in the [Tools reference](tools.md).

For `impact`, `clearance`, `run_example`, `propose_edit` and `record_verdict`, a missing `pr_url` defaults to the pull request under check.

### Input validation

Every tool call is validated before it runs, and every problem goes back to the model as an error result rather than ending the check:

| Problem | Error result |
|---|---|
| Unknown tool | `unknown tool <name>` |
| A parameter the tool does not have | `<tool> has no parameter <names>; its parameters are <list>`, for example `impact has no parameter limit; its parameters are pr_url, max_hops, offset` |
| Invalid input | `invalid input for <tool>: <path>: <message>; …` |
| The tool throws | Its message, for example `refused: no path in the graph from <pr>'s changes to <section>. …` |

Unknown parameters are an error, not ignored: if they were dropped silently, the model would get the same answer again and keep trying (see [the first #276 run](#the-first-276-run)).

### Tool results

A successful result goes back to the model as JSON with the tool's `summary` and `data`, cut at 24,000 characters (`MAX_TOOL_CONTENT`) with `… [truncated; ask for fewer items]` appended. The trace keeps more: the full data (unless its JSON exceeds 60,000 characters, when it is stored as a preview marked `__trimmed`), plus every Cypher query the tool ran with its server-side time and row count.

### Stop condition

The check is meant to end with a verdict or an edit for every impacted section.

- **Impacted sections**: after any successful `impact` call, the loop collects the section ids of every page of that walk itself (fetching the pages the model has not asked for, without showing them to the model), so the set covers all impacted sections, not only the page the model saw. For #276 that is all 43. The set is the union over every `impact` call of the check, each with the `max_hops` it was called with. Example scripts, which have no section, are not included.
- **When the model finishes** (a turn with no tool calls), the loop compares the set with the sections that got a verdict from this check. Its last text becomes the summary.
- **Reminders**: if sections are still open, the loop sends up to 2 reminders: `These impacted sections still have no verdict or edit: <ids>. Give each one a verdict (record_verdict) or an edit (propose_edit), then finish.`
- **Result**: `done` when nothing is open; `incomplete`, with the open sections listed in `missing`, when something still is after the reminders.

A check in which the model never calls `impact` has no impacted sections to cover.

### Step limit

The loop stops after `maxSteps` model turns: 40 by default, `--max-steps` on the CLI. The HTTP server always uses 40. A check that hits the limit ends `incomplete` with the summary `Stopped after 40 model turns with <n> impacted section(s) still open.`, unless the model had already written a summary.

### Time budget

A serverless function has a hard time limit, so the HTTP server can give each agent check a budget: `STALEPROOF_CHECK_BUDGET_MS`, which defaults to 240,000 (240 s) when `VERCEL` is set and is unset elsewhere. The budget is checked before each turn; a turn in progress finishes. Past it, the check ends `incomplete`:

```text
Stopped at this server's 240 s time limit after <n> model turns with <m> impacted section(s) still open; the CLI has no time limit.
```

The CLI never sets a budget. A 43-section check such as #276 takes about 6 minutes, so on Vercel it ends incomplete; run it from the CLI.

### Statuses

| Status | When |
|---|---|
| `done` | The model finished and every impacted section has a verdict or an edit |
| `incomplete` | Sections still open after the reminders, the step limit or the time budget |
| `refused` | The model returned a refusal |
| `error` | An API error, a tool call cut off at `max_tokens`, a missing credential, or any other failure: `The check failed: <message>` |

While it runs, the `Check` node has status `running`. A process killed mid-check leaves it there.

### What the Check node stores

| Property | Meaning |
|---|---|
| `pr`, `model`, `started_at`, `finished_at` | What was checked, by which model, when |
| `status`, `summary` | The outcome and the model's final summary (or the loop's) |
| `steps` | Model turns used |
| `tool_calls`, `tool_order` | How many tool calls, and their names in order |
| `missing` | Impacted sections still without a verdict or edit |
| `input_tokens`, `output_tokens` | Token usage, summed over turns |
| `verdicts` | Verdicts written by this check |
| `trace` | Every stored event as JSON |

Edges: `(Check)-[:FOR]->(PullRequest)` and `(Check)-[:PRODUCED]->(Verdict)` for every verdict whose `check` is this id. The stored trace has these event types: `check_started` (with the "since" text), `thinking`, `text`, `tool_call` (name, input, step), `tool_result` (summary, `isError`, queries, data, milliseconds, step), `nudge` (the open sections) and `check_finished` (status, summary, steps, tool calls, tool order, verdicts, missing, usage). Read a stored trace with `GET /api/checks/<check-id>`, or open `#/check/<check-id>` in the web UI.

### Usage accounting

Each turn's `input_tokens`, `output_tokens` and `cache_read_input_tokens` are summed. Input and output totals are stored on the `Check`; the cache-read total appears only in the trace's `check_finished` event. The CLI's final line shows input plus output tokens. Graph mode uses no tokens.

## The system prompt

The system prompt ([src/agent/prompt.ts](../src/agent/prompt.ts)) states the job and the rules the graph enforces. It does not fix a tool order: the model decides what to look at next from what the tools return, so different pull requests produce different traces. Its rules, in short:

- A path is a reason to look, not proof: "A path from a changed symbol to the section is the reason to look at it, not proof that it is wrong."
- Breaking changes usually make a section wrong; behaviour changes often do not.
- Running a Python example before and after is the strongest evidence: passes before and fails after proves a break, passes both is good evidence the docs hold, fails both means it was already broken, and skipped runs prove nothing.
- Check `decisions_for` before editing, and cite a governing decision with a `governed` verdict. Use earlier verdicts, and whether maintainers accepted them.
- Never propose an edit without a path from the pull request's changes; `propose_edit` refuses otherwise.
- What to edit: "Edit what is wrong: what the pull request falsified, or an example you ran that fails both before and after (already broken: say so in the reason, cite both runs, and fix only what makes it fail)." Keep the author's voice and everything still true, and give the whole section, heading included, as `new_text`.
- Every impacted section must end with a verdict or an edit; one reason may cover many sections.
- Do not invent APIs.
- Finish with a short plain-text summary for a maintainer: what changed, what was edited and why, what ran and what it proved, and what could not be checked.

The path guard in `propose_edit` is the same for an already-broken example: the section must still be reachable from the pull request's changes.

## Model providers

The agent was written for Claude and runs on any API that speaks Anthropic's Messages format. Both go through `AnthropicModel` ([src/agent/anthropic.ts](../src/agent/anthropic.ts)).

| Option | Default | Meaning |
|---|---|---|
| `model` | required | The model name (`STALEPROOF_MODEL` or `--model` on the CLI) |
| `effort` | `medium` | `low`, `medium`, `high`, `xhigh` or `max` |
| `fallbacks` | `true` | Server-side refusal fallback (Claude API only); `STALEPROOF_FALLBACKS=off` disables it |
| `apiKey` | none | Otherwise the SDK finds credentials itself |
| `maxTokens` | `32000` | Output limit per turn; set only through the library |
| `baseURL` | none | The API endpoint (`ANTHROPIC_BASE_URL`) |
| `compatible` | `false` | Send only the portable request fields; set when `ANTHROPIC_BASE_URL` names a host other than `api.anthropic.com` |

### Claude

Claude is the default (`claude-sonnet-5-5`). Each turn is a streamed request with:

- adaptive thinking with summarised display, so the trace shows why each tool was chosen;
- the effort level set explicitly;
- the system prompt marked for prompt caching;
- tool inputs streamed as they are generated (the loop validates every input before running it);
- the server-side refusal fallback, unless `STALEPROOF_FALLBACKS=off`.

The Claude path is tested against a local fake API only: [test/anthropic-model.test.ts](../test/anthropic-model.test.ts) checks the request it sends and that it reads a streamed answer, without paid calls. The agent runs with a real model have used DeepSeek.

### Anthropic-compatible providers

Set `ANTHROPIC_BASE_URL` to a provider's Anthropic-compatible endpoint. Any host other than `api.anthropic.com` (or a URL that does not parse) switches to compatible mode, which sends only the portable fields: model, max tokens, the system prompt as plain text, the tools, the messages, thinking enabled with a budget of 16,000 tokens, and the effort level. No prompt caching, beta headers, refusal fallback or streamed tool inputs.

A Claude model name is refused in compatible mode, because the provider would answer with its own model under that name and every trace would record the wrong model:

```text
"claude-sonnet-5-5" is a Claude model name, but the model endpoint is an Anthropic-compatible provider, which would answer with its own model under that name; set STALEPROOF_MODEL to the provider's model (e.g. deepseek-v4-pro)
```

The default model is `claude-sonnet-5-5`, so setting `ANTHROPIC_BASE_URL` without `STALEPROOF_MODEL` hits this error.

### The live demo's DeepSeek setup

The live demo runs `deepseek-v4-pro` through DeepSeek's Anthropic-compatible endpoint:

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_API_KEY=<your DeepSeek API key>
export STALEPROOF_MODEL=deepseek-v4-pro
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/267
```

For a server, set the same three variables in its environment (see [Deploy](DEPLOY.md)). `GET /api/health` then reports the agent as available, with the model, the effort and the provider's host (`api.deepseek.com`).

### Credentials

The agent needs credentials: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, a selected `ANTHROPIC_PROFILE`, a federation rule with an identity token, or an `ant auth login` profile on disk. Without any, agent mode fails before the check starts, instead of falling back to graph mode:

```text
the agent needs model API credentials: set ANTHROPIC_API_KEY (or run `ant auth login`) for the Claude API, or ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY and STALEPROOF_MODEL for an Anthropic-compatible provider such as DeepSeek. Use `check --no-agent` to run the graph tools without a model.
```

An authentication failure during a turn is reported the same way, with the provider's message appended. The HTTP server without credentials offers graph mode only: `POST /api/check` with `mode: 'agent'` answers 409.

## Graph mode

Graph mode runs the same tools in a fixed order with no model. It needs no credentials, and it is labelled as graph mode everywhere it is shown (the `Check`'s model is `graph-only (no model)`).

```bash
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/267 --no-agent
```

The order:

1. `impact`, with `max_hops` when it is not 3.
2. `clearance` (always 3 hops).
3. `rank_sections` over the impacted section ids of the first page, if there are any.
4. `run_example` with the pull request, for up to `maxRuns` distinct examples taken from the `exact` sections of the first page.

Graph mode samples: it ranks the first `impact` page (40 sections) and runs at most 3 examples by default, so on a pull request with more sections, the rest are listed in the impact count but not ranked or run. It writes no verdicts and no edits, does not read decisions, sends no reminders and computes no "since" summary. A tool error is recorded in the trace and the remaining steps continue; only a failing `impact` ends the check as `error` (`The check failed: impact failed`). On #262 it makes 4 calls: impact, clearance, rank_sections and one run_example.

| Setting | CLI | HTTP server |
|---|---|---|
| Example runs (`maxRuns`) | `--runs <n>`, default 3; `--runs 0` runs none | Always 3 |
| Call hops (`maxHops`) | `--max-hops <n>`, default 3 | Always 3 |

The summary is the impact and clearance summaries, then `Ran <n> example(s) before and after the PR: <id>: <outcome>; …` (or `Example runs not requested.` or `No exactly-linked Python example to run.`), then `Graph mode: fixed tool order and no verdicts — agent mode (Claude) judges each section and proposes the edits.` The CLI prints the impacted sections, the cleared symbols, each run and the summary, and stores the check like an agent check.

`check --no-agent --format markdown`, which the GitHub Action runs without a model key, is different again: it renders the PR comment from impact, clearance, ranking and any verdicts already in the graph, and stores no `Check` and runs no examples.

## ScriptedModel for tests

`ScriptedModel` is a deterministic stand-in for a model, exported by the library. You give it a function from the conversation so far and the turn number to the turn's content: `thinking`, tool `calls`, or final `text`. A turn with calls ends with `tool_use`, one without with `end_turn`; usage is zero. It records every request it receives in `requests`, so a test can check what the model was shown.

```ts
import { GraphStore, loadConfig, runAgentCheck, ScriptedModel } from 'staleproof';

const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
// The check is stored like any other: use a graph where the pull request's repository is indexed.
const graph = store.org(config.org);

// Turn 0 calls impact; every later turn finishes without a verdict.
const model = new ScriptedModel((history, turn) =>
  turn === 0 ? { calls: [{ name: 'impact', input: {} }] } : { text: 'Done.' },
);
const result = await runAgentCheck({ graph, config }, model, 'https://github.com/FalkorDB/falkordb-py/pull/262', { maxSteps: 5 });
console.log(result.status, result.missing); // incomplete, after two reminders, with the open section listed
await store.close();
```

The test suite drives the loop this way against an indexed fixture organisation ([test/agent.test.ts](../test/agent.test.ts)): a removed method that a script reads and edits, a signature change the script forgets to close (the loop must remind it), tool errors, the time budget, unknown parameters, and the stop condition across impact pages.

## Traces from FalkorDB's pull requests

These checks ran `deepseek-v4-pro` on FalkorDB's graph. Each pull request got a different tool order.

**falkordb-py#262**: 5 tool calls, 1 verdict.

| Step | Tool | Result summary |
|---|---|---|
| 1 | `impact` | `1 changed symbols reach 1 doc sections (0 breaking, 0 signature, 1 behavior; 0 in other repositories).` |
| 2 | `read_section` | `falkordb-py > Usage > Asynchronous Example (README.md, lines 64-114, 1 examples).` |
| 3 | `decisions_for` | `No decision governs this.`, followed by the section's earlier verdicts |
| 4 | `run_example` | `Fails at 49aa012 and passes at f7c3de7: the PR fixes this example. (recorded earlier; not re-run)` |
| 5 | `record_verdict` | `Verdict ok recorded for 1 section.` |

The impact summary is shown as recorded then; the current wording is `1 changed symbol reaches 1 doc section (…)`. The model concluded that the pull request fixes the documented example rather than breaking it, so the section needs no edit.

**falkordb-py#267**: 15 tool calls and 3 verdicts, each citing its before/after runs. A later check under the current prompt (`chk-90817863f077`, 12 tool calls: impact, read_section and decisions_for for each of the 3 sections, 3 run_example calls, then 2 record_verdict calls) again closed all 3 sections as `ok`. It considered the `GRAPH.EXPLAIN` example, which fails before and after, and declined to edit it: the page assumes a demo graph that already exists, so the model judged that fixing it was outside this pull request's scope and recommended a separate docs fix in its summary.

**falkordb-py#276**: 38 tool calls paging through all 43 impacted sections with `offset`, every one with a verdict.

No check on FalkorDB's graph has proposed an edit: every verdict on #262, #267 and #276 is `ok`. These pull requests are fixes, and no example they reach broke because of them. Proposing edits and building the docs patch are exercised on the test suite's fixture organisation.

### The first #276 run

The first agent check of #276 stopped at the 40-turn limit with 21 sections open. At the time:

- `impact` returned at most 40 sections and had no way to page, while #276 reaches 43.
- The model tried parameters the tool did not have, such as `limit`, `max_results` and an `offset` that did not exist yet. They were dropped silently, so it got the same first page back each time.
- The stop condition counted only the sections the model had been shown, so the 3 sections past the first page were never required.

What changed: `impact` pages (40 sections per call, `offset`, and a summary that says `call impact again with offset=40 for the rest`); unknown parameters are an error in the agent loop and over MCP; and the loop collects every impact page itself, so `done` means all impacted sections have a verdict or an edit. The next check of #276 paged through all 43 sections in 38 calls.

## Limits

- **The Claude path is tested against a local fake API only.** Real agent runs so far used `deepseek-v4-pro`.
- **Model choices vary between runs**: the same pull request can get a different tool order and different verdicts.
- **The time budget applies to the HTTP server only**; on Vercel a large check ends incomplete at 240 s.
- **`max_tokens` is set only through the library**, though the cut-off error says to raise it.
- **`--effort` on the CLI is passed through unchecked**; only `STALEPROOF_EFFORT` is validated.
- **The HTTP server has no step, run or hop options**; it uses the defaults.

## Related

- [Core concepts](concepts.md#agent-mode-and-graph-mode): agent mode and graph mode side by side
- [Tools reference](tools.md): what each tool takes and returns
- [Decisions and memory](memory.md): what checks read and write back
- [Configuration](configuration.md): the model and budget environment variables
- [Deploy](DEPLOY.md): running the agent on a server
