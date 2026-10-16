# Staleproof

**Every merge can make a tutorial lie — usually in another repository.** Staleproof finds the docs a pull request can
make false, proves it by running their examples before and after the change, and proposes the fix with the evidence
behind each paragraph. It works over a [FalkorDB](https://www.falkordb.com) graph of your code, docs and maintainers'
decisions, across every repository of the organisation.

[Live demo](https://staleproof.dev) · [Install](https://staleproof.dev/#/install) · [Documentation](docs/README.md) ·
[Quickstart](docs/getting-started.md) · [npm: `staleproof`](https://www.npmjs.com/package/staleproof) · MIT

```bash
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/262 --no-agent
```

## One pull request, end to end

[falkordb-py#262](https://github.com/FalkorDB/falkordb-py/pull/262) changed one function, `Is_Cluster`. No doc
mentions it, so searching the docs for the name finds nothing. The graph finds the paragraph anyway, because the
README's async example constructs `FalkorDB`, whose constructor calls the changed function:

```text
Is_Cluster  ← called by ─  FalkorDB.__init__  ← used in ─  README.md › "Asynchronous Example"   (falkordb-py)
```

Staleproof then ran that example against falkordb-py installed from source at both commits:

| Commit | Result |
|---|---|
| before the PR (`49aa012`) | **fails**: `TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry'` |
| after the PR (`f7c3de7`) | **passes** |

The README's async example was broken until this PR fixed it, and the run is the proof. Every number in this README
comes from [docs/FACTS.md](docs/FACTS.md), generated from the graph.

## Results on FalkorDB's repositories, against grep

What a reviewer can do without the graph is search the docs for the names the PR changed. Here is that search next to
the sections the graph reaches (≤ 3 call hops, any repository):

| Pull request | Sections the graph reaches | …in other repositories | grep finds of those | grep matches elsewhere |
|---|---:|---:|---:|---:|
| [falkordb-py#262](https://github.com/FalkorDB/falkordb-py/pull/262) | 1 | 0 | 0 | 0 |
| [falkordb-py#267](https://github.com/FalkorDB/falkordb-py/pull/267) | 3 | 2 | 0 | 0 |
| [falkordb-py#276](https://github.com/FalkorDB/falkordb-py/pull/276) | 43 | 41 | 0 | 8 |
| [GraphRAG-SDK#336](https://github.com/FalkorDB/GraphRAG-SDK/pull/336) | 73 | 3 | 30 | 219 |
| **Total** | **120** | **46** | **30** | **227** |

- **#267** fixed the execution-plan parser. The path `ExecutionPlan._operation_tree ← ExecutionPlan.__init__ ←
  Graph.explain` led into a different repository, the docs site's `GRAPH.EXPLAIN` and `GRAPH.PROFILE` pages. The
  `GRAPH.EXPLAIN` example **fails as written on a fresh server, before and after the PR** (`Invalid graph operation on
  empty key`: it explains a query on a graph the page never creates). The PR didn't break it; it was already broken.
- **#276** changed four asyncio symbols that reach **43 doc sections, 41 of them in other repositories**, through paths
  like `AsyncGraph.query ← FalkorDBConnection.query (GraphRAG-SDK) ← GraphStore.delete_document_chunks ←
  GraphRAG.delete_document ← GraphRAG-SDK README`. Of the 21 reachable examples tried at both commits, 10 pass both
  times, 6 fail both times (already broken, e.g. `GRAPH.EXPLAIN`, `GRAPH.CONSTRAINT CREATE`), 3 can't be installed
  together at those commits (GraphRAG-SDK 1.4.0 requires `falkordb>=1.8.0`; falkordb-py was 1.7.0 there) and 2 can't
  run as written (a placeholder host; a bash block).

## How it works, in plain words

1. **Index.** Clone the organisation's repositories into one graph: Python functions and the calls between them —
   resolved across repositories — plus every docs section and code example, linked to the code it mentions or calls.
2. **Impact.** From each function the PR changed, walk back up to three callers, in any repository, to the docs that
   mention or run them. Each hit carries its **evidence path**: the chain from the change to the paragraph.
3. **Clearance.** The changed functions that no doc reaches are listed as *cleared* — a proof of absence over the
   graph, with the `git grep` a reviewer can run to double-check it.
4. **Prove.** Run each affected example at the commit before the PR and at the PR, in a sandbox. *Passes before, fails
   after* means the PR broke it; *fails both* means it was already broken.
5. **Judge, fix, remember.** Every affected section ends with a **verdict** — stale (with the edit), ok, governed by a
   maintainer decision, or skipped — and the edits become a `git apply`-able patch. Verdicts, runs and decisions are
   written back to the graph (**verdict memory**), so the next PR cites a decision instead of re-flagging the section.

Two ways to run a check:

| | Agent mode | Graph mode |
|---|---|---|
| Who chooses the steps | A model (Claude, or any Anthropic-compatible API) | A fixed order: impact, clearance, ranking, up to three example runs |
| Covers | Every impacted section gets a verdict or an edit | A sample: findings, ranking and a few runs; no verdicts |
| Needs | `ANTHROPIC_API_KEY` | Nothing but FalkorDB |

## Quickstart

Three ways to start:

- **No install.** Paste a pull request URL of any public Python repository on [staleproof.dev](https://staleproof.dev).
  It is indexed on the fly and checked in graph mode; examples are not run on the hosted service.
- **One click.** On [staleproof.dev/#/install](https://staleproof.dev/#/install), type your repository and commit the
  workflow GitHub opens (or copy [`examples/staleproof.yml`](examples/staleproof.yml)). Every pull request then gets
  a comment with the docs it can make false and the examples run before and after it. No secrets, no database.
- **One command.** `npx -y staleproof check <pr-url> --no-agent` starts a local FalkorDB if none is configured,
  indexes the repository on first use (`--with owner/docs` for docs in another repository) and runs the check.
  Private repositories work with `GITHUB_TOKEN`.

The commands, step by step:

```bash
# FalkorDB locally without Docker (falkordblite; uv or pip installs it once). Optional: any command starts it.
npx -y staleproof db start

# Index an organisation's repositories into one graph (index them together so cross-repo calls resolve)
npx -y staleproof index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs

# Check a pull request: graph mode, or the agent with ANTHROPIC_API_KEY set
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/267 --no-agent
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/267

# Run one docs example before and after a PR
npx -y staleproof run "FalkorDB/docs:commands/graph.explain.mdx:0" --pr https://github.com/FalkorDB/falkordb-py/pull/267

# Record a maintainer decision; the next check cites it instead of re-flagging
npx -y staleproof decide "The async client keeps positional kwargs until 2.0" --governs "FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__"

# The docs fix as a patch (and, with GITHUB_TOKEN, a PR in your fork)
npx -y staleproof patch https://github.com/FalkorDB/falkordb-py/pull/267 [--open-pr]

# The web demo and its API
npx -y staleproof serve
```

The full walkthrough is in [docs/getting-started.md](docs/getting-started.md).

## Use it where your docs break

| Integration | One line | Guide |
|---|---|---|
| Website | Paste a pull request URL on [staleproof.dev](https://staleproof.dev) — no install, any public repository | [docs/install.md](docs/install.md) |
| CLI | `npx -y staleproof <command>` — index, check, run, decide, patch, serve | [docs/cli.md](docs/cli.md) |
| GitHub Action | `uses: rajkaria/staleproof@v1` — zero config: a comment on every PR with the docs it can make false and the examples run before and after ([`examples/staleproof.yml`](examples/staleproof.yml)) | [docs/github-action.md](docs/github-action.md) |
| MCP, hosted | `claude mcp add --transport http staleproof https://staleproof.dev/api/mcp` — nothing to install | [docs/mcp.md](docs/mcp.md) |
| MCP, local (Claude Code) | `claude mcp add staleproof -- npx -y staleproof mcp` — runs examples too | [docs/mcp.md](docs/mcp.md) |
| HTTP API | `staleproof serve`: JSON API with checks streamed over server-sent events | [docs/http-api.md](docs/http-api.md) |
| Node.js library | `import { runGraphCheck } from 'staleproof'` | [docs/library.md](docs/library.md) |
| Self-host | Vercel + FalkorDB Cloud (the live demo), Docker Compose, or a plain VM | [docs/DEPLOY.md](docs/DEPLOY.md) |

Who it is for: SDK and client-library teams whose docs live in another repository, DevRel and docs teams after a
release, maintainers reviewing pull requests, AI coding agents, and platform teams with many repositories —
[docs/use-cases.md](docs/use-cases.md).

## Documentation

| Start here | Integrate | How it works | Reference | Operate |
|---|---|---|---|---|
| [Introduction](docs/README.md) | [CLI](docs/cli.md) | [Core concepts](docs/concepts.md) | [Tools](docs/tools.md) | [Deploy](docs/DEPLOY.md) |
| [Quickstart](docs/getting-started.md) | [GitHub Action](docs/github-action.md) | [Indexing](docs/indexing.md) | [Configuration](docs/configuration.md) | [Troubleshooting and FAQ](docs/troubleshooting.md) |
| [Install](docs/install.md) | [MCP server](docs/mcp.md) | [Example runner](docs/example-runner.md) | [Graph model and Cypher](docs/GRAPH-MODEL.md) | |
| [Use cases](docs/use-cases.md) | | | | |
| | [HTTP API](docs/http-api.md) | [Decisions and memory](docs/memory.md) | [Facts from the graph](docs/FACTS.md) | |
| | [Node.js library](docs/library.md) | [The agent](docs/agent.md) | [Architecture](docs/ARCHITECTURE.md) | |

**For LLMs and coding assistants:** [`llms.txt`](llms.txt) indexes every page. The live site serves the same docs as
plain text — [`/llms.txt`](https://staleproof.dev/llms.txt),
[`/llms-full.txt`](https://staleproof.dev/llms-full.txt) (everything in one file) and `/docs/<page>.md` — and
every page on the site has a "Copy as Markdown" button.

## Why the graph is the product

The question asked on every pull request is *which paragraphs, in which repositories, can this change make false?*
That is a reachability question (excerpt of the `impact` tool's query; the full text is
[below](#every-cypher-query-the-product-depends-on)):

```cypher
MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
WHERE c.kind <> 'added'
MATCH p = (s)<-[:CALLS*0..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
WHERE (d:DocSection OR d:CodeExample) AND d.status = 'live'
RETURN d.id, length(p) AS hops, [n IN nodes(p) | coalesce(n.qualname, n.id)] AS evidence
```

**What breaks without FalkorDB:**

- **Impact** is a variable-length path through call edges that cross repositories (client → SDK → docs). A table needs
  a recursive join per hop and per repository; a vector store cannot express "reaches". On the indexed graph the
  impact query runs in about a millisecond server-side ([FACTS](docs/FACTS.md#impact-query-timing-server-side-falkordb)).
- **Clearance** is a proof of absence — the same pattern negated: changed symbols with *no* doc within 3 hops. Without
  the graph there is nothing to prove absence against. It counts bound paths (`OPTIONAL MATCH p = … count(p) = 0`)
  rather than using `WHERE NOT (pattern)`: on FalkorDB 4.18 the anonymous variable-length form can miss callers
  reachable along two routes of different length, and "proved" a symbol undocumented when a doc was three calls
  away. [test/traversal.test.ts](test/traversal.test.ts) reproduces it with the shape found in GraphRAG-SDK; every
  query binds its paths, and a test keeps it that way.
- **Decisions** govern symbols transitively (`GOVERNS` + `CALLS*0..2`) and resolve through `SUPERSEDES` chains, so a
  maintainer's decision made on one function covers the docs of everything that calls it.
- **Ranking** runs `algo.pageRank` over the docs' `LINKS_TO` graph, so the most-read stale page is fixed first.
- **Memory**: every check writes back `PullRequest`, `Run`, `Verdict` and `Check` nodes. The next pull request sees
  what earlier checks concluded, which runs already happened, and what maintainers accepted or rejected.

Take FalkorDB out and this is a grep over one repository.

```
GitHub (repositories) ──index──▶ FalkorDB: one graph per organisation ◀──tools──▶ Agent (Claude or an Anthropic-compatible model)
                                    ▲                                              │ trace (SSE)
     Sandbox runner ── Run nodes ───┘                                              ▼
     (virtualenv per repo@sha,                         CLI · MCP (stdio, HTTP) · website · GitHub Action
      scratch FalkorDB, no network)
```

### The tools

| Tool | What the agent uses it for |
|---|---|
| `impact` | Every section and example the PR can falsify, with severity and the evidence path |
| `clearance` | Changed symbols that reach no doc (plus the `git grep` a human can run to check) |
| `read_section` | The current Markdown of a section and its examples |
| `run_example` | Run an example before and after the PR in the sandbox |
| `decisions_for` | Maintainer decisions governing a section, and earlier verdicts on it |
| `rank_sections` | PageRank over the docs' link graph |
| `propose_edit` | Replacement Markdown for a stale section (refused without a path) |
| `record_verdict` | ok / governed / skipped, with the reason |

`write_decision` (humans record decisions; future checks cite them) and `docs_patch` are available over MCP, the CLI
and the web demo. MCP clients also get `check_pull_request`, the whole report for a pull request in one call.
Parameters, results and errors for each: [docs/tools.md](docs/tools.md).

## Status

| Status | What |
|---|---|
| **Built and run** (against FalkorDB's real repositories) | Indexer, cross-repo impact, clearance, PageRank ranking, sandboxed example runs before/after a PR, decisions and verdict memory, docs patch, CLI, MCP server, web demo, graph-mode checks. Covered by `npm run verify`. |
| **Agent mode, run with a real model** | `deepseek-v4-pro` through DeepSeek's Anthropic-compatible API ([how](docs/agent.md)), on the CLI and the live site. Each PR got a different tool order: #262 impact → read_section → decisions_for → run_example → record_verdict (5 calls, 1 verdict); #267 15 calls, 3 verdicts, each citing its before/after runs; #276 38 calls paging through 43 sections, all with verdicts. The first #276 run stopped at 40 turns with 21 sections open: `impact` capped results at 40 and the model's invented paging arguments were dropped silently; `impact` now pages, unknown arguments are an error, and the loop tracks every impacted section itself. Every verdict on these four PRs is `ok` — they are fixes, and FalkorDB updates its docs in the same PR — so the live graph holds no proposed edit; edits and the docs patch are exercised on the test fixture organisation. |
| **Live** | [staleproof.dev](https://staleproof.dev) (same deployment: [lockstep-rho.vercel.app](https://lockstep-rho.vercel.app)) on Vercel, deployed from `main`, querying the org graph on FalkorDB Cloud (4.22). Hosted workspaces: any public repository is indexed on first use into a workspace graph of its own (`gh-<owner>`), with size limits and least-recently-used eviction; MCP over HTTP at `https://staleproof.dev/api/mcp`. Published on npm as [`staleproof`](https://www.npmjs.com/package/staleproof). |
| **Multi-tenant** | One graph per organisation: a second graph (`encode`, from [encode/httpx](https://github.com/encode/httpx)) sits next to `falkordb` on the same server — [docs/FACTS-encode.md](docs/FACTS-encode.md). |
| **Run end to end** | The GitHub Action, exactly as the install page writes it (`uses: rajkaria/staleproof@v1`, no inputs), on a private test repository: a pull request that renamed a method the README's quickstart calls got one comment saying the pull request breaks that example (passes before, `AttributeError` after); when the same pull request then fixed the README, the comment updated in place to "passes before and after". A second pull request made an argument required and the comment named the README example that breaks with `TypeError`. |
| **Written, not exercised** | The Docker image (no Docker on the development machine). |
| **Designed** | Issue/discussion → symbol links ("asked about but undocumented"). See [VISION.md](VISION.md). |

Built for [Graph Hacks](https://www.wemakedevs.org/hackathons/falkordb) (WeMakeDevs × FalkorDB), tracks 01 and 03.

## Limits, stated plainly

- **Python code only.** Docs can be any Markdown/MDX; code repositories are parsed as Python. JavaScript examples in
  the docs are indexed but not linked or run.
- **Call resolution is static.** Dynamic dispatch the types don't reveal falls back to by-name edges inside repositories
  the module imports (labelled `by-name` everywhere they appear), or to no edge.
- **Index an organisation's repositories together.** Calls between repositories resolve only among repositories passed
  to the same `index` command (or `check --with`, or the Action's `also-index`); re-indexing one repository alone
  drops its cross-repository edges and the late links made when a PR was checked.
- **Change detection is per definition.** A moved file reads as every definition removed and added again;
  `export-removed` also fires when any module stops importing a name from its own package; a section longer than 8,000
  characters always shows as a conflict in the docs patch.
- **Graph mode samples.** It ranks the first page of impact and runs at most three examples; the agent covers every
  impacted section. Graph mode is what the Action runs without a key, and what the hosted site runs (without
  examples).
- **The sandbox is a guard, not a security boundary.** The example process refuses network connections and DNS at the
  Python socket level, gets no inherited secrets and a temp HOME, and is killed on timeout; the install step before it
  (which runs the repositories' build code at the PR's commits) gets only an allow-listed environment, so PR build
  code never sees the server's credentials. Run it inside a container for untrusted code.
- **Runs use today's third-party dependencies.** Repositories are installed from source at the exact commits; their
  dependencies resolve at run time.
- **On the live site, examples are not executed** (a Vercel Function has no sandbox): for FalkorDB's repositories
  their before/after results come from runs recorded on the graph by a local host; for other repositories, use the
  Action or the CLI. If the database is unreachable the page falls back to a labelled snapshot.
- **The agent was written for Claude** (`claude-sonnet-5-5`, adaptive thinking, refusal fallback); that path is tested
  against a local fake API only. The real runs above used `deepseek-v4-pro`.
- **Private repositories need a token.** The CLI and the Action read private GitHub repositories with `GITHUB_TOKEN`
  (the Action's default token covers its own repository); the hosted site indexes public repositories only.

More, with workarounds: [docs/troubleshooting.md](docs/troubleshooting.md).

## Every Cypher query the product depends on

<!-- generated:cypher:start -->
<!-- Generated by `npm run docs` from src/graph/queries.ts. Do not edit by hand. -->

| Tool | Cypher it runs |
|---|---|
| `impact` | `impact`, `prChanges`, `predictedCalls`, `mismatchesFor`, `upsertPullRequest`, `upsertChangedIn`, `upsertMissingSymbols`, `lateLinkSections`, `lateLinkExamples` |
| `clearance` | `clearance` |
| `read_section` | `readSection` |
| `run_example` | `exampleForRun`, `installSet`, `cachedRun`, `upsertRun`, `linkRunToPr` |
| `decisions_for` | `decisionsForSection`, `decisionsForSymbol`, `priorVerdicts` |
| `rank_sections` | `rankSections`, `rankSectionsByLinks` |
| `propose_edit` | `sectionReachedByPr`, `readSection`, `createVerdict` |
| `record_verdict` | `sectionReachedByPr`, `createVerdict` |
| `write_decision` | `createDecision`, `governSections`, `governSymbols`, `supersedeDecision` |

#### Queries the agent tools run

**`impact`** — Every doc section and code example a pull request reaches: changed symbol ← up to 3 callers (any repository) ← doc. The path is the evidence.

```cypher
MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
WHERE c.kind <> 'added'
MATCH p = (s)<-[:CALLS*0..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
WHERE (d:DocSection OR d:CodeExample) AND d.status = 'live'
OPTIONAL MATCH (d)-[:IN_SECTION]->(sec:DocSection)
RETURN s.qualname AS changed, c.kind AS change, c.before AS before, c.after AS after,
       t.qualname AS reached, labels(d)[0] AS kind, d.id AS doc, d.repo AS repo, d.path AS path,
       coalesce(sec.id, d.id) AS section, coalesce(sec.heading_path, d.heading_path, d.path) AS heading,
       d.url AS url, length(p) AS hops,
       [n IN nodes(p) | coalesce(n.qualname, n.id)] AS evidence,
       [x IN relationships(p) | coalesce(x.resolved, 'exact')] AS resolution
ORDER BY hops, repo, doc
```

**`clearance`** — Proof of absence: changed symbols with no doc section or example within 3 call hops in any repository.

```cypher
MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
WHERE c.kind <> 'added'
OPTIONAL MATCH p = (s)<-[:CALLS*0..3]-(:Symbol)<-[:MENTIONS|USES]-()
WITH s, c, count(p) AS reach
WHERE reach = 0
RETURN s.qualname AS symbol, s.name AS name, s.repo AS repo, c.kind AS change, s.visibility AS visibility
ORDER BY symbol
```

**`prChanges`** — What a pull request changed, symbol by symbol.

```cypher
MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
RETURN s.qualname AS symbol, s.kind AS kind, c.kind AS change, c.before AS before, c.after AS after,
       c.renamed_to AS renamedTo, s.repo AS repo, s.path AS path, s.status AS status
ORDER BY change, symbol
```

**`rankSections`** — Order doc sections by how central their page is: PageRank over LINKS_TO, summed per page.

```cypher
CALL algo.pageRank('DocSection', 'LINKS_TO') YIELD node, score
WITH node.repo + ':' + node.path AS page, node.id AS id, node.heading_path AS heading, score
WITH page, sum(score) AS pageScore, collect({id: id, heading: heading, score: score}) AS sections
UNWIND sections AS sec
WITH page, pageScore, sec
WHERE sec.id IN $ids
RETURN sec.id AS id, sec.heading AS heading, page, pageScore, sec.score AS score
ORDER BY pageScore DESC, score DESC
```

**`rankSectionsByLinks`** — Fallback ranking when graph algorithms are unavailable: inbound links per page.

```cypher
MATCH (d:DocSection)
WHERE d.id IN $ids
OPTIONAL MATCH (other:DocSection {repo: d.repo, path: d.path})<-[l:LINKS_TO]-()
RETURN d.id AS id, d.heading_path AS heading, d.repo + ':' + d.path AS page, count(l) AS pageScore, 0 AS score
ORDER BY pageScore DESC
```

**`readSection`** — The current text of a doc section, its code examples and its source link.

```cypher
MATCH (d:DocSection {id: $id})
OPTIONAL MATCH (e:CodeExample)-[:IN_SECTION]->(d)
WITH d, e ORDER BY e.index
RETURN d.id AS id, d.repo AS repo, d.path AS path, d.heading_path AS heading, d.body AS body, d.url AS url,
       d.lineno AS lineno, d.end_lineno AS endLineno,
       collect(CASE WHEN e IS NULL THEN NULL ELSE {id: e.id, lang: e.lang, code: e.code, lineno: e.lineno} END) AS examples
```

**`exampleForRun`** — A code example, the repositories its calls resolve into, and the earlier examples on its page (for stitching fragments).

```cypher
MATCH (e:CodeExample {id: $id})
OPTIONAL MATCH (e)-[:USES]->(s:Symbol)
WITH e, collect(DISTINCT s.repo) AS usedRepos
OPTIONAL MATCH (prev:CodeExample {repo: e.repo, path: e.path, status: 'live'})
WHERE prev.index < e.index
WITH e, usedRepos, prev
ORDER BY prev.index
RETURN e.id AS id, e.lang AS lang, e.code AS code, e.repo AS repo, e.path AS path, e.url AS url, e.directive AS directive, usedRepos,
       collect(CASE WHEN prev IS NULL THEN NULL ELSE {id: prev.id, lang: prev.lang, code: prev.code} END) AS earlier
```

**`installSet`** — Repositories to install for a run: the given ones plus their in-org dependencies (DEPENDS_ON), code repositories only.

```cypher
MATCH (r:Repo)
WHERE r.name IN $repos
OPTIONAL MATCH dep = (r)-[:DEPENDS_ON*1..3]->(d:Repo)
WITH collect(DISTINCT r) + collect(DISTINCT d) AS repos
UNWIND repos AS repo
WITH DISTINCT repo
WHERE repo IS NOT NULL AND size(repo.packages) > 0
RETURN repo.name AS repo, repo.sha AS sha
ORDER BY repo
```

**`decisionsForSection`** — Active decisions governing a doc section directly, or any symbol its prose or examples reach within 2 call hops; superseded decisions resolve to their successor.

```cypher
MATCH (d:DocSection {id: $id})
OPTIONAL MATCH (dec0:Decision)-[:GOVERNS]->(d)
OPTIONAL MATCH p1 = (d)-[:MENTIONS]->(:Symbol)-[:CALLS*0..2]->(g1:Symbol)<-[:GOVERNS]-(dec1:Decision)
OPTIONAL MATCH p2 = (d)<-[:IN_SECTION]-(:CodeExample)-[:USES]->(:Symbol)-[:CALLS*0..2]->(g2:Symbol)<-[:GOVERNS]-(dec2:Decision)
WITH collect(DISTINCT {dec: dec0, via: d.heading_path}) + collect(DISTINCT {dec: dec1, via: g1.qualname})
     + collect(DISTINCT {dec: dec2, via: g2.qualname}) AS hits
UNWIND hits AS hit
WITH hit.dec AS dec, hit.via AS via
WHERE dec IS NOT NULL
OPTIONAL MATCH chain = (newer:Decision {status: 'active'})-[:SUPERSEDES*1..10]->(dec)
WITH coalesce(newer, dec) AS current, dec AS matched, via
WHERE current.status = 'active'
RETURN DISTINCT current.id AS id, current.text AS text, current.source_url AS source, current.author AS author,
       current.created_at AS createdAt, matched.id AS matched, via
```

**`decisionsForSymbol`** — Active decisions governing a symbol or anything it calls within 2 hops; superseded decisions resolve to their successor.

```cypher
MATCH p = (s:Symbol {id: $id})-[:CALLS*0..2]->(g:Symbol)<-[:GOVERNS]-(dec:Decision)
OPTIONAL MATCH chain = (newer:Decision {status: 'active'})-[:SUPERSEDES*1..10]->(dec)
WITH coalesce(newer, dec) AS current, dec AS matched, g.qualname AS via
WHERE current.status = 'active'
RETURN DISTINCT current.id AS id, current.text AS text, current.source_url AS source, current.author AS author,
       current.created_at AS createdAt, matched.id AS matched, via
```

**`sectionReachedByPr`** — Guard for edits: is there a path from this pull request's changes to the section (or one of its examples)?

```cypher
MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
WHERE c.kind <> 'added'
MATCH p = (s)<-[:CALLS*0..3]-(:Symbol)<-[:MENTIONS|USES]-(d)
WHERE d.id = $section OR (d)-[:IN_SECTION]->(:DocSection {id: $section})
WITH p
ORDER BY length(p)
LIMIT 1
RETURN [n IN nodes(p) | coalesce(n.qualname, n.id)] AS path
```

**`predictedCalls`** — Examples that call a symbol the pull request removed, renamed, stopped exporting or re-signed, with the call as written (checked against the new signature in code).

```cypher
MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
WHERE c.kind IN ['removed', 'renamed', 'signature', 'export-removed']
MATCH (e:CodeExample)-[u:USES]->(s)
WHERE e.status = 'live' AND e.lang = 'python' AND coalesce(e.directive, '') = ''
OPTIONAL MATCH (e)-[:IN_SECTION]->(sec:DocSection)
RETURN e.id AS example, e.code AS code, e.lineno AS lineno, e.url AS url, e.repo AS repo, e.path AS path,
       coalesce(sec.id, e.id) AS section, u.line AS line, u.text AS text, u.resolved AS resolved,
       s.qualname AS symbol, s.name AS name, s.kind AS symbolKind, s.decorators AS decorators,
       c.kind AS change, c.before AS before, c.after AS after, c.renamed_to AS renamedTo
ORDER BY example, line
```

**`mismatchesFor`** — Example lines that already did not fit the code when indexed (MISMATCH edges), for the given examples.

```cypher
MATCH (e:CodeExample)-[m:MISMATCH]->(s:Symbol)
WHERE e.id IN $ids AND e.status = 'live'
RETURN e.id AS example, e.url AS url, m.line AS line, m.kind AS kind, m.detail AS detail, m.text AS call
ORDER BY example, line
```

**`findSymbols`** — Symbols a name refers to: an id, a qualified name, a dotted suffix (Graph.query) or a bare name.

```cypher
MATCH (s:Symbol)
WHERE s.status = 'live' AND s.kind <> 'module'
  AND (s.id = $name OR s.qualname = $name OR s.qualname ENDS WITH $suffix OR s.name = $name)
  AND (size($repos) = 0 OR s.repo IN $repos)
RETURN s.id AS id, s.qualname AS qualname, s.name AS name, s.kind AS kind, s.repo AS repo, s.signature AS signature, s.path AS path, s.lineno AS lineno
ORDER BY qualname
LIMIT 50
```

**`docsForSymbol`** — Every doc section and example that reaches a symbol: symbol ← up to 3 callers (any repository) ← doc, with the path. Impact without a pull request.

```cypher
MATCH (s:Symbol)
WHERE s.id IN $ids
MATCH p = (s)<-[:CALLS*0..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
WHERE (d:DocSection OR d:CodeExample) AND d.status = 'live'
OPTIONAL MATCH (d)-[:IN_SECTION]->(sec:DocSection)
RETURN s.qualname AS changed, 'lookup' AS change, s.signature AS before, s.signature AS after,
       t.qualname AS reached, labels(d)[0] AS kind, d.id AS doc, d.repo AS repo, d.path AS path,
       coalesce(sec.id, d.id) AS section, coalesce(sec.heading_path, d.heading_path, d.path) AS heading,
       d.url AS url, length(p) AS hops,
       [n IN nodes(p) | coalesce(n.qualname, n.id)] AS evidence,
       [x IN relationships(p) | coalesce(x.resolved, 'exact')] AS resolution
ORDER BY hops, repo, doc
```

**`impactOfChanges`** — Impact of changes that are not a pull request yet (a working tree, an editor's edits): the impact walk from a list of changed symbols.

```cypher
UNWIND $changes AS ch
MATCH (s:Symbol {id: ch.id})
WHERE ch.kind <> 'added'
MATCH p = (s)<-[:CALLS*0..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
WHERE (d:DocSection OR d:CodeExample) AND d.status = 'live'
OPTIONAL MATCH (d)-[:IN_SECTION]->(sec:DocSection)
RETURN s.qualname AS changed, ch.kind AS change, ch.before AS before, ch.after AS after,
       t.qualname AS reached, labels(d)[0] AS kind, d.id AS doc, d.repo AS repo, d.path AS path,
       coalesce(sec.id, d.id) AS section, coalesce(sec.heading_path, d.heading_path, d.path) AS heading,
       d.url AS url, length(p) AS hops,
       [n IN nodes(p) | coalesce(n.qualname, n.id)] AS evidence,
       [x IN relationships(p) | coalesce(x.resolved, 'exact')] AS resolution
ORDER BY hops, repo, doc
```

**`predictedCallsOfChanges`** — Examples that call a changed symbol (removed, renamed, stopped exporting, re-signed) in changes that are not a pull request yet.

```cypher
UNWIND $changes AS ch
MATCH (s:Symbol {id: ch.id})
WHERE ch.kind IN ['removed', 'renamed', 'signature', 'export-removed']
MATCH (e:CodeExample)-[u:USES]->(s)
WHERE e.status = 'live' AND e.lang = 'python' AND coalesce(e.directive, '') = ''
OPTIONAL MATCH (e)-[:IN_SECTION]->(sec:DocSection)
RETURN e.id AS example, e.code AS code, e.lineno AS lineno, e.url AS url, e.repo AS repo, e.path AS path,
       coalesce(sec.id, e.id) AS section, u.line AS line, u.text AS text, u.resolved AS resolved,
       s.qualname AS symbol, s.name AS name, s.kind AS symbolKind, s.decorators AS decorators,
       ch.kind AS change, ch.before AS before, ch.after AS after, ch.renamed_to AS renamedTo
ORDER BY example, line
```

**`clearanceOfChanges`** — Proof of absence for changes that are not a pull request yet: changed symbols no doc reaches within 3 call hops.

```cypher
UNWIND $changes AS ch
MATCH (s:Symbol {id: ch.id})
WHERE ch.kind <> 'added'
OPTIONAL MATCH p = (s)<-[:CALLS*0..3]-(:Symbol)<-[:MENTIONS|USES]-()
WITH s, ch, count(p) AS reach
WHERE reach = 0
RETURN s.qualname AS symbol, s.name AS name, s.repo AS repo, ch.kind AS change, s.visibility AS visibility
ORDER BY symbol
```

#### Memory: decisions, verdicts, runs, checks

**`cachedRun`** — An identical earlier run (same program, same commits): the graph remembers what already ran.

```cypher
MATCH (r:Run {key: $key})
RETURN properties(r) AS props
ORDER BY r.created_at DESC
LIMIT 1
```

**`upsertRun`** — Record an example execution: status, error line, traceback, commits installed.

```cypher
MATCH (e:CodeExample {id: $example})
MERGE (r:Run {id: $id})
SET r += $props
MERGE (r)-[:OF]->(e)
```

**`linkRunToPr`** — Attach a run to the pull request it was evidence for.

```cypher
MATCH (r:Run {id: $id})
MATCH (pr:PullRequest {url: $pr})
MERGE (r)-[:AT]->(pr)
```

**`priorVerdicts`** — What Staleproof concluded about this section on earlier pull requests, and what maintainers did with it.

```cypher
MATCH (v:Verdict)-[:ABOUT]->(:DocSection {id: $id})
MATCH (v)-[:FOR]->(pr:PullRequest)
RETURN v.id AS id, v.verdict AS verdict, v.status AS status, v.reason AS reason, pr.url AS pr, pr.title AS title, v.created_at AS createdAt
ORDER BY createdAt DESC
LIMIT 5
```

**`createDecision`** — Record a maintainer decision.

```cypher
CREATE (dec:Decision {id: $id})
SET dec += $props
RETURN dec.id AS id
```

**`governSections`** — Attach a decision to the doc sections it governs.

```cypher
MATCH (dec:Decision {id: $id})
MATCH (d:DocSection)
WHERE d.id IN $governs
MERGE (dec)-[:GOVERNS]->(d)
RETURN count(d) AS n
```

**`governSymbols`** — Attach a decision to the symbols it governs.

```cypher
MATCH (dec:Decision {id: $id})
MATCH (s:Symbol)
WHERE s.id IN $governs
MERGE (dec)-[:GOVERNS]->(s)
RETURN count(s) AS n
```

**`supersedeDecision`** — Mark an older decision superseded by a newer one.

```cypher
MATCH (newer:Decision {id: $newer})
MATCH (older:Decision {id: $older})
MERGE (newer)-[:SUPERSEDES]->(older)
SET older.status = 'superseded'
```

**`createVerdict`** — Record the agent's verdict on one section for one pull request, with the decisions and runs it cites.

```cypher
MATCH (d:DocSection {id: $section})
MATCH (pr:PullRequest {url: $pr})
CREATE (v:Verdict {id: $id})
SET v += $props
MERGE (v)-[:ABOUT]->(d)
MERGE (v)-[:FOR]->(pr)
WITH v
OPTIONAL MATCH (dec:Decision) WHERE dec.id IN $cites
FOREACH (_ IN CASE WHEN dec IS NULL THEN [] ELSE [1] END | MERGE (v)-[:CITES]->(dec))
WITH DISTINCT v
OPTIONAL MATCH (r:Run) WHERE r.id IN $runs
FOREACH (_ IN CASE WHEN r IS NULL THEN [] ELSE [1] END | MERGE (v)-[:EVIDENCE]->(r))
RETURN DISTINCT v.id AS id
```

**`verdictsForPr`** — The latest verdict per section for a pull request (what the docs patch is built from).

```cypher
MATCH (v:Verdict)-[:FOR]->(:PullRequest {url: $pr})
MATCH (v)-[:ABOUT]->(d:DocSection)
OPTIONAL MATCH (v)-[:CITES]->(dec:Decision)
OPTIONAL MATCH (v)-[:EVIDENCE]->(r:Run)
WITH v, d, collect(DISTINCT dec.id) AS cites, collect(DISTINCT {id: r.id, status: r.status, side: r.side, error: r.error}) AS runs
ORDER BY v.created_at DESC
WITH d, collect({v: v, cites: cites, runs: runs})[0] AS latest
RETURN d.id AS section, d.repo AS repo, d.path AS path, d.heading_path AS heading, d.lineno AS lineno,
       d.end_lineno AS endLineno, d.url AS url, latest.v.id AS id, latest.v.verdict AS verdict,
       latest.v.status AS status, latest.v.reason AS reason, latest.v.new_text AS newText,
       latest.v.old_text AS oldText, latest.v.evidence AS evidence, latest.cites AS cites, latest.runs AS runs
ORDER BY repo, path, lineno
```

**`reviewVerdict`** — A maintainer accepts or rejects a verdict; precision is measured from these.

```cypher
MATCH (v:Verdict {id: $id})
SET v.status = $status, v.reviewed_by = $by, v.reviewed_at = $at
RETURN v.id AS id
```

**`sinceLastCheck`** — What changed in the graph since a moment: pull requests checked, verdicts, decisions, runs.

```cypher
OPTIONAL MATCH (pr:PullRequest) WHERE pr.ingested_at > $since
WITH collect(DISTINCT {url: pr.url, title: pr.title}) AS prs
OPTIONAL MATCH (v:Verdict) WHERE v.created_at > $since
WITH prs, count(v) AS verdicts, sum(CASE WHEN v.verdict = 'stale' THEN 1 ELSE 0 END) AS stale
OPTIONAL MATCH (dec:Decision) WHERE dec.created_at > $since
WITH prs, verdicts, stale, collect(DISTINCT {id: dec.id, text: dec.text}) AS decisions
OPTIONAL MATCH (r:Run) WHERE r.created_at > $since
RETURN prs, verdicts, stale, decisions, count(r) AS runs,
       sum(CASE WHEN r.status = 'fail' THEN 1 ELSE 0 END) AS failedRuns
```

**`lastCheck`** — When the previous agent check ran (for "since your last run").

```cypher
MATCH (c:Check)
WHERE c.status <> 'running'
RETURN c.id AS id, c.started_at AS startedAt, c.pr AS pr
ORDER BY c.started_at DESC
LIMIT 1
```

**`createCheck`** — Start an agent check of a pull request.

```cypher
MATCH (pr:PullRequest {url: $pr})
CREATE (c:Check {id: $id})
SET c += $props
MERGE (c)-[:FOR]->(pr)
```

**`finishCheck`** — Close an agent check: status, summary, and the full trace (every tool call with its Cypher).

```cypher
MATCH (c:Check {id: $id})
SET c += $props
WITH c
MATCH (v:Verdict {check: $id})
MERGE (c)-[:PRODUCED]->(v)
RETURN count(v) AS verdicts
```

**`sectionsWithVerdict`** — Sections that received a verdict during this check (the stop condition).

```cypher
MATCH (v:Verdict {check: $id})-[:ABOUT]->(d:DocSection)
RETURN DISTINCT d.id AS id
```

Indexing and reporting queries (43 more) are in [docs/GRAPH-MODEL.md](docs/GRAPH-MODEL.md).
<!-- generated:cypher:end -->

## Develop

```bash
npm install
npm run verify      # typecheck (engine + web) and the test suite; starts a local FalkorDB on :6380 without Docker
npm run build       # dist/, web/dist/ (with /llms.txt, /llms-full.txt, /docs/*.md) and the prerendered home page
npm run docs        # regenerate the Cypher section above, docs/GRAPH-MODEL.md, docs/tools.md and llms.txt from the code
```

Architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## AI assistance

Staleproof was written with Claude Code (Anthropic) as the coding assistant: implementation, tests and docs, under the
author's direction and review. The graph model, the queries and the design decisions are documented in this
repository so that every one of them can be explained and checked.

## License

MIT
