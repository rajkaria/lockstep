# MCP server

`staleproof mcp` serves the ten Staleproof tools over the Model Context Protocol on stdio, so Claude Code, Claude Desktop, Cursor or any MCP client can ask what a pull request can falsify, run the affected examples, record verdicts and get the docs patch. This page covers client configuration, what the server exposes, how results and errors look, a worked session and security notes.

## Claude Code

```bash
claude mcp add staleproof -e FALKORDB_URL=falkor://localhost:6379 -- npx -y staleproof mcp
```

To name the graph explicitly, or to use another organisation's graph:

```bash
claude mcp add staleproof -e FALKORDB_URL=falkor://localhost:6379 -e STALEPROOF_ORG=falkordb -- npx -y staleproof mcp
```

For FalkorDB Cloud, pass its URL instead: `-e FALKORDB_URL='falkor://falkordb:<password>@<host>:<port>'` (`falkors://` with TLS). Add `-e GITHUB_TOKEN=<token>` to raise GitHub's limit of 60 API requests an hour, which the first look at each pull request uses. Check the server with `claude mcp list`.

## Claude Desktop, Cursor and other clients

Any client that launches a stdio server from a command, arguments and environment works. The configuration is the same everywhere:

```json
{
  "mcpServers": {
    "staleproof": {
      "command": "npx",
      "args": ["-y", "staleproof", "mcp"],
      "env": {
        "FALKORDB_URL": "falkor://localhost:6379",
        "STALEPROOF_ORG": "falkordb"
      }
    }
  }
}
```

| Client | Where it goes |
|---|---|
| Claude Desktop | `claude_desktop_config.json`, opened from Settings, Developer, Edit Config. Restart the app after editing. |
| Cursor | `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` in one project. |
| Other clients | Their MCP server settings, as `command`, `args` and `env`. |

Desktop apps often start without your shell's `PATH`. If the client reports that `npx` is not found, set `command` to its absolute path (the output of `which npx`). The tools that run examples also need `git`, `tar` and uv or `python3` on the `PATH` the server sees.

One server serves one organisation's graph. For a second graph, add a second entry, for example `staleproof-encode` with `"STALEPROOF_ORG": "encode"`.

## What the server exposes

| Property | Value |
|---|---|
| Server name | `staleproof` |
| Version | The package version (`staleproof --version`) |
| Capabilities | Tools only |
| Transport | stdio. Stdout carries the protocol; the server logs `staleproof mcp: serving graph "<org>" from <url>` (password masked) to stderr. |
| Startup | Connects to FalkorDB first. If it cannot, the process exits with `cannot reach FalkorDB at <url>: …` and the client shows the server as failed. |

The server gives clients these instructions:

```text
Staleproof keeps docs true to code over a FalkorDB graph of an organisation's repositories. For a pull request: call impact first, read_section and run_example to judge each impacted section, decisions_for before editing, then propose_edit or record_verdict for every impacted section, and docs_patch to get the diff. Every result lists the Cypher it ran.
```

## The tools

Each tool's description, as the client sees it, ends with the Cypher of the first query it runs; its input schema is JSON Schema. [Tools reference](tools.md) lists every parameter.

