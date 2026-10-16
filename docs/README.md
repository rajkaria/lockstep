# Staleproof documentation

Staleproof keeps a software organisation's documentation true to its code. This page explains what it does, the problem it solves, how a check works, and where to find everything else in these docs. Start here if you are new; jump to [Install](install.md) or the [Quickstart](getting-started.md) if you want to run it.

## What it is

`staleproof` is an open-source (MIT) command-line tool, GitHub Action, MCP server, HTTP API and Node.js library, also hosted at [staleproof.dev](https://staleproof.dev). It indexes your repositories into a [FalkorDB](https://www.falkordb.com) graph: Python, TypeScript and JavaScript symbols and the calls between them across repositories, every Markdown, MDX and reStructuredText doc section and code example, and the code each one mentions or calls, with every example call checked against the signature it reaches. For a GitHub pull request it walks that graph to find every doc section the change can make false, predicts which examples the change breaks before anything runs, runs the affected Python examples before and after the change in a sandbox, and (in agent mode) proposes the docs fix with the path in the graph behind each paragraph. Everything it concludes is written back to the graph, so the next check starts from what the last one learned. With no pull request, it checks a working tree before it is pushed, lists the docs that depend on a function before you change it, and audits the docs as they are, with a 0-100 health score.

## The problem

Docs drift for two reasons that code review does not catch:

- **The paragraph is in another repository.** A client library, the SDK built on it and the docs site usually live in separate repositories. A change to a function in the client can falsify a page in the docs site that never names that function: the page calls an SDK method, which calls a client method, which calls the function that changed. Nobody reviewing the client pull request sees that page.
- **Nobody re-runs the examples.** Code examples in docs are written once. When the library under them changes, or when they were never quite right, they stay broken until a reader reports it.

Searching for the changed names does not solve either problem, because the docs that break are usually the ones that reach the changed code indirectly.

## A worked example

[falkordb-py#262](https://github.com/FalkorDB/falkordb-py/pull/262) changed one function, `Is_Cluster`. The graph path is:

```text
Is_Cluster ← FalkorDB.__init__ ← README "Asynchronous Example"
```

The README example never names `Is_Cluster`; it calls the constructor, which calls it. Staleproof ran that example (`FalkorDB/falkordb-py:README.md:4`) against falkordb-py installed from source at both commits. It **fails before the pull request** with `TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry'` and **passes after it**: the pull request fixed a broken README example. A whole-word grep for `Is_Cluster` finds no doc section at all.

The same holds at larger scale. Across the four pull requests checked on FalkorDB's repositories, the graph reaches 120 doc sections; a whole-word grep for the changed names finds 30 of them and matches 227 other sections that no path from the change reaches. For the three falkordb-py pull requests, grep finds none of the 47 sections the graph reaches. On [falkordb-py#276](https://github.com/FalkorDB/falkordb-py/pull/276), 4 changed symbols reach 43 doc sections, 41 of them in other repositories. Every number here comes from [Facts from the graph](FACTS.md), which is generated from the graph.

## How a check works

1. **Index.** `staleproof index` (or the first check of a repository) clones your GitHub repositories, or downloads them where there is no git, and writes one graph per organisation: Python, TypeScript and JavaScript symbols and calls (resolved across repositories through imports, types and re-exports), doc sections and code examples, the symbols each one mentions or uses, and the example lines that no longer fit the code they call.
2. **Ingest the pull request.** The diff between the pull request's two commits becomes symbol-level changes (removed, renamed, signature, modified, added, export-removed), attached to the pull request in the graph.
3. **Trace.** Staleproof walks from each changed symbol back through up to 3 callers, in any repository, to the docs that mention or call them. That is the impact. The changed symbols with no such path are the clearance. For each impacted example it compares the call as written with the code after the pull request: a removed name or a call the new signature rejects is a predicted break.
4. **Prove.** For impacted Python examples, Staleproof installs the repositories from source at the commit before the pull request and at the pull request, runs the example in a sandbox against a scratch FalkorDB, and records both runs.
5. **Judge and remember.** In agent mode a model reads each impacted section, checks maintainers' decisions and earlier verdicts, and records a verdict or proposes an edit for every one. The docs patch is built from those edits. Every check, run and verdict stays in the graph.

The terms used above, in plain language:

- **Impact**: the doc sections and code examples a pull request can make false. A section is impacted when the graph has a path from a changed symbol, through up to 3 callers, to the section (because it mentions one of those symbols, or one of its examples calls one).
- **Evidence path**: that path, written out node by node, changed symbol first and doc last, as in the #262 example above. It is the reason a section is listed, and Staleproof refuses to edit a section without one.
- **Predicted break**: an example whose call fits the code before the pull request and not after it (a removed or renamed name, a new required argument, a keyword that no longer exists), found statically, before anything runs.
- **Mismatch**: an example line that does not fit the code it calls right now, found when the docs are indexed. The [docs audit](audit.md) lists them all, with a health score.
- **Clearance**: the changed symbols that no doc reaches within 3 call hops. The graph proves the absence; each one comes with a `git grep` command so you can check the claim yourself.
- **Verdict**: the conclusion about one section for one pull request: `stale` (with replacement text), `ok`, `governed` (a maintainer decision says it stays as it is) or `skipped`. Maintainers can accept or reject each verdict.
- **Verdict memory**: verdicts, example runs, maintainer decisions and checks stay in the graph. Later checks read them: an identical example run is answered from the graph, a decision is cited instead of re-flagging the section, and earlier verdicts (with whether maintainers accepted them) inform the next judgement.
- **Agent mode and graph mode**: in agent mode a model chooses which tools to call and in what order, judges every impacted section and proposes edits. It needs model API credentials (Claude, or an Anthropic-compatible provider). Graph mode runs the same tools in a fixed order with no model and samples rather than judges: impact, clearance, a ranking of the first impact page and at most 3 example runs. It writes no verdicts and no edits, and needs no key.

## Ways to use it

| Interface | What it is for | Docs |
|---|---|---|
| Website | Paste a pull request URL of any public repository on [staleproof.dev](https://staleproof.dev): indexed on the fly, checked in graph mode, nothing installed; or [audit a repository](https://staleproof.dev/#/audit) and get its README badge | [Install](install.md), [Docs audit](audit.md) |
| CLI | `npx -y staleproof <command>`: index, check a pull request or your working tree, audit, list the docs for a symbol, run an example, record a decision, build the patch; the first command starts FalkorDB and indexes the repository itself | [CLI](cli.md) |
| GitHub Action | `uses: rajkaria/staleproof@v1`, no inputs or secrets: a comment on every pull request with the docs it can make false, the evidence path for each, the examples predicted to break and the examples run before and after; on a schedule, a docs audit kept in one issue | [GitHub Action](github-action.md) |
| MCP server | The tools for Claude Code, Claude Desktop, claude.ai, Cursor, VS Code or any MCP client: hosted at `https://staleproof.dev/api/mcp`, or local over stdio | [MCP server](mcp.md) |
| HTTP API | `staleproof serve`: checks and audits streamed over server-sent events, the README badge, traces, patches, decisions, and the web UI | [HTTP API](http-api.md) |
| Node.js library | Index, check, patch and serve from your own TypeScript code | [Node.js library](library.md) |
| Self-host | Vercel with FalkorDB Cloud, Docker Compose on a VM, or a single machine without Docker | [Deploy](DEPLOY.md) |

## Status

- **Built and run** against FalkorDB's real repositories on the author's machine: the indexer, cross-repository impact, clearance, PageRank ranking, sandboxed example runs, decisions and verdict memory, the CLI, the MCP server, the web UI and graph-mode checks.
- **Agent mode** was written for Claude (default model `claude-sonnet-5-5`) and runs on any Anthropic-compatible API through `ANTHROPIC_BASE_URL`. It has been run with a real model through DeepSeek's Anthropic-compatible endpoint (`deepseek-v4-pro`, also what the live demo uses). The Claude path is tested against a local fake API only.
- **No edit proposed on FalkorDB's repositories yet.** The pull requests checked there are fixes, and every verdict recorded on #262, #267 and #276 is `ok`. Proposing edits and building the patch from them are exercised by the test suite on a fixture organisation.
- **Run end to end**: the GitHub Action's pull request check, from the one-click workflow, on a private test repository.
- **Written, not yet exercised**: the Docker image has not been built.
- **Live**: [staleproof.dev](https://staleproof.dev), in hosted mode: any public repository is indexed on first use into a workspace graph of its own, and MCP answers at `/api/mcp`. Examples are not executed there (no sandbox on Vercel); for FalkorDB's repositories, the before/after results come from runs recorded on the graph.

## Limits

- Code is read as Python, or TypeScript and JavaScript in published npm packages; docs as Markdown, MDX or reStructuredText. Only Python examples are run and get argument checks; JavaScript and TypeScript examples are linked and checked for names that do not exist. Other languages are indexed as text.
- Static checks and predicted breaks judge only calls resolved through imports and types; where the source cannot settle a call, they stay silent.
- GitHub repositories only. Private ones need `GITHUB_TOKEN` (the CLI, a server you run, the GitHub Action); the hosted site indexes public repositories only.
- Call resolution is static. What types do not reveal falls back to by-name edges (labelled as such) or to no edge.
- The example sandbox is a guard, not a security boundary, and example runs use today's third-party dependencies.

## Documentation map

**Start here**

- [Introduction](README.md): this page.
- [Quickstart](getting-started.md): three ways to start (website, GitHub Action, one command), then a local FalkorDB, FalkorDB's three repositories indexed, a pull request checked, an example run, the patch, the web UI and MCP.
- [Install](install.md): the website, the GitHub Action, the hosted and local MCP servers and the CLI, with what each needs and does.
- [Use cases](use-cases.md): SDK teams with a separate docs site, DevRel after a release, maintainers reviewing pull requests, a weekly docs audit, developers before they push, AI coding agents (with and without a pull request), platform teams with many repositories, and recording maintainer decisions.
- [Docs audit](audit.md): how true the docs are with no pull request: the checks, the score, the CLI, the web page and badge, the API, MCP and the scheduled Action.

**Integrate**

- [CLI](cli.md): every command and option, with examples, output and exit codes.
- [GitHub Action](github-action.md): one-click install, what a run does, inputs and outputs, permissions, the comment format, the docs fix pull request, the scheduled audit and keeping a graph between runs.
- [MCP server](mcp.md): the hosted endpoint, client configuration, the fourteen tools, result format, worked sessions (with and before a pull request) and security notes.
- [HTTP API](http-api.md): every endpoint of `staleproof serve`, including indexing on demand, audits, the badge and MCP over HTTP.
- [Node.js library](library.md): using Staleproof from TypeScript.

**How it works**

- [Core concepts](concepts.md): impact, evidence paths, severity, clearance, static checks, predicted breaks and the audit, verdicts, decisions, runs, checks, the two modes, ids.
- [Indexing](indexing.md): which files are read (Python, TypeScript, JavaScript; Markdown, MDX, reStructuredText), how calls are resolved across repositories, how docs link to and are checked against code, example directives, re-index semantics.
- [Example runner](example-runner.md): virtualenvs per commit, the sandbox, the scratch FalkorDB, skip rules, run outcomes.
- [Decisions and memory](memory.md): maintainer decisions, supersession, verdict review, what every check writes back.
- [The agent](agent.md): the loop, its system prompt and stop condition, model providers, budgets, graph mode.

**Reference**

- [Tools reference](tools.md): the fourteen tools, their parameters and the Cypher each runs.
- [Configuration](configuration.md): every environment variable and global option, and the per-repository `.staleproof.toml`.
- [Graph model and Cypher](GRAPH-MODEL.md): every Cypher statement Staleproof sends to FalkorDB, generated from the code.
- [Facts from the graph](FACTS.md): every number quoted about FalkorDB's repositories, generated from the graph.
- [Architecture](ARCHITECTURE.md): source layout and a check end to end.

**Operate**

- [Deploy](DEPLOY.md): Vercel with FalkorDB Cloud, Docker Compose, or no Docker; hosted mode and its limits.
- [Troubleshooting and FAQ](troubleshooting.md): common errors, limits and answers.

## For LLMs and tools

The site at [staleproof.dev](https://staleproof.dev) serves these docs as plain Markdown: an index at [/llms.txt](https://staleproof.dev/llms.txt), every page in one file at [/llms-full.txt](https://staleproof.dev/llms-full.txt), and each page at `/docs/<slug>.md` (this page is [/docs/introduction.md](https://staleproof.dev/docs/introduction.md)). The repository carries the same index as [llms.txt](../llms.txt), linking to the Markdown files on GitHub.

## Related

- [Quickstart](getting-started.md)
- [Use cases](use-cases.md)
- [Core concepts](concepts.md)
- [Facts from the graph](FACTS.md)
