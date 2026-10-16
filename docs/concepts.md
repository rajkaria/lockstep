# Core concepts

This page defines the vocabulary the rest of the documentation uses: the graph and its ids, how a pull request becomes symbol-level changes, impact and its evidence paths, clearance, ranking, example runs, verdicts, decisions, memory, checks, the two check modes and the docs patch. Every other page links here for definitions, so each term has its own heading. The running examples are three pull requests on FalkorDB's Python client, checked against FalkorDB's three repositories (`FalkorDB/falkordb-py`, `FalkorDB/GraphRAG-SDK`, `FalkorDB/docs`).

## In one line each

| Term | Plain meaning |
|---|---|
| [The graph](#the-graph) | One FalkorDB graph per organisation: code, docs, pull requests and everything checks conclude |
| [Change kinds](#change-kinds) | What a pull request did to each Python definition: removed, renamed, signature, modified, added, export-removed |
| [Severity](#severity) | `breaking`, `api` or `behavior`, derived from the change kind |
| [Impact](#impact) | The doc sections and examples a pull request can make false |
| [Evidence path](#evidence-path) | The path in the graph from a changed symbol to a doc, written node by node |
| [Hops](#hops) | The number of edges on an evidence path |
| [Resolution](#resolution) and [confidence](#confidence) | How each edge was resolved (`exact`, `by-name`, `late`) and what that makes the whole path |
| [Clearance](#clearance) | The changed symbols that no doc reaches; the graph proves the absence |
| [Ranking](#ranking) | PageRank over the links between doc pages, so the most central page comes first |
| [Runs](#runs) | One execution of a docs example in the sandbox, and the before/after outcome |
| [Verdicts](#verdicts) | The conclusion about one section for one pull request |
| [Decisions](#decisions) | A maintainer's ruling that some docs stay as they are |
| [Memory](#memory) | What every check writes back, and what the next check reads |
| [Checks](#checks) | One run of the check loop on one pull request, stored with its full trace |
| [Agent mode and graph mode](#agent-mode-and-graph-mode) | A model chooses the tools, or the same tools run in a fixed order with no model |
| [The docs patch](#the-docs-patch) | The proposed edits as a `git apply`-able diff with a PR description |

## The graph

Everything lives in one FalkorDB graph per organisation. The graph name is the organisation slug (`--org` or `STALEPROOF_ORG`, default `falkordb`), lowercased with anything outside `a-z 0-9 _ -` turned into `-`. Several organisations can share one FalkorDB server; FalkorDB's graphs are the tenancy boundary.

The code and docs half of the graph, which the [impact](#impact) walk follows from right to left:

```text
 Repo ──DEPENDS_ON──▶ Repo
  ▲
  │ IN_REPO
  │
 File ◀──DEFINED_IN── Symbol ──CALLS──▶ Symbol ──CHANGED_IN {kind}──▶ PullRequest
                        ▲  ▲
               MENTIONS │  │ USES
                        │  │
            DocSection ─┘  └─ CodeExample
                 │   ▲             │
        LINKS_TO │   └─IN_SECTION──┘
                 ▼
            DocSection
```

`DocSection` and `CodeExample` nodes are also `DEFINED_IN` their `File`. The memory half (verdicts, runs, decisions, checks) is listed under [Edges](#edges). The full list of node properties and every Cypher statement is in [Graph model and Cypher](GRAPH-MODEL.md).

### Repo, File and Symbol

- **Repo**: one per indexed GitHub repository: `name`, `url`, `sha` (the indexed commit), `indexed_at`, and `packages` (the top-level Python packages it defines, empty for a docs-only repository).
- **File**: one per indexed file (Python, Markdown/MDX, example script), with its `kind`.
- **Symbol**: one per Python definition: `kind` is `module`, `class`, `function` or `method` (a `def` directly inside a class body; a `def` nested in a method is a `function`). It carries `qualname`, `name`, `signature`, the first line of its docstring, `decorators`, `visibility` (`special` for `__x__`, `private` for a leading `_`, else `public`) and `status`.

`status` is `live`, `gone` (the definition disappeared on a re-index; never deleted) or `removed` (recreated from a pull request that removed it; see [Pull request ingestion](#pull-request-ingestion)).

### DocSection and CodeExample

- **DocSection**: one per heading of a Markdown or MDX page, from the heading line to the next heading of any level. Text before the first heading is a level-0 section with an empty anchor. It stores `heading_path` (the ancestor headings joined with `>`, for example `falkordb-py > Usage > Asynchronous Example`), `anchor`, `body` (the section's Markdown, up to 8000 characters), the code identifiers named in its inline code (`idents`) and a GitHub `url` pinned to the indexed commit.
- **CodeExample**: one per fenced code block in a page (any language), plus one per example script in a code repository (`examples/*.py` and similar). It stores `lang`, `code`, `kind` (`fenced` or `script`) and `idents`.

How pages are split and linked is in [Indexing](indexing.md).

### Ids

| Node | Id format | Example |
|---|---|---|
| Repo | `owner/name` | `FalkorDB/falkordb-py` |
| File | `owner/name:path` | `FalkorDB/docs:commands/graph.explain.mdx` |
| Symbol | `owner/name:qualname` | `FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__` |
| DocSection | `owner/name:path#anchor` | `FalkorDB/falkordb-py:README.md#asynchronous-example` |
| DocSection (text before the first heading) | `owner/name:path#` | `FalkorDB/docs:commands/graph.explain.mdx#` |
| CodeExample | `owner/name:path:index` | `FalkorDB/falkordb-py:README.md:4` |
| PullRequest | its URL | `https://github.com/FalkorDB/falkordb-py/pull/262` |
| Decision | `dec-` + 10 hex characters | |
| Verdict | `ver-` + 12 hex characters | |
| Run | `run-` + 20 hex characters (`-err-<ms>` appended when the sandbox could not be prepared) | |
| Check | `chk-` + 12 hex characters | |

The anchor is the heading's slug (lowercase, punctuation removed, spaces turned into `-`, duplicates numbered `-1`, `-2`), or an explicit `{#id}` written after the heading. The example `index` counts every fenced block in the file from 0, whatever its language, so `README.md:4` is the fifth fenced block of the README. Tools that accept either kind of id (`decisions_for`) treat an id containing `#` as a DocSection id.

### Edges

| Edge | From → to | Written by |
|---|---|---|
| `IN_REPO`, `DEFINED_IN` | File → Repo; Symbol, DocSection, CodeExample → File | [Indexing](indexing.md) |
| `CALLS {resolved, line, text}` | Symbol → Symbol | Indexing |
| `MENTIONS {resolved, span}` | DocSection → Symbol | Indexing; `late` ones by pull request ingestion |
| `USES {resolved, line, text}` | CodeExample → Symbol | Indexing; `late` ones by pull request ingestion |
| `IN_SECTION` | CodeExample → DocSection | Indexing |
| `LINKS_TO` | DocSection → DocSection | Indexing |
| `DEPENDS_ON {spec}` | Repo → Repo | Indexing |
| `CHANGED_IN {kind, before, after, renamed_to}` | Symbol → PullRequest | Pull request ingestion |
| `OF`, `AT` | Run → CodeExample; Run → PullRequest | `run_example` |
| `ABOUT`, `FOR`, `CITES`, `EVIDENCE` | Verdict → DocSection, PullRequest, Decision, Run | `propose_edit`, `record_verdict` |
| `GOVERNS`, `SUPERSEDES` | Decision → DocSection or Symbol; Decision → Decision | `write_decision` (people only) |
| `FOR`, `PRODUCED` | Check → PullRequest; Check → Verdict | The check loop |

## Pull request ingestion

The first time any tool or check looks at a pull request, it is ingested: its metadata is read from the GitHub API, the two commits are compared, and the result is written to the graph. Re-checking a pull request never re-diffs it; ingestion happens once per pull request.

- **Which repositories**: the pull request's repository must already be indexed in the graph. Otherwise the error is `<owner/repo> is not indexed in the "<graph>" graph. Run: staleproof index <owner/repo> (plus the repositories that document it).`
- **Which commits**: for a merged pull request, the merge commit's first parent (before) and the merge commit (after). For an open or closed-unmerged one, the merge base of base and head (before) and the head (after).
- **Which files**: only files the indexer classifies as Python library code are diffed. Markdown files the pull request itself edits are recorded as `docs_touched` and shown as "This PR already edits: …".
- **How**: with `git` in a local clone; on hosts without `git` (serverless), or with `STALEPROOF_INGEST=github`, through the GitHub API.

Each changed definition is attached to the `PullRequest` node with a `CHANGED_IN` edge that records the [change kind](#change-kinds) and the signatures before and after.

If the graph was indexed after the pull request, the symbols it removed no longer exist in the graph. Ingestion recreates them with `status: 'removed'` and links them to the docs that still name them: sections whose stored `idents` contain the name (or `Class.name`), and examples whose identifiers contain it, in the symbol's own repository or a repository with a direct `DEPENDS_ON` edge to it. Those edges are labelled `resolved: 'late'` (see [Resolution](#resolution)). Names shorter than 4 characters, names starting with `_` and generic names such as `get` or `run` are not late-linked.

### Change kinds

| Change | When | Severity |
|---|---|---|
| `removed` | The definition exists before the pull request and not after, and is not part of a rename | `breaking` |
| `renamed` | A removed definition pairs with an added one of the same kind, in the same class or module, with the same parameters (names and annotations) and return annotation | `breaking` |
| `export-removed` | A module stops importing a name from its own package that it used to import (and does not define it either). Recorded against the definition the import pointed at | `breaking` |
| `signature` | Same qualified name on both sides; the signature text or the decorators differ | `api` |
| `modified` | Same name, signature and decorators, and a changed line touches the definition's own lines (not a nested definition; blank and comment-only lines ignored; a docstring edit counts) | `behavior` |
| `added` | The definition exists only after the pull request | not traversed |

A moved or renamed file changes the module name, so each of its definitions shows up as `removed` plus `added`.

### Severity

Severity is a function of the change kind: `removed`, `renamed` and `export-removed` are `breaking`; `signature` is `api` (shown as "signature" in summaries and the PR comment); everything else is `behavior`. `added` changes are left out of every traversal. When several changes reach one section, the section takes the most severe.

In all three falkordb-py examples, every impacted section is `behavior`: the changes reaching docs modified function bodies, not signatures.

## Impact

Impact is the set of doc sections and code examples a pull request can make false. A doc is impacted when the graph has a path from a changed symbol, back through up to 3 callers in any repository, to a doc section that mentions one of those symbols in inline code, or to a code example that calls one. The `impact` tool runs one query for this (excerpt; the full text is in [Graph model and Cypher](GRAPH-MODEL.md#agent-tools)):

```cypher
MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
WHERE c.kind <> 'added'
MATCH p = (s)<-[:CALLS*0..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
WHERE (d:DocSection OR d:CodeExample) AND d.status = 'live'
RETURN d.id, length(p) AS hops, [n IN nodes(p) | coalesce(n.qualname, n.id)] AS evidence
```

Results are grouped by section: an example counts towards the section it sits in, and an example script (which has no section) is its own entry. Each section keeps its best path (higher severity, then fewer hops, then `exact` over other confidences), and sections are sorted by severity, then hops, then id. `impact` returns 40 sections per call; with more, the summary says where the next page starts (`offset`).

The three running examples:

- **falkordb-py#262** changed one function, `Is_Cluster`. It reaches one section, the falkordb-py README's "Asynchronous Example", whose example calls the async `FalkorDB` constructor, which calls `Is_Cluster`.
- **falkordb-py#267** reaches 3 sections, 2 of them in another repository: the docs site's `GRAPH.EXPLAIN` and `GRAPH.PROFILE` pages, through `ExecutionPlan._operation_tree ← ExecutionPlan.__init__ ← Graph.explain`.
- **falkordb-py#276** changed 4 symbols that reach 43 sections, 41 of them in other repositories.

None of this is found by searching for the changed names: for the three falkordb-py pull requests, a whole-word grep for the changed names finds 0 of the 47 sections the graph reaches ([FACTS](FACTS.md#without-the-graph-grep-for-the-changed-names)).

### Evidence path

The evidence path is the path behind an impacted section, written node by node: the changed symbol first, the doc last, symbols by qualified name and docs by id. For #262:

```text
falkordb.asyncio.cluster.Is_Cluster ← falkordb.asyncio.falkordb.FalkorDB.__init__ ← FalkorDB/falkordb-py:README.md:4
```

Read it as "`Is_Cluster` is called by `FalkorDB.__init__`, which is used by example 4 of the README". The path is the reason a section is listed, not proof that it is wrong. It is also a precondition: `propose_edit` refuses to edit a section unless the graph has a path from the pull request's changes to it, and the path is stored on the verdict.

### Hops

Hops are the number of edges on the evidence path, the final `MENTIONS` or `USES` edge included. The #262 path has 2 hops (one `CALLS`, one `USES`); #267's path to the `GRAPH.EXPLAIN` example has 3. The walk allows 0 to 3 `CALLS` edges by default (`max_hops` on `impact`, `--max-hops` on `check --no-agent`), so a default impact reports 1 to 4 hops. "Within 3 call hops", in [clearance](#clearance) and elsewhere, counts `CALLS` edges only.

### Resolution

Every `CALLS`, `MENTIONS` and `USES` edge records how it was resolved, in its `resolved` property:

- `exact`: resolved through imports, package re-exports, attribute and return types, or base classes.
- `by-name`: a name match used when exact resolution fails, allowed only inside repositories the module imports, never for generic names such as `get` or `run`, and only when 1 to 4 definitions match. See [Indexing](indexing.md).
- `late`: created during pull request ingestion for a symbol the pull request removed, by matching its name against the identifiers stored on docs.

On FalkorDB's repositories, 1,655 of 1,708 call edges and 633 of 716 example edges resolve exactly ([FACTS](FACTS.md#resolution-quality)).

### Confidence

An impacted section's `confidence` summarises the edges on its evidence path: `late` if any edge is `late`, `exact` if every edge is `exact`, otherwise `by-name`. The PR comment shows it next to the hops, for example `2 (exact)`. Graph mode only runs examples from `exact` sections.

## Clearance

Clearance is the list of changed symbols (other than `added`) that reach no doc section or example within 3 call hops in any repository. The graph proves the absence: there is no path. Reviewers can skip those changes as far as the docs are concerned.

Each cleared symbol comes with a check you can run yourself: a `git grep -nw <name> -- '*.md' '*.mdx'` command, and `textMatches`, the number of matching lines across the local clones of every repository that has doc sections. A cleared symbol with text matches shares a name with text in the docs, but no path in the graph resolves to it; that is the case worth a second look. On hosts without local clones (serverless), `textMatches` is 0.

The query counts bound paths (`OPTIONAL MATCH p = … WITH count(p) AS reach WHERE reach = 0`) rather than using a negated pattern: on FalkorDB 4.18 the anonymous variable-length form could miss callers reachable along two routes of different lengths. [test/traversal.test.ts](../test/traversal.test.ts) reproduces that shape.

## Ranking

Ranking orders impacted sections by how central their page is in the docs: `algo.pageRank` over the `LINKS_TO` edges between doc sections, summed per page (`repo:path`), so the most linked-to page comes first. If the graph algorithm fails, ranking falls back to counting the inbound links to each page (`method: 'in-degree'`). Links resolve only within one repository. The `rank_sections` tool runs it; graph mode, the terminal output and the PR comment use it to order sections.

## Runs

A run is one execution of a docs code example in the sandbox: a fresh virtualenv with the organisation's repositories installed from source at exact commits, a scratch FalkorDB answering on `localhost:6379`, and no other network. With a pull request, `run_example` runs the example twice: at the commit before the pull request (`before`) and at the pull request (`after`). Each execution is a `Run` node. Identical runs (same program, same commits) are answered from the graph instead of re-run. The details are in [Example runner](example-runner.md).

### Run statuses

| Status | Meaning |
|---|---|
| `pass` | The program exited with code 0 |
| `fail` | It exited with an error; `error` holds the last traceback line |
| `timeout` | No exit within the time limit (30 s by default) |
| `skipped` | Not run because it cannot be run honestly: needs an LLM key, a local file, placeholders, user input, an external service, or is not Python; a fragment that uses a name the page never defines; or nothing to install ([all the rules](example-runner.md#skip-rules)) |
| `error` | The sandbox could not be prepared (clone, install or scratch server failed), for example a dependency conflict |

### Run outcomes

The two runs of an example combine into one outcome (`fail` and `timeout` both count as failed):

| Outcome | Before | After | What it means |
|---|---|---|---|
| `breaks` | passes | fails | The pull request broke the example: the strongest evidence that the docs are now wrong |
| `fixes` | fails | passes | The pull request fixed an example that was broken |
| `passes` | passes | passes | No observable break |
| `already-broken` | fails | fails with the same error | Broken before this pull request; still worth fixing |
| `changed-failure` | fails | fails with a different error | Broken both times, differently |
| `fails` | | | A single run (no pull request) failed |
| `skipped` | | | Either run was skipped |
| `error` | | | Either run could not be prepared |

From FalkorDB's repositories ([FACTS](FACTS.md#example-runs-sandbox)):

- **#262**: the README's async example fails before the pull request with `TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry'` and passes after it: `fixes`. The pull request fixed a broken README example.
- **#267**: the docs site's `GRAPH.EXPLAIN` example fails before and after with `Invalid graph operation on empty key` (it explains a query on a graph the page never creates): `already-broken`.
- **#276**: 21 examples were tried at both commits: 10 pass both times, 6 fail both times (already broken), 3 cannot be installed together at those commits (a dependency conflict, recorded as `error`), and 2 were skipped (placeholders; not Python).

## Verdicts

A verdict is the conclusion about one doc section for one pull request. It is a `Verdict` node linked to the section (`ABOUT`), the pull request (`FOR`), any decisions it cites (`CITES`) and any runs that support it (`EVIDENCE`).

| Verdict | Written by | Means |
|---|---|---|
| `stale` | `propose_edit` | The section is wrong (the pull request falsified it, or one of its examples fails both before and after); the verdict carries the replacement Markdown (`new_text`) and the text it replaces (`old_text`) |
| `ok` | `record_verdict` | The change does not falsify the section |
| `governed` | `record_verdict` | A maintainer decision says it stays as it is; must cite the decision |
| `skipped` | `record_verdict` | It could not be judged; the reason says why |

Every verdict starts with status `proposed`. A maintainer can set it to `accepted` or `rejected` (`staleproof verdict accept|reject <id>`, or the HTTP API). Rejected edits are left out of the docs patch, and later checks see the review when they read the section's history. The evidence path is stored on the verdict; `confidence` is `path`, or `none` when `record_verdict` closed a section with no path. Only doc sections get verdicts, never individual examples. See [Decisions and memory](memory.md).

## Decisions

A decision is a maintainer's ruling, in one sentence, attached to the doc sections or symbols it governs: for example "The async client keeps positional kwargs until 2.0", governing `FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__`. Decisions come only from people (the `decide` command, MCP `write_decision`, or `POST /api/decisions`); the agent cannot write them.

A decision on a symbol also covers the docs of whatever calls it within 2 calls, and a decision replaced with `--supersedes` resolves to its newest active successor. When `decisions_for` finds one for a section, the agent can close the section with a `governed` verdict that cites it instead of flagging it again. See [Decisions and memory](memory.md).

## Memory

Every check writes what it learned back to the graph: the pull request and its changes, every example run, every verdict, and the check itself with its full trace. Nothing is deleted on re-index: definitions and sections that disappear are marked `gone`, so verdicts and decisions keep pointing at them. The next check reads this memory in three ways:

- identical example runs are answered from the graph instead of re-run;
- `decisions_for` returns the decisions governing a section and its last 5 verdicts, with whether maintainers accepted them;
- the agent's first message says what changed since the last check: pull requests ingested, verdicts (how many stale), new decisions, example runs (how many failed).

See [Decisions and memory](memory.md).

## Checks

A check is one run of the check loop on one pull request. It is a `Check` node linked to the pull request (`FOR`) and to the verdicts it produced (`PRODUCED`). It stores the model name (or `graph-only (no model)`), status, summary, the number of model turns and tool calls, the tool order, the impacted sections still open, token counts, and the full trace as JSON: every tool call with its input, its result and the Cypher it ran with server-side timings.

| Status | Meaning |
|---|---|
| `done` | Finished; in agent mode, every impacted section (on every page of `impact`) has a verdict or an edit |
| `incomplete` | Stopped with sections still open (step limit, time budget, or the model finished early after two reminders); the open ones are listed |
| `refused` | The model declined to continue |
| `error` | The check failed; the summary gives the error |

A check that is still running has status `running`. See [The agent](agent.md).

## Agent mode and graph mode

Both modes use the same tools over the same graph and are stored the same way. They differ in who chooses what to look at.

| | Agent mode | Graph mode |
|---|---|---|
| Who picks the tools | A model, turn by turn, from what the tools return | Nobody: a fixed order |
| Tool order | Varies per pull request (#262: impact → read_section → decisions_for → run_example → record_verdict) | impact → clearance → rank_sections → run_example, for up to 3 examples |
| Needs | Model API credentials (Claude, or an Anthropic-compatible provider) | Only FalkorDB |
| Impacted sections covered | All of them: after any `impact` call the loop collects every page itself, and the model pages through them | A sample: it ranks the first page (40 sections) |
| Example runs | Whichever the model chooses | A sample: at most 3 (`--runs`) examples from `exact` sections on the first page |
| Reads decisions and earlier verdicts | Yes, through `decisions_for` | No |
| Writes verdicts and edits | Yes; every impacted section needs one before the check is `done` | No |
| "Since the last check" summary | In the first message to the model | Not computed |
| Statuses | `done`, `incomplete`, `refused`, `error` | `done`, `error` |
| Model recorded on the Check | The model name, for example `deepseek-v4-pro` | `graph-only (no model)` |
| Start it | `staleproof check <pr-url>`; `POST /api/check` with `mode: 'agent'` | `staleproof check <pr-url> --no-agent`; `POST /api/check` with `mode: 'graph'` (the server's default without credentials) |

Agent mode fails loudly without credentials; it never falls back to graph mode silently. One more variant: `check --no-agent --format markdown`, which the GitHub Action runs without a model key, renders the PR comment from impact, clearance, ranking and any verdicts already recorded. It stores no Check node and runs no examples. See [The agent](agent.md) for both modes in detail.

## The docs patch

The docs patch turns the proposed edits for a pull request into a unified diff and a pull request description. It takes the latest verdict per section across all checks of that pull request and applies the `stale` ones that have replacement text and were not rejected. Each file is read at its indexed commit: from the local clone when there is one (`git show <sha>:<path>`), otherwise from `raw.githubusercontent.com` (serverless hosts). An edit whose section text no longer matches what was indexed, or whose file is missing at that commit, is reported as a conflict instead of applied.

The description lists, per edited section, the reason, the evidence path, the before/after runs and the decisions cited, then the sections checked and left unchanged. Get it with `staleproof patch <pr-url>` (`--out` writes the diff and the description to files), MCP `docs_patch`, or `GET /api/patch`. `patch --open-pr` opens it as a pull request in your fork of each docs repository, and in the upstream repository only with `--upstream`. It needs `GITHUB_TOKEN`.

The checks of falkordb-py #262, #267 and #276 ended with `ok` verdicts only: these pull requests are fixes, and no example they reach broke because of them. So no edit has been proposed on that graph, and their patches are empty. Proposing an edit and building the patch from it are exercised on the test suite's fixture organisation.

## Known limits

- **Index together.** Cross-repository edges exist only between repositories indexed in the same `index` command.
- **Late links do not survive a re-index.** A pull request is ingested once, so the `late` links made for symbols it removed are lost when the docs repository holding them is re-indexed.
- **`export-removed` can be a false positive.** Any module that stops importing a name from its own package counts, including the removal of an unused import, and it is classed as `breaking`.
- **Moved files are not renames.** Moving or renaming a file reports each of its definitions as `removed` plus `added`.
- **Only Python library files are diffed.** Changes to example scripts, tests and docs are not symbol changes.
- **Long sections always conflict in the patch.** A section longer than 8,000 characters is stored truncated, so its text never matches the file and the edit is reported as a conflict.

## Related

- [Indexing](indexing.md): how code and docs become the graph
- [Example runner](example-runner.md): how runs work and how to read them
- [Decisions and memory](memory.md): decisions, verdict review and what checks write back
- [The agent](agent.md): the loop, its stop condition and graph mode
- [Tools reference](tools.md): every tool's parameters, results and errors
