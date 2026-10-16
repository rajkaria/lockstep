# Tools reference

This page is the reference for the eleven tools that read and write the graph: the eight the agent chooses between, `write_decision` for people, and `check_pull_request` and `docs_patch` for MCP clients. It covers how every tool reports its work, who can call which tool, the ids they take, the usual order of calls for one pull request, and how errors come back; then each tool's parameters (generated from the code) and the shape of its result, its summary text, its side effects and the errors it raises. It is for MCP client authors, library users and anyone reading a trace.

## How tools work

Every tool returns the same envelope:

```ts
interface ToolResult<T> {
  tool: string;          // the tool's name
  summary: string;       // one or two sentences, read first by the agent and shown in the UI
  data: T;               // the structured result (shapes under Results below)
  queries: QueryTrace[]; // every Cypher statement the tool ran
}

interface QueryTrace {
  name: string;          // the named query from src/graph/queries.ts, or 'adhoc'
  cypher: string;        // the statement as sent
  params: Record<string, unknown>;
  ms: number;            // server-side execution time reported by FalkorDB
  rows: number;          // rows returned
}
```

Named queries are listed with their full text in [Graph model and Cypher](GRAPH-MODEL.md). Small lookups written inline in the code are traced as `adhoc`; the MCP output and the terminal trace leave those out.

How the result reaches you depends on the caller:

