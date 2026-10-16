# Lockstep documentation

Lockstep keeps a software organisation's documentation true to its code. This page explains what it does, the problem it solves, how a check works, and where to find everything else in these docs. Start here if you are new; jump to the [Quickstart](getting-started.md) if you want to run it.

## What it is

`lockstep-docs` is an open-source (MIT) command-line tool, MCP server, HTTP API and Node.js library. It indexes your repositories into a [FalkorDB](https://www.falkordb.com) graph: Python symbols and the calls between them across repositories, every Markdown/MDX doc section and code example, and the code each one mentions or calls. For a GitHub pull request it walks that graph to find every doc section the change can make false, runs the affected Python examples before and after the change in a sandbox, and (in agent mode) proposes the docs fix with the path in the graph behind each paragraph. Everything it concludes is written back to the graph, so the next check starts from what the last one learned.

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

The README example never names `Is_Cluster`; it calls the constructor, which calls it. Lockstep ran that example (`FalkorDB/falkordb-py:README.md:4`) against falkordb-py installed from source at both commits. It **fails before the pull request** with `TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry'` and **passes after it**: the pull request fixed a broken README example. A whole-word grep for `Is_Cluster` finds no doc section at all.

The same holds at larger scale. Across the four pull requests checked on FalkorDB's repositories, the graph reaches 120 doc sections; a whole-word grep for the changed names finds 30 of them and matches 227 other sections that no path from the change reaches. For the three falkordb-py pull requests, grep finds none of the 47 sections the graph reaches. On [falkordb-py#276](https://github.com/FalkorDB/falkordb-py/pull/276), 4 changed symbols reach 43 doc sections, 41 of them in other repositories. Every number here comes from [Facts from the graph](FACTS.md), which is generated from the graph.

## How a check works

1. **Index.** `lockstep-docs index` clones your public GitHub repositories and writes one graph per organisation: Python symbols and calls (resolved across repositories through imports, types and re-exports), doc sections and code examples, and the symbols each one mentions or uses.
2. **Ingest the pull request.** The diff between the pull request's two commits becomes symbol-level changes (removed, renamed, signature, modified, added, export-removed), attached to the pull request in the graph.
3. **Trace.** Lockstep walks from each changed symbol back through up to 3 callers, in any repository, to the docs that mention or call them. That is the impact. The changed symbols with no such path are the clearance.
4. **Prove.** For impacted Python examples, Lockstep installs the repositories from source at the commit before the pull request and at the pull request, runs the example in a sandbox against a scratch FalkorDB, and records both runs.
5. **Judge and remember.** In agent mode a model reads each impacted section, checks maintainers' decisions and earlier verdicts, and records a verdict or proposes an edit for every one. The docs patch is built from those edits. Every check, run and verdict stays in the graph.

The terms used above, in plain language:

- **Impact**: the doc sections and code examples a pull request can make false. A section is impacted when the graph has a path from a changed symbol, through up to 3 callers, to the section (because it mentions one of those symbols, or one of its examples calls one).
- **Evidence path**: that path, written out node by node, changed symbol first and doc last, as in the #262 example above. It is the reason a section is listed, and Lockstep refuses to edit a section without one.
- **Clearance**: the changed symbols that no doc reaches within 3 call hops. The graph proves the absence; each one comes with a `git grep` command so you can check the claim yourself.
- **Verdict**: the conclusion about one section for one pull request: `stale` (with replacement text), `ok`, `governed` (a maintainer decision says it stays as it is) or `skipped`. Maintainers can accept or reject each verdict.
- **Verdict memory**: verdicts, example runs, maintainer decisions and checks stay in the graph. Later checks read them: an identical example run is answered from the graph, a decision is cited instead of re-flagging the section, and earlier verdicts (with whether maintainers accepted them) inform the next judgement.
- **Agent mode and graph mode**: in agent mode a model chooses which tools to call and in what order, judges every impacted section and proposes edits. It needs model API credentials (Claude, or an Anthropic-compatible provider). Graph mode runs the same tools in a fixed order with no model and samples rather than judges: impact, clearance, a ranking of the first impact page and at most 3 example runs. It writes no verdicts and no edits, and needs no key.

## Ways to use it

| Interface | What it is for | Docs |
|---|---|---|
| CLI | `npx -y lockstep-docs <command>`: index, check, run an example, record a decision, build the patch | [CLI](cli.md) |
| GitHub Action | A comment on every pull request listing the docs it can falsify, with the evidence path for each | [GitHub Action](github-action.md) |
| MCP server | The ten tools for Claude Code, Claude Desktop, Cursor or any MCP client, over stdio | [MCP server](mcp.md) |
| HTTP API | `lockstep-docs serve`: checks streamed over server-sent events, traces, patches, decisions, and the web UI | [HTTP API](http-api.md) |
| Node.js library | Index, check, patch and serve from your own TypeScript code | [Node.js library](library.md) |
| Self-host | Vercel with FalkorDB Cloud, Docker Compose on a VM, or a single machine without Docker | [Deploy](DEPLOY.md) |

## Status

- **Built and run** against FalkorDB's real repositories on the author's machine: the indexer, cross-repository impact, clearance, PageRank ranking, sandboxed example runs, decisions and verdict memory, the CLI, the MCP server, the web UI and graph-mode checks.
- **Agent mode** was written for Claude (default model `claude-sonnet-5-5`) and runs on any Anthropic-compatible API through `ANTHROPIC_BASE_URL`. It has been run with a real model through DeepSeek's Anthropic-compatible endpoint (`deepseek-v4-pro`, also what the live demo uses). The Claude path is tested against a local fake API only.
- **No edit proposed on FalkorDB's repositories yet.** The pull requests checked there are fixes, and every verdict recorded on #262, #267 and #276 is `ok`. Proposing edits and building the patch from them are exercised by the test suite on a fixture organisation.
- **Written, not yet exercised**: the GitHub Action has not run on a live repository, and the Docker image has not been built.
- **Live demo**: [lockstep-rho.vercel.app](https://lockstep-rho.vercel.app). Examples are not executed there (no sandbox on Vercel); their before/after results come from runs recorded on the graph.

## Limits

- Code repositories are parsed as Python only. Docs can be any Markdown/MDX; JavaScript or other examples in the docs are indexed but not linked to code or run.
- Public GitHub repositories only.
- Call resolution is static. What types do not reveal falls back to by-name edges (labelled as such) or to no edge.
- The example sandbox is a guard, not a security boundary, and example runs use today's third-party dependencies.

## Documentation map

**Start here**

- [Introduction](README.md): this page.
- [Quickstart](getting-started.md): a local FalkorDB, FalkorDB's three repositories indexed, a pull request checked, an example run, the patch, the web UI and MCP.
- [Use cases](use-cases.md): SDK teams with a separate docs site, DevRel after a release, maintainers reviewing pull requests, AI coding agents, platform teams with many repositories, and recording maintainer decisions.

**Integrate**

- [CLI](cli.md): every command and option, with examples, output and exit codes.
- [GitHub Action](github-action.md): the workflow, inputs, permissions, the comment format and re-indexing.
- [MCP server](mcp.md): client configuration, the ten tools, result format, a worked session and security notes.
- [HTTP API](http-api.md): every endpoint of `lockstep-docs serve`.
- [Node.js library](library.md): using Lockstep from TypeScript.

**How it works**

- [Core concepts](concepts.md): impact, evidence paths, severity, clearance, verdicts, decisions, runs, checks, the two modes, ids.
- [Indexing](indexing.md): which files are read, how calls are resolved across repositories, how docs link to code, re-index semantics.
- [Example runner](example-runner.md): virtualenvs per commit, the sandbox, the scratch FalkorDB, skip rules, run outcomes.
- [Decisions and memory](memory.md): maintainer decisions, supersession, verdict review, what every check writes back.
- [The agent](agent.md): the loop, its system prompt and stop condition, model providers, budgets, graph mode.

**Reference**

- [Tools reference](tools.md): the ten tools, their parameters and the Cypher each runs.
- [Configuration](configuration.md): every environment variable and global option.
- [Graph model and Cypher](GRAPH-MODEL.md): every Cypher statement Lockstep sends to FalkorDB, generated from the code.
- [Facts from the graph](FACTS.md): every number quoted about FalkorDB's repositories, generated from the graph.
- [Architecture](ARCHITECTURE.md): source layout and a check end to end.

**Operate**

- [Deploy](DEPLOY.md): Vercel with FalkorDB Cloud, Docker Compose, or no Docker.
- [Troubleshooting and FAQ](troubleshooting.md): common errors, limits and answers.

## For LLMs and tools

The site at [lockstep-rho.vercel.app](https://lockstep-rho.vercel.app) serves these docs as plain Markdown: an index at [/llms.txt](https://lockstep-rho.vercel.app/llms.txt), every page in one file at [/llms-full.txt](https://lockstep-rho.vercel.app/llms-full.txt), and each page at `/docs/<slug>.md` (this page is [/docs/introduction.md](https://lockstep-rho.vercel.app/docs/introduction.md)). The repository carries the same index as [llms.txt](../llms.txt), linking to the Markdown files on GitHub.

## Related

- [Quickstart](getting-started.md)
- [Use cases](use-cases.md)
- [Core concepts](concepts.md)
- [Facts from the graph](FACTS.md)