| Tool | What it does | Writes to the graph |
|---|---|---|
| [`impact`](tools.md#impact) | The doc sections and examples a pull request can falsify, with severity and the evidence path for each; 40 per call, page with `offset`. | On the first call for a pull request: the pull request and its symbol-level changes. |
| [`clearance`](tools.md#clearance) | The changed symbols that reach no doc within 3 call hops, each with a `git grep` command to check the claim. | As `impact`, if called first. |
| [`read_section`](tools.md#read_section) | The current Markdown of a section and its code examples. | No |
| [`run_example`](tools.md#run_example) | Runs an example in the sandbox, before and after a pull request with `pr_url`; identical runs are answered from the graph. | Run nodes |
| [`decisions_for`](tools.md#decisions_for) | Maintainer decisions governing a section or symbol, and earlier verdicts on a section. | No |
| [`rank_sections`](tools.md#rank_sections) | Orders sections by the PageRank of their page in the docs' link graph. | No |
| [`propose_edit`](tools.md#propose_edit) | Records replacement Markdown for a section (a `stale` verdict). Refused without a path from the pull request's changes to the section. | A verdict |
| [`record_verdict`](tools.md#record_verdict) | Records `ok`, `governed` (must cite a decision) or `skipped` for one or more sections. | Verdicts |
| [`write_decision`](tools.md#write_decision) | Records a maintainer decision and what it governs. Its description tells the model to call it only when a human asks. | A decision |
| [`docs_patch`](tools.md#docs_patch) | The docs fix for a pull request as a unified diff, with a pull request title and description. MCP only. | No |

## Results

A successful call returns three text blocks:

1. The summary, one or two sentences.
2. The data, as indented JSON.
3. The Cypher the tool ran, omitted when it ran no named query (`docs_patch`, for example):

```text
Cypher run on FalkorDB:
-- impact (<rows> rows, <ms> ms)
MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
WHERE c.kind <> 'added'
…

-- prChanges (<rows> rows, <ms> ms)
MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
…
```

The time is FalkorDB's own server-side execution time for that query. Small lookups the tools make with unnamed queries are left out. [Graph model and Cypher](GRAPH-MODEL.md) has every named query in full.

## Errors

Errors come back as a result with `isError: true` and one text block:

| Cause | Message |
|---|---|
| Unknown tool | `unknown tool <name>` |
| A parameter the tool does not declare | `<tool> has no parameter <names>; its parameters are <list>` |
| Invalid input | `invalid input: <field or (root)>: <problem>; …` |
| The tool failed | The tool's message, for example `pr_url is required`, `refused: no path in the graph from <pr>'s changes to <section>. …`, `<pr> has not been checked yet; call impact first`, or `<owner/repo> is not indexed in the "<org>" graph. Run: staleproof index …` |

Unknown parameters are rejected with the same message the agent loop uses, so a client never gets a silently different answer.

`propose_edit` and `record_verdict` need `pr_url` over MCP. In agent mode they default to the pull request under check; an MCP session has none, so without `pr_url` they fail with `pr_url is required`. Verdicts written over MCP belong to no check: they count for the patch and the pull request comment (the latest verdict per section wins), not for any agent check's stop condition.

## A worked session

This is the sequence a client would call for [falkordb-py#267](https://github.com/FalkorDB/falkordb-py/pull/267), which fixed the client's execution-plan parser. The prompts are what you type; each block shows the `tools/call` parameters (`name` and `arguments`) the client sends. The client chooses the calls, so its order can differ.

**"What docs can https://github.com/FalkorDB/falkordb-py/pull/267 falsify? Show the evidence path for each."**

```json
{ "name": "impact", "arguments": { "pr_url": "https://github.com/FalkorDB/falkordb-py/pull/267" } }
```

The first call reads the pull request from GitHub and stores its changes. The graph reaches 3 doc sections, 2 of them in another repository: the GRAPH.EXPLAIN and GRAPH.PROFILE pages of `FalkorDB/docs`, through paths such as `ExecutionPlan._operation_tree ← ExecutionPlan.__init__ ← Graph.explain`. A grep for the changed names finds none of them.

**"Read those sections and run their examples before and after the pull request."**

```json
[
  { "name": "read_section", "arguments": { "section_id": "FalkorDB/docs:commands/graph.explain.mdx#<anchor>" } },
  { "name": "run_example", "arguments": { "example_id": "FalkorDB/docs:commands/graph.explain.mdx:0", "pr_url": "https://github.com/FalkorDB/falkordb-py/pull/267" } },
  { "name": "run_example", "arguments": { "example_id": "FalkorDB/docs:commands/graph.profile.mdx:0", "pr_url": "https://github.com/FalkorDB/falkordb-py/pull/267" } }
]
```

Take the section ids from the `impact` result. On the graph behind [Facts from the graph](FACTS.md), the GRAPH.PROFILE example passes before and after the pull request, and the GRAPH.EXPLAIN example fails both times with `Invalid graph operation on empty key`: it explains a query on a graph the page never creates. It was already broken, not by this pull request. When the graph already holds identical runs, the summary ends with `(recorded earlier; not re-run)`.

**"Check for maintainer decisions, then record a verdict for each section."**

```json
[
  { "name": "decisions_for", "arguments": { "target_id": "FalkorDB/docs:commands/graph.profile.mdx#<anchor>" } },
  { "name": "record_verdict", "arguments": { "pr_url": "https://github.com/FalkorDB/falkordb-py/pull/267", "section_ids": ["<section id>", "<section id>"], "verdict": "ok", "reason": "The parser fix does not change what these sections claim; the example passes before and after.", "runs": ["run-<id>", "run-<id>"] } }
]
```

Run ids come from the `run_example` result (`runs[].id`). For the GRAPH.EXPLAIN page you can ask for a fix to its already-broken example with `propose_edit`. The tool accepts it because the graph has a path from the pull request to the section; its description asks the reason to say that the example fails before and after and to cite both runs. When `deepseek-v4-pro` re-checked #267 in agent mode (check `chk-90817863f077`, 12 tool calls), it considered that fix and declined, because the page assumes a demo graph that already exists, and recommended fixing it separately.

**"Give me the docs patch for that pull request."**

```json
{ "name": "docs_patch", "arguments": { "pr_url": "https://github.com/FalkorDB/falkordb-py/pull/267" } }
```

With only `ok` verdicts, the summary is `No proposed edits for this pull request yet.` With proposed edits, the data holds the diff, a pull request title and description, and the changed files as `<owner>/<repo>:<path>`; ask the client to apply the diff in your checkout of the docs repository.

## Security notes

- **It runs code on your machine.** `run_example` clones the repositories, installs them from source, and executes docs code. Package installs fetch dependencies from the package index and run the projects' build steps with the server's environment, which includes `FALKORDB_URL` and any token you passed. The examples themselves run with a minimal environment and a socket-level block on network access other than the scratch FalkorDB; that is a guard, not a security boundary.
- **It flushes the scratch FalkorDB** before every example run. Staleproof refuses only when the scratch server is the one in `FALKORDB_URL`; make sure `STALEPROOF_SCRATCH_URL` (or the local port 6390) holds nothing you need.
- **It writes to the graph.** Pull requests and their changes (`impact`, `clearance`), runs (`run_example`), verdicts (`propose_edit`, `record_verdict`) and decisions (`write_decision`, which can also mark an older decision superseded). Nothing is deleted, but whoever uses the server changes what later checks, the comment and the patch see.
- **It writes nothing to GitHub.** No MCP tool opens a pull request or posts a comment; opening a docs pull request is the CLI's `patch --open-pr`.
- **Credentials sit in the client configuration** in plain text, including the FalkorDB password in `FALKORDB_URL`.
- Keep your client's approval prompts on for `run_example`, `propose_edit`, `record_verdict` and `write_decision`.

## Limits

- The tools take a GitHub pull request URL in a public repository that is indexed in the graph. Unpushed changes cannot be checked.
- One server, one organisation's graph.
- No `--fresh` over MCP: an identical recorded run is always answered from the graph. Use `staleproof run --fresh` to execute it again.
- An MCP session creates no Check node and no stored trace.
- `impact` returns 40 sections per call; for a larger pull request the client must page with `offset`, as the summary tells it to.

## Related

- [Tools reference](tools.md)
- [Use cases](use-cases.md)
- [Example runner](example-runner.md)
- [Decisions and memory](memory.md)
- [CLI](cli.md)
