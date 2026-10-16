# MCP server

Staleproof's tools over the Model Context Protocol, so Claude Code, Claude Desktop, claude.ai, Cursor, VS Code or any MCP client can ask what a pull request can make false, run the affected examples, record verdicts and get the docs patch. Use the hosted server with nothing installed, or run `staleproof mcp` on your machine over stdio. This page covers both, what the server exposes, how results and errors look, a worked session and security notes.

## Hosted: nothing to install

The hosted server answers at `https://staleproof.dev/api/mcp` over Streamable HTTP. It is stateless: every request gets a fresh server, there are no sessions, and responses are plain JSON.

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http staleproof https://staleproof.dev/api/mcp` |
| Cursor | The one-click **Add to Cursor** button on [staleproof.dev/#/install](https://staleproof.dev/#/install), or this in `~/.cursor/mcp.json`: `{"mcpServers": {"staleproof": {"url": "https://staleproof.dev/api/mcp"}}}` |
| VS Code | The **Add to VS Code** button on the install page, or `code --add-mcp '{"name":"staleproof","type":"http","url":"https://staleproof.dev/api/mcp"}'` |
| Claude Desktop and claude.ai | Add a custom connector (Settings, Connectors) with the URL `https://staleproof.dev/api/mcp` |
| Any other client | Its setting for a remote (Streamable HTTP) server, with that URL |

Then ask, for example: "Which docs can https://github.com/FalkorDB/falkordb-py/pull/276 make false? Show the evidence path for each."

On the hosted server:

- **Any public repository is indexed on first use.** `check_pull_request`, `impact` and `clearance` index the pull request's repository when no graph has it, into the workspace graph of its owner (`gh-<owner>`), and index it again at its default branch head once that is more than 7 days old. FalkorDB's own repositories answer from the curated `falkordb` graph. The limits are in [Deploy](DEPLOY.md#hosted-mode).
- **Every other tool goes to the graph of the repository it names**: the `owner/repo:` prefix of its ids. A repository that is not indexed yet fails with `<owner/repo> is not indexed yet: call check_pull_request with one of its pull requests first`. A call that names no repository fails with `name a repository: pass a pull request URL (pr_url) or ids that start with owner/repo:`, except `decisions_for` and `write_decision`, which then use the curated graph.
- **No examples run.** `run_example` is not offered, because the service has no sandbox, and `check_pull_request` with `run_examples` executes nothing there. Run examples with the local server, the [CLI](cli.md#run) or the [GitHub Action](github-action.md).

## Local over stdio

`staleproof mcp` serves the tools on stdio from your machine, `run_example` included.

### Claude Code

```bash
claude mcp add staleproof -- npx -y staleproof mcp
```

With no `FALKORDB_URL`, the server uses the FalkorDB on `localhost:6379`, and starts a local one there (falkordblite) when nothing answers. `check_pull_request`, `impact` and `clearance` index the pull request's repository the first time they see it, at its default branch head, so nothing has to be set up first.

To use a FalkorDB elsewhere, or another graph:

```bash
claude mcp add staleproof -e FALKORDB_URL='falkor://falkordb:<password>@<host>:<port>' -e STALEPROOF_ORG=acme -- npx -y staleproof mcp
```

Use `falkors://` for an endpoint with TLS. Add `-e GITHUB_TOKEN=<token>` for private repositories and to raise GitHub's limit of 60 API requests an hour, which the first look at each pull request uses. Check the server with `claude mcp list`.

The stdio server uses the graph named by `--org` or `STALEPROOF_ORG` when one is set, else, like the CLI, the graph named after the owner of the repository each call is about, so `check` and the MCP tools read the same graph. Repositories it indexes on first use go into that graph.

### Claude Desktop, Cursor and other clients

Any client that launches a stdio server from a command, arguments and environment works. The configuration is the same everywhere:

```json
{
  "mcpServers": {
    "staleproof": {
      "command": "npx",
      "args": ["-y", "staleproof", "mcp"],
      "env": {
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

For a second graph, add a second entry, for example `staleproof-encode` with `"STALEPROOF_ORG": "encode"`.

### Over HTTP from your machine

`npx -y staleproof serve` exposes the same endpoint locally, at `http://127.0.0.1:8080/api/mcp`, for clients that only speak HTTP. Started plainly it answers from its one graph and indexes nothing on first use (index with `staleproof index` first); `serve --hosted` indexes any public repository on demand, as the hosted server does. See [HTTP API](http-api.md#post-apimcp).

## What the server exposes

| Property | Value |
|---|---|
| Server name | `staleproof` |
| Version | The package version (`staleproof --version`) |
| Capabilities | Tools only |
| Transport | stdio (`staleproof mcp`): stdout carries the protocol; the server logs `staleproof mcp: serving graph "<org>" from <url>` (password masked) and indexing progress (`staleproof: <message>`) to stderr. Streamable HTTP (`POST /api/mcp` of `staleproof serve` and of the hosted service): stateless, JSON responses; `GET` and `DELETE` answer 405. |
| Startup (stdio) | Connects to FalkorDB first. With neither `FALKORDB_URL` nor `--db` set and nothing on `localhost:6379`, it starts a local FalkorDB; the first start installs falkordblite, which takes about a minute, so a client may report a timeout on the very first launch. With a URL set and the server unreachable, the process exits with `cannot reach FalkorDB at <url>: …` and the client shows the server as failed. |

The server gives clients these instructions:

```text
Staleproof keeps docs true to code over a FalkorDB graph of an organisation's repositories. For a pull request, call check_pull_request first: it returns every doc section and example the change can make false, with the evidence path for each. To judge sections one by one: impact, read_section and run_example, decisions_for before editing, then propose_edit or record_verdict for every impacted section, and docs_patch for the diff. Every result lists the Cypher it ran.
```

The hosted server appends: `This is the hosted server: any public GitHub repository is indexed on first use (into a workspace graph named gh-<owner>); examples are not executed here; run them with the CLI (npx -y staleproof run <example-id> --pr <url>) or the GitHub Action.`

## The tools

Eleven tools over stdio; ten on the hosted server, which leaves out `run_example`. Each tool's description, as the client sees it, ends with the Cypher of the first query it runs; its input schema is JSON Schema. [Tools reference](tools.md) lists every parameter.

| Tool | What it does | Writes to the graph |
|---|---|---|
| [`check_pull_request`](tools.md#check_pull_request) | The whole check in one call, as the Markdown report the GitHub Action posts: the examples run before and after, every impacted section with its evidence path, the cleared symbols, and verdicts recorded earlier. `run_examples: true` also runs up to 3 affected examples before and after (local servers only; takes minutes). | A Check node (graph mode) with its trace; on the first call, the pull request and its changes; with `run_examples`, Run nodes |
| [`impact`](tools.md#impact) | The doc sections and examples a pull request can make false, with severity and the evidence path for each; 40 per call, page with `offset`. | On the first call for a pull request: the pull request and its symbol-level changes. |
| [`clearance`](tools.md#clearance) | The changed symbols that reach no doc within 3 call hops, each with a `git grep` command to check the claim. | As `impact`, if called first. |
| [`read_section`](tools.md#read_section) | The current Markdown of a section and its code examples. | No |
| [`run_example`](tools.md#run_example) | Runs an example in the sandbox, before and after a pull request with `pr_url`; identical runs are answered from the graph. Not on the hosted server. | Run nodes |
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

`check_pull_request` is different: it returns two text blocks, the Markdown report (its format is in [GitHub Action](github-action.md#the-comment)) and `Stored as check <check-id>. <summary>`.

## Errors

Errors come back as a result with `isError: true` and one text block:

| Cause | Message |
|---|---|
| Unknown tool | `unknown tool <name>` |
| A parameter the tool does not declare | `<tool> has no parameter <names>; its parameters are <list>` |
| Invalid input | `invalid input: <field or (root)>: <problem>; …` |
| The tool failed | The tool's message, for example `pr_url is required`, `refused: no path in the graph from <pr>'s changes to <section>. …`, `<pr> has not been checked yet; call impact first`, or `<owner/repo> is not indexed in the "<org>" graph. Run: staleproof index …` (from `staleproof serve` without `--hosted`, which indexes nothing on first use) |
| Hosted routing | `name a repository: …`, `<owner/repo> is not indexed yet: call check_pull_request with one of its pull requests first`, and the hosted limits ([Troubleshooting](troubleshooting.md#hosted-service)) |

Unknown parameters are rejected with the same message the agent loop uses, so a client never gets a silently different answer.

`propose_edit` and `record_verdict` need `pr_url` over MCP. In agent mode they default to the pull request under check; an MCP session has none, so without `pr_url` they fail with `pr_url is required`. Verdicts written over MCP belong to no check: they count for the patch and the pull request comment (the latest verdict per section wins), not for any agent check's stop condition.

## A worked session

This is the sequence a client would call for [falkordb-py#267](https://github.com/FalkorDB/falkordb-py/pull/267), which fixed the client's execution-plan parser. The prompts are what you type; each block shows the `tools/call` parameters (`name` and `arguments`) the client sends. The client chooses the calls, so its order can differ. `check_pull_request` answers the first prompt in one call; this session takes the step-by-step route, which also yields the section and example ids.

**"What docs can https://github.com/FalkorDB/falkordb-py/pull/267 make false? Show the evidence path for each."**

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

Take the section ids from the `impact` result. On the graph behind [Facts from the graph](FACTS.md), the GRAPH.PROFILE example passes before and after the pull request, and the GRAPH.EXPLAIN example fails both times with `Invalid graph operation on empty key`: it explains a query on a graph the page never creates. It was already broken, not by this pull request. When the graph already holds identical runs, the summary ends with `(recorded earlier; not re-run)`. On the hosted server `run_example` is not offered; ask the local server.

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

- **The local server runs code on your machine.** `run_example` (and `check_pull_request` with `run_examples`) clones the repositories, installs them from source, and executes docs code. The install step runs the projects' build steps with an allow-listed environment that leaves out `FALKORDB_URL`, `GITHUB_TOKEN` and model keys; the examples themselves run with a minimal environment and a socket-level block on network access other than the scratch FalkorDB. That is a guard, not a security boundary ([Example runner](example-runner.md#the-sandbox)).
- **It flushes the scratch FalkorDB** before every example run. Staleproof refuses only when the scratch server is the one in `FALKORDB_URL`; make sure `STALEPROOF_SCRATCH_URL` (or the local port 6390) holds nothing you need.
- **It writes to the graph.** Pull requests and their changes (`check_pull_request`, `impact`, `clearance`), checks (`check_pull_request`), runs (`run_example`), verdicts (`propose_edit`, `record_verdict`) and decisions (`write_decision`, which can also mark an older decision superseded). Nothing is deleted, but whoever uses the server changes what later checks, the comment and the patch see. On the hosted server those writes go to a shared workspace graph that everyone checking that repository there sees.
- **It writes nothing to GitHub.** No MCP tool opens a pull request or posts a comment; opening a docs pull request is the CLI's `patch --open-pr`.
- **Credentials sit in the client configuration** in plain text, including any FalkorDB password in `FALKORDB_URL` and a `GITHUB_TOKEN`. The hosted server needs none.
- Keep your client's approval prompts on for `run_example`, `propose_edit`, `record_verdict` and `write_decision`.

## Limits

- The tools take a GitHub pull request URL; uncommitted or unpushed changes cannot be checked. The local server indexes the pull request's repository on first use (private ones with `GITHUB_TOKEN`); the hosted server reads public repositories only.
- First-use indexing indexes the pull request's repository alone. For docs in another repository, index them together first (`staleproof index <code repo> <docs repo>`), or use `staleproof check <pr-url> --with <docs repo>`, or name them next to the repository on the website.
- The stdio server serves one graph. The hosted server picks the graph per repository.
- No `--fresh` over MCP: an identical recorded run is always answered from the graph. Use `staleproof run --fresh` to execute it again.
- Only `check_pull_request` stores a Check node; the other tools store no check and no trace.
- `impact` returns 40 sections per call; for a larger pull request the client must page with `offset`, as the summary tells it to.
- `/api/mcp` has no rate limit and no authentication, and its calls do not wait in the HTTP server's one-check-at-a-time queue.

## Related

- [Install](install.md)
- [Tools reference](tools.md)
- [Use cases](use-cases.md)
- [Example runner](example-runner.md)
- [Decisions and memory](memory.md)
- [CLI](cli.md)