- **The agent** receives `{summary, data}` as JSON, cut at 24,000 characters. The trace stored on the check keeps the queries too. See [The agent](agent.md#tool-results).
- **MCP clients** receive three text items: the summary, the data as indented JSON, and `Cypher run on FalkorDB:` followed by each named query with its row count and time (left out when there are none). `check_pull_request` returns two instead: the Markdown report, and `Stored as check <id>. <summary>`.
- **The CLI and the HTTP API** call the tools inside commands and endpoints and print or return their data.

### Who can call which tool

| Tool | Agent | Graph mode | MCP | CLI | HTTP API |
|---|---|---|---|---|---|
| `check_pull_request` | no | it runs graph mode | yes | `check --no-agent --format markdown` (the same report) | `POST /api/mcp` |
| `impact` | yes | yes | yes | `check`, `run --pr` | inside `POST /api/check` |
| `clearance` | yes | yes | yes | `check` | inside `POST /api/check` |
| `read_section` | yes | no | yes | no | `GET /api/sections?id=` |
| `run_example` | yes | yes (up to 3) | yes, except on a hosted server | `run` | inside `POST /api/check` |
| `decisions_for` | yes | no | yes | no | no |
| `rank_sections` | yes | yes | yes | `check` | inside `POST /api/check` |
| `propose_edit` | yes | no | yes | no | no |
| `record_verdict` | yes | no | yes | no | no |
| `write_decision` | never | no | yes | `decide` | `POST /api/decisions` |
| `docs_patch` | no | no | yes | `patch` (same patch) | `GET /api/patch` (same patch) |

The "Available to" line in each generated entry below lists the agent tools as available to graph mode "where it applies"; graph mode uses only the four marked yes here. Over the HTTP API every MCP tool is also reachable through `POST /api/mcp`. See [MCP server](mcp.md), [CLI](cli.md) and [HTTP API](http-api.md).

## Ids

| Node | Format | Example |
|---|---|---|
| Symbol | `owner/repo:qualname` | `FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__` |
| DocSection | `owner/repo:path#anchor` | `FalkorDB/falkordb-py:README.md#asynchronous-example` |
| CodeExample | `owner/repo:path:index` | `FalkorDB/falkordb-py:README.md:4` |
| PullRequest | URL | `https://github.com/FalkorDB/falkordb-py/pull/262` (also accepted: `owner/repo#n`, and URLs ending in `/files` or with a query) |
| Decision, Verdict, Run | `dec-…`, `ver-…`, `run-…` | returned by the tools that create them |

Section ids come from `impact` and `read_section`; example ids from `impact` (`examples` on each section) and `read_section`. A DocSection id for the text before a page's first heading ends in `#`. More in [Core concepts](concepts.md#ids).

## Typical call order for one pull request

An MCP client usually starts with `check_pull_request`, which runs `impact`, `clearance` and `rank_sections` in one call (a graph-mode check) and returns the report; the steps below are for judging sections one by one. The agent decides its own order; this is the order the system prompt and the MCP server's instructions describe, and what a person driving an MCP client usually does:

1. `impact` with the pull request URL. If the summary says `call impact again with offset=40 for the rest`, page with `offset`. The first call ingests the pull request.
2. `read_section` for each impacted section, to see what it claims.
3. `decisions_for` on the section before editing it: a maintainer decision may say it stays as it is, and the history shows earlier verdicts.
4. `run_example` with the pull request URL for sections that have Python examples: the before/after outcome is the strongest evidence.
5. `propose_edit` for a section that is wrong, or `record_verdict` (`ok`, `governed`, `skipped`) for one that is not; several sections can share one `record_verdict`.
6. `docs_patch` (MCP) or `staleproof patch` for the diff.

`clearance` (what no doc reaches) and `rank_sections` (which page matters most) are optional. For falkordb-py#262 the agent's order was impact → read_section → decisions_for → run_example → record_verdict.

## Errors

A tool that cannot do its job throws an error with a message written for whoever called it. Nothing crashes the caller:

- **In the agent loop**, the error goes back to the model as an error result for that tool call, the trace records it with `isError: true`, and the check continues.
- **Over MCP**, the call returns `isError: true` with the message as its only text item.
- **On the CLI**, the command prints `staleproof: <message>` and exits with code 1.
- **Over HTTP**, endpoints answer 400, 404 or 500 with `{error}`; see [HTTP API](http-api.md).

Input problems are caught before a tool runs, with the same rules in the agent loop and over MCP:

| Problem | Agent loop | MCP |
|---|---|---|
| Unknown tool | `unknown tool <name>` | `unknown tool <name>` |
| Parameter the tool does not have | `<tool> has no parameter <names>; its parameters are <list>` | same |
| Invalid value | `invalid input for <tool>: <path>: <message>; …` | `invalid input: <path>: <message>; …` |

`pr_url` on `propose_edit` and `record_verdict` defaults to the pull request under check in agent mode. Over MCP there is no pull request under check, so it is required (`pr_url is required`), and verdicts written over MCP are not attached to any check.

## Tools

<!-- generated:tools:start -->
<!-- Generated by `npm run docs` from src/tools and src/mcp/server.ts. Do not edit by hand. -->

### `check_pull_request`

Check a GitHub pull request for docs it can make false, in one call: every doc section and example the changed code reaches (with the evidence path), the changed symbols no doc reaches, ranked by PageRank, as a Markdown report. Start here; use impact/read_section/decisions_for to dig into one section.

Available to MCP clients.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pr_url` | string | yes | https://github.com/<owner>/<repo>/pull/<n> |
| `run_examples` | boolean | no | Also run up to 3 affected examples before and after the PR (local servers only; takes minutes) |

Cypher it runs: `impact`, `clearance`, `rankSections` ([full text](GRAPH-MODEL.md)).

### `impact`

Find every doc section and code example a pull request can falsify, in any repository of the organisation. Walks changed symbol ← callers (up to max_hops, across repositories) ← MENTIONS/USES ← doc. Returns impacted sections ordered by severity (breaking: removed/renamed; api: signature; behavior: body changed) with the evidence path for each. Call this first for a PR. At most 40 sections come back per call; when more are impacted, call again with offset to page.

Available to the agent, MCP clients and graph mode.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pr_url` | string | yes | GitHub pull request URL, e.g. https://github.com/FalkorDB/falkordb-py/pull/262 |
| `max_hops` | integer 0–5 | no | Maximum call hops between the changed symbol and the doc (default 3) |
| `offset` | integer ≥ 0 | no | Skip this many sections (paging: 40 per call; default 0) |

Cypher it runs: `impact`, `prChanges`, `predictedCalls`, `mismatchesFor`, `upsertPullRequest`, `upsertChangedIn`, `upsertMissingSymbols`, `lateLinkSections`, `lateLinkExamples` ([full text](GRAPH-MODEL.md)).

### `clearance`

Proof of absence: the changed symbols that reach no doc section or example within 3 call hops in any repository. Each comes with a git grep command and its raw text-match count so a human can check the claim.

Available to the agent, MCP clients and graph mode.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pr_url` | string | yes | GitHub pull request URL (`https://github.com/<owner>/<repo>/pull/<n>`) |

Cypher it runs: `clearance` ([full text](GRAPH-MODEL.md)).

### `read_section`

Read the current Markdown of a doc section and its code examples, before deciding whether and how to edit it.

Available to the agent and MCP clients.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `section_id` | string | yes | DocSection id (`owner/repo:path#anchor`), as returned by impact |

Cypher it runs: `readSection` ([full text](GRAPH-MODEL.md)).

### `run_example`

Execute a docs code example in a sandbox (fresh virtualenv with the repositories installed from source, scratch FalkorDB on localhost:6379, no other network). With pr_url it runs twice — at the commit before the PR and at the PR — so "passes before, fails after" proves the PR broke the example. Examples needing LLM keys, local files or placeholders are recorded as skipped with the reason. Identical runs are answered from the graph.

Available to the agent, MCP clients and graph mode.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `example_id` | string | yes | CodeExample id from impact (repo:path:index) |
| `pr_url` | string | no | Run before and after this pull request |

Cypher it runs: `exampleForRun`, `installSet`, `cachedRun`, `upsertRun`, `linkRunToPr` ([full text](GRAPH-MODEL.md)).

### `decisions_for`

Before judging a doc section, read the maintainers' decisions that govern it (directly, or through any symbol it mentions or its examples use, within 2 call hops; superseded decisions resolve to the current one) and the verdicts Staleproof gave this section on earlier pull requests (with whether maintainers accepted them). A governing decision can mean the section is intentionally as it is: cite it instead of editing.

Available to the agent and MCP clients.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `target_id` | string | yes | DocSection id (repo:path#anchor) or Symbol id (repo:qualname) |

Cypher it runs: `decisionsForSection`, `decisionsForSymbol`, `priorVerdicts` ([full text](GRAPH-MODEL.md)).

### `rank_sections`

Order doc sections by how central their page is in the docs (PageRank over LINKS_TO, summed per page), so the most-read stale page is fixed first.

Available to the agent, MCP clients and graph mode.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `section_ids` | string[] (≥ 1) | yes | DocSection ids from impact |

Cypher it runs: `rankSections`, `rankSectionsByLinks` ([full text](GRAPH-MODEL.md)).

### `propose_edit`

Propose replacement Markdown for a stale doc section (the whole section, heading line included, as read_section returned it). Refused unless the graph has a path from this pull request's changes to the section: Staleproof never edits a paragraph without one. Keep everything that is still true; change only what the PR falsified, or what makes an already-broken example fail (fails before and after: say so). Cite the runs that prove it.

Available to the agent and MCP clients.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pr_url` | string | no | The pull request; defaults to the one under check in agent mode, required over MCP |
| `section_id` | string | yes | DocSection id (`owner/repo:path#anchor`), as returned by impact |
| `new_text` | string (non-empty) | yes | Replacement Markdown for the whole section, heading line included |
| `reason` | string (≥ 3 chars) | yes | Why: what the pull request changed and what the section claims |
| `cites` | string[] | no | Decision ids this conclusion relies on |
| `runs` | string[] | no | Run ids (from run_example) that support it |

Cypher it runs: `sectionReachedByPr`, `readSection`, `createVerdict` ([full text](GRAPH-MODEL.md)).

### `record_verdict`

Close impacted sections without editing them: ok (the change does not falsify it — say why, e.g. the example passed before and after), governed (a decision says it stays as is — cite the decision id), or skipped (cannot be judged — say why). Pass several section_ids when one reason covers them all. Every impacted section needs a verdict or an edit before you finish.

Available to the agent and MCP clients.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pr_url` | string | no | The pull request; defaults to the one under check in agent mode, required over MCP |
| `section_id` | string | no | DocSection id (`owner/repo:path#anchor`), as returned by impact |
| `section_ids` | string[] | no | Several sections sharing one verdict and reason |
| `verdict` | `ok` \| `governed` \| `skipped` | yes |  |
| `reason` | string (≥ 3 chars) | yes | Why: what the pull request changed and what the section claims |
| `cites` | string[] | no | Decision ids |
| `runs` | string[] | no | Run ids that support the verdict |

Cypher it runs: `sectionReachedByPr`, `createVerdict` ([full text](GRAPH-MODEL.md)).

### `write_decision`

Record a maintainer decision ("the async client keeps the old kwargs until 2.0") and the doc sections or symbols it governs. Future checks cite it instead of re-flagging. Decisions come from people: call this only when a human asked for it.

Available to MCP clients, the CLI (`decide`) and the HTTP API (`POST /api/decisions`); never the agent.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string (≥ 5 chars) | yes | The decision, in one sentence |
| `governs` | string[] (≥ 1) | yes | DocSection and/or Symbol ids |
| `source_url` | string | no | Where the decision was made (issue, PR comment, ADR) |
| `author` | string | no | Who decided |
| `supersedes` | string | no | Id of the decision this replaces |

Cypher it runs: `createDecision`, `governSections`, `governSymbols`, `supersedeDecision` ([full text](GRAPH-MODEL.md)).

### `docs_patch`

The docs fix for a checked pull request as a git-apply-able unified diff, plus a PR description with the evidence path behind each edited section. Built from the latest proposed edits.

Available to MCP clients; the same patch comes from the CLI (`patch`) and the HTTP API (`GET /api/patch`).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pr_url` | string | yes | GitHub pull request URL (`https://github.com/<owner>/<repo>/pull/<n>`) |

Cypher it runs: `verdictsForPr` ([full text](GRAPH-MODEL.md)).

<!-- generated:tools:end -->

## Results

What each tool returns in `data`, the summary it writes, what it changes in the graph, and the errors it raises. The shapes are defined in [src/tools/](../src/tools/) and, for `check_pull_request` and `docs_patch`, [src/mcp/server.ts](../src/mcp/server.ts).

### `check_pull_request` result

| Field | Meaning |
|---|---|
| `report` | The Markdown report, the same one the GitHub Action posts: the title, the impact summary, the examples run before and after, the impacted sections with their evidence paths in PageRank order, the cleared symbols and the latest verdicts ([format](github-action.md#the-comment)) |
| `checkId` | The `Check` node stored for this call (`chk-…`) |
| `status` | `done`, or `error` when `impact` failed |

Summary: the graph-mode check's summary: the impact and clearance summaries, then `Example runs not requested.` (or the runs' outcomes with `run_examples`), then `Graph mode: fixed tool order and no verdicts; agent mode (a model) judges each section and proposes the edits.` Over MCP the client receives the report and `Stored as check <id>. <summary>`.

Side effects: a graph-mode check ([`runGraphCheck`](agent.md#graph-mode)): the pull request is ingested on the first call, a `Check` node with the trace is stored, and with `run_examples: true` up to 3 examples run before and after (Run nodes). The local stdio server first indexes the pull request's repository when the graph does not have it; a hosted server indexes it into its owner's workspace, and executes no examples.

Errors: those of `impact`, and on a hosted server the [hosted limits](troubleshooting.md#hosted-service).

### `impact` result

| Field | Meaning |
|---|---|
| `pr` | `url`, `title`, `repo`, `state` (`merged`, `open` or `closed`), `before` and `after` (the commits compared), `docsTouched` (Markdown files the pull request itself edits) |
| `changed[]` | Every changed symbol, `added` ones included: `symbol` (qualified name), `change` (the [change kind](concepts.md#change-kinds)), and when present `before` and `after` signatures and `renamedTo` |
| `sections[]` | The current page of impacted sections, at most 40 (fields below) |
| `totalSections` | Impacted sections across all pages |
| `offset` | Index of the first section on this page |
| `truncated` | True when more sections follow this page |
| `counts` | `breaking`, `api`, `behavior`: sections per severity, over all pages |

Each impacted section:

| Field | Meaning |
|---|---|
| `section` | The DocSection id, or the CodeExample id for an example script (which has no section) |
| `heading` | The section's heading path |
| `repo`, `path`, `url` | Where it is; `url` links to the doc node on GitHub at the indexed commit |
| `severity` | `breaking`, `api` or `behavior`, from the most severe change that reaches it |
| `evidence` | The [evidence path](concepts.md#evidence-path): changed symbol first, doc last |
| `hops` | Edges on that path ([hops](concepts.md#hops)) |
| `confidence` | `exact`, `by-name` or `late` ([confidence](concepts.md#confidence)) |
| `changes[]` | Every change that reaches the section: `symbol`, `change`, `before`, `after` |
| `examples[]` | Ids of the section's code examples the walk reached |
| `crossRepo` | True when the section is in a different repository from the pull request |

Summary: `<n> changed symbols (and <m> added) reach <N> doc sections (<b> breaking, <a> signature, <c> behavior; <x> in other repositories).` The added count appears only when there are added symbols, and the wording agrees in number (`1 changed symbol reaches 1 doc section`). With more than 40 sections, or an `offset`, it continues `Showing <i>–<j> of <N>; call impact again with offset=<k> for the rest.` (or ends `Showing <i>–<j> of <N>.` on the last page). A pull request that changed no Python symbol gives `<url> changed no Python symbols in <repo>; no docs can be falsified through code.`

Side effects: the first call for a pull request ingests it: the `PullRequest` node, `CHANGED_IN` edges, removed symbols recreated with `late` links ([Pull request ingestion](concepts.md#pull-request-ingestion)). With `git`, ingestion also fetches the pull request's repository and checks out its default branch in the local clone; the GitHub metadata of a merged pull request is cached under `STALEPROOF_HOME/cache`.

Errors:

- `not a GitHub pull request URL: "<input>" (expected https://github.com/<owner>/<repo>/pull/<n>)`
- `<owner/repo> is not indexed in the "<graph>" graph. Run: staleproof index <owner/repo> (plus the repositories that document it).`
- `GitHub API rate limit reached (60 requests/hour without a token; set GITHUB_TOKEN to raise it). It resets in <n> min.`
- `GitHub: <path> not found (a private repository needs GITHUB_TOKEN with read access)` (without the parenthesis when a token is set)
- `GitHub <METHOD> <path> failed: <status> <body>`, `git <args> failed in <dir>: <stderr>`, `merge commit <sha> has no parent`

### `clearance` result

| Field | Meaning |
|---|---|
| `cleared[]` | Changed symbols (not `added`) with no doc within 3 call hops: `symbol` (qualified name), `name`, `repo`, `change`, `visibility`, `textMatches`, `grep` |
| `docsRepos[]` | The repositories that have doc sections, which `textMatches` searched |

`textMatches` is the number of lines matching `git grep -cw <name> -- '*.md' '*.mdx'` in the local clones of `docsRepos` (0 for repositories with no local clone, so always 0 on serverless hosts). `grep` is the command to check it yourself: `git grep -nw <name> -- '*.md' '*.mdx'`.

Summary, one of:

- `The PR changed no existing symbols; there is nothing to clear.`
- `Every changed symbol reaches at least one doc; nothing is cleared.`
- `<n> changed symbols reach no doc within 3 hops (<q> also have zero text matches in the docs; <r> share a name with text in the docs but no path resolves to them).`

Side effects: ingests the pull request if needed, as `impact` does. Errors: the same as `impact`'s ingestion errors.

### `read_section` result

| Field | Meaning |
|---|---|
| `id`, `repo`, `path` | The section |
| `heading` | Its heading path |
| `body` | Its Markdown, heading line included (stored up to 8000 characters) |
| `url` | GitHub link at the indexed commit |
| `lineno`, `endLineno` | Its lines in the file |
| `examples[]` | Its code examples, in order: `id`, `lang`, `code`, `lineno` |

Summary: `<heading> (<path>, lines <a>-<b>, <n> examples).` For example `falkordb-py > Usage > Asynchronous Example (README.md, lines 64-114, 1 examples).` An unknown id is not an error: `data` is `null` and the summary is `No doc section <id>.` No side effects.

### `run_example` result

| Field | Meaning |
|---|---|
| `example` | The CodeExample id |
| `url` | Its GitHub link |
| `verdict` | The [outcome](concepts.md#run-outcomes): `breaks`, `fixes`, `passes`, `already-broken`, `changed-failure`, `fails`, `skipped` or `error` |
| `runs[]` | One record per run, `before` then `after` with a pull request, otherwise one `current` run |
| `editedByPr` | `true` when the pull request edits the example's page and the after run used the page as the pull request leaves it ([details](example-runner.md#pull-requests-that-edit-the-page)) |

Each run record: `id`, `example`, `status` (`pass`, `fail`, `timeout`, `skipped`, `error`), `reason`, `error` (last traceback line), `traceback`, `stdout`, `durationMs`, `stitched` (ids of earlier examples prepended), `installed` (`repo@sha` list), `side`, `cached` (answered from the graph) and `createdAt`. See [The Run node](example-runner.md#the-run-node).

Summary, by outcome (commits shortened to 7 characters):

| Outcome | Summary |
|---|---|
| `breaks` | `Passes at <before> and fails at <after> with <error>: the PR breaks this example.` |
| `fixes` | `Fails at <before> and passes at <after>: the PR fixes this example.` |
| `passes` | `Passes before and after the PR (<before>, <after>): no observable break.`, or `Passes at the indexed commits.` without a pull request |
| `already-broken` | `Fails both before and after the PR with <error>: broken already, not by this PR.` |
| `changed-failure` | `Fails before (<error>) and after with a different error (<error>).` |
| `fails` | `Fails at the indexed commits: <error>.` |
| `skipped` | `Not run: <reason>.` |
| `error` | `The sandbox could not be prepared: <first line of the reason>` |

` The after run uses the page as this pull request edits it.` is appended when the pull request edits the example's page, and ` (recorded earlier; not re-run)` when a run was answered from the graph. If the `before` run is skipped, the `after` run is not attempted.

Side effects: a `Run` node per side (unless an identical run is reused), with `OF` to the example and `AT` to the pull request; clones or fetches the repositories, builds a virtualenv, and flushes the scratch FalkorDB. See [Example runner](example-runner.md).

Errors: `no code example <id>`; `<pr-url> has not been checked yet; call impact first` (the pull request is not in the graph yet); the pull request URL error. Problems inside the sandbox are not errors: they come back as runs with status `error`, `fail` or `timeout`.

### `decisions_for` result

| Field | Meaning |
|---|---|
| `decisions[]` | Active decisions that apply: `id`, `text`, `source`, `author`, `createdAt`, `matched` (the decision the graph reached; differs from `id` when it was superseded), `via` (the section's heading path for a direct match, else the governed symbol's qualified name) |
| `history[]` | For a section id only: its 5 most recent verdicts on any pull request: `id`, `verdict`, `status`, `reason`, `pr`, `title`, `createdAt` |

Summary: `<n> active decision(s) govern(s) this: "<text>" (<id>[, supersedes <matched>], via <via>); …` (text cut at 80 characters), or `No decision governs this.`, followed when there is history by `Earlier: <verdict>[ (<status>)] on <owner>/<repo>/pull/<n>, …`. The status is shown when it is not `proposed`.

An id containing `#` is treated as a DocSection id, anything else as a Symbol id. No side effects; an unknown id returns no decisions. See [How decisions_for resolves decisions](memory.md#how-decisions_for-resolves-decisions).

### `rank_sections` result

| Field | Meaning |
|---|---|
| `ranked[]` | The given sections that exist, most central page first: `id`, `heading`, `page` (`repo:path`), `pageScore`, `score` |
| `method` | `pagerank`, or `in-degree` when the graph algorithm failed |

With PageRank, `score` is the section's own score and `pageScore` the sum over its page. With the in-degree fallback, `pageScore` is the number of links into the page and `score` is 0.

Summary: `Ranked <n> sections by PageRank of their page; most central: <heading> (<page>).` (`by inbound links` for the fallback), or `None of these ids are doc sections.` No side effects. It does not raise errors of its own: a failing PageRank call falls back.

### `propose_edit` result

| Field | Meaning |
|---|---|
| `id` | The new Verdict id |
| `evidence` | The shortest path from the pull request's changes to the section (or one of its examples) |

Summary: `Edit proposed for <section> (evidence: <changed symbol> ← … ← <doc>).`

Side effects: a `Verdict` with `verdict: 'stale'`, `status: 'proposed'`, `new_text`, `old_text` (the section body as stored), `evidence`, `confidence: 'path'` and the check id (empty over MCP), with `ABOUT`, `FOR`, `CITES` (existing decisions only) and `EVIDENCE` (existing runs only) edges. The edit reaches files only through the [docs patch](concepts.md#the-docs-patch).

Errors:

- `pr_url is required` (over MCP, without `pr_url`)
- `refused: no path in the graph from <pr-url>'s changes to <section>. Staleproof never edits a paragraph without a path; record_verdict instead if it needs no change.` The path must have at most 3 call hops and start from a change other than `added`.
- `new_text is identical to the current section; use record_verdict with ok`
- `no doc section <section> or pull request <pr-url> in the graph`

### `record_verdict` result

| Field | Meaning |
|---|---|
| `ids` | One new Verdict id per distinct section |
| `evidence` | Per section id, the path from the pull request's changes, or `[]` when there is none |

Summary: `Verdict <ok|governed|skipped> recorded for <n> section(s).`

Side effects: one `Verdict` per section, `status: 'proposed'`, with `confidence: 'path'`, or `'none'` when no path reaches the section (unlike `propose_edit`, a missing path does not block a verdict), and the same edges as `propose_edit`.

Errors:

- `give section_id or section_ids` (reported as invalid input)
- `pr_url is required` (over MCP, without `pr_url`)
- `a governed verdict must cite the decision id(s)`
- `no doc section <section> or pull request <pr-url> in the graph`

### `write_decision` result

| Field | Meaning |
|---|---|
| `id` | The new Decision id (`dec-…`) |
| `governed` | How many of the given ids matched a DocSection or Symbol |

Summary: `Recorded decision <id> governing <n> node(s).`, with `, superseding <old-id>` before the period when `supersedes` is given.

Side effects: a `Decision` (`status: 'active'`, `author` default `unknown`), `GOVERNS` edges to the matching sections and symbols, and with `supersedes`, a `SUPERSEDES` edge to the old decision, whose status becomes `superseded` (an unknown old id is ignored). See [Decisions and memory](memory.md).

Errors: `none of <ids> is a DocSection or Symbol id; decision not recorded`. `POST /api/decisions` also limits `text` to 500 characters.

### `docs_patch` result

| Field | Meaning |
|---|---|
| `diff` | A unified diff of every edited file, `git apply`-able in each docs repository |
| `title` | `docs: update for <owner/repo>#<n> (<pull request title>)` |
| `body` | The pull request description: per edited section, the reason, evidence path, runs and decisions; then the sections left unchanged; then any edits not applied |
| `files[]` | `<repo>:<path>` for each changed file |

Summary: `<n> file(s) changed: <repo>:<path>, ….` or `No proposed edits for this pull request yet.` It reports no queries.

The patch is built from the latest verdict per section: `stale` verdicts with replacement text that were not rejected. Files are read at the indexed commit, from the local clone when there is one, otherwise from `raw.githubusercontent.com`. An edit whose section changed since indexing, or whose file is missing at that commit, is listed in the body under "Not applied" instead of being applied. No side effects. `GET /api/patch` returns the same patch with the verdicts and conflicts as separate fields; `staleproof patch` prints it.

Errors: `<pr-url> has not been checked`; `GitHub raw <path>@<sha> failed: <status>`; `git show` errors from a local clone.

## Related

- [Core concepts](concepts.md): the terms these results use
- [The agent](agent.md): how the agent calls the tools and what it is told
- [MCP server](mcp.md): connecting an MCP client to these tools
- [Graph model and Cypher](GRAPH-MODEL.md): the full text of every query
- [Example runner](example-runner.md): what `run_example` does underneath
