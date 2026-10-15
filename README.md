# Lockstep

**An agent that keeps a devtools company's docs true to its code.** Paste a pull request: Lockstep walks a
[FalkorDB](https://www.falkordb.com) graph of code, docs and past decisions across every repository of the
organisation, proves which examples now break by running them before and after the change, and proposes the
docs fix with the path in the graph behind each paragraph.

```bash
npx -y lockstep-docs check https://github.com/FalkorDB/falkordb-py/pull/262
```

| Status | What |
|---|---|
| **Built and run** (on the author's machine, against FalkorDB's real repositories) | Indexer, cross-repo impact, clearance, PageRank ranking, sandboxed example runs before/after a PR, decisions and verdict memory, docs patch, CLI, MCP server, web demo, graph-mode checks. Covered by `npm run verify`. |
| **Built, not run with a real model** | Agent mode (Claude chooses the tools): the loop is tested with a scripted model and the request shape against a local fake API; no paid model call has been made yet. The GitHub Action and the Docker image are written but not exercised (no Docker here). |
| **Multi-tenant** | One graph per organisation: a second graph (`encode`, from [encode/httpx](https://github.com/encode/httpx)) sits next to `falkordb` on the same server — [docs/FACTS-encode.md](docs/FACTS-encode.md). |
| **Live** | [lockstep-rho.vercel.app](https://lockstep-rho.vercel.app) on Vercel, deployed from `main`, querying the org graph on FalkorDB Cloud (4.22). Paste any public pull request from the three repositories for a graph-mode check; examples are not executed there (no sandbox), so their before/after results come from runs recorded on the graph. If the database is unreachable the page falls back to a labelled snapshot. The `lockstep-docs` npm package is not published yet. |
| **Designed** | Issue/discussion → symbol links ("asked about but undocumented"); hosted multi-org service. See [VISION.md](VISION.md). |

Built for [Graph Hacks](https://www.wemakedevs.org/hackathons/falkordb) (WeMakeDevs × FalkorDB), tracks 01 and 03.
Written with an AI coding assistant (Claude Code); see [AI assistance](#ai-assistance).

---

## What it found on FalkorDB's own repositories

Every number here comes from [docs/FACTS.md](docs/FACTS.md), generated from the graph.

- **[falkordb-py#262](https://github.com/FalkorDB/falkordb-py/pull/262)** changed one function, `Is_Cluster`. The graph
  path `Is_Cluster ← FalkorDB.__init__ ← README "Asynchronous Example"` led Lockstep to run that example against
  falkordb-py installed from source at both commits: **it fails before the PR** with
  `TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry'` **and passes after it**.
  The README's async example was broken (with today's dependencies) until this PR.
- **[falkordb-py#267](https://github.com/FalkorDB/falkordb-py/pull/267)** fixed the execution-plan parser. Lockstep
  followed `ExecutionPlan._operation_tree ← ExecutionPlan.__init__ ← Graph.explain` into a different repository, the
  docs site's `GRAPH.EXPLAIN` and `GRAPH.PROFILE` pages, and ran both examples. The `GRAPH.EXPLAIN` example **fails as
  written on a fresh server, before and after the PR** (`Invalid graph operation on empty key`: it explains a query on
  a graph the page never creates). The PR didn't break it; it was already broken.
- **[falkordb-py#276](https://github.com/FalkorDB/falkordb-py/pull/276)** changed 4 asyncio symbols that reach
  **43 doc sections, 41 of them in other repositories**, through paths like
  `AsyncGraph.query ← FalkorDBConnection.query (GraphRAG-SDK) ← GraphStore.delete_document_chunks ← GraphRAG.delete_document ← GraphRAG-SDK README`.
  Three of the reachable examples were run before and after: all pass.

## Why the graph is the product

The question Lockstep answers on every pull request is *which paragraphs, in which repositories, can this change
make false?* That is a reachability question (excerpt of the `impact` tool's query; the full text is [below](#every-cypher-query-the-product-depends-on)):

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

Take FalkorDB out and Lockstep is a grep over one repository.

## How it works

```
GitHub (public repos) ──index──▶ FalkorDB: one graph per organisation ◀──tools──▶ Agent (Claude, tool use)
                                    ▲                                              │ trace (SSE)
     Sandbox runner ── Run nodes ───┘                                              ▼
     (uv venv per repo@sha,                                  CLI · MCP server · web demo · GitHub Action
      scratch FalkorDB, no network)
```

1. **Index.** `lockstep-docs index` clones each repository, parses Python with tree-sitter (WASM) into symbols and call
   sites, and resolves calls across the whole organisation through imports, package re-exports, attribute types,
   return annotations and base classes (`self._graph = self._driver.select_graph(...)` resolves `self._graph.query` to
   `AsyncGraph.query` in another repository). Markdown/MDX pages become doc sections; fenced Python examples are
   resolved like code (cumulatively per page, so a later fragment that uses `g` resolves through the earlier block
   that defined it). 1,655 of 1,708 call edges and 633 of 716 example edges resolve exactly; the rest are labelled
   `by-name` and shown as such.
2. **Ingest the PR.** The diff between the PR's commits becomes symbol-level changes — removed, renamed, signature,
   modified (own lines only), added, export-removed — attached with `CHANGED_IN`. Symbols the PR removed are recreated
   and linked to docs that still name them.
3. **Check.** The agent chooses among eight tools. Each one runs Cypher on FalkorDB and returns the queries it ran.
   The loop ends only when every impacted section has a verdict or an edit (it reminds the model, then reports
   *incomplete* honestly), and the full trace is stored on a `Check` node.
4. **Prove.** `run_example` installs the repositories from source at the commit before the PR and at the PR, runs the
   docs example in a sandbox whose only reachable server is a scratch FalkorDB answering `localhost:6379`, and records
   both runs. *Passes before, fails after* is proof; *fails both* means it was already broken; examples that need an
   LLM key, local files or placeholders are recorded as skipped with the reason.
5. **Fix.** `propose_edit` is refused unless the graph has a path from the PR's changes to the section. The docs patch
   is a `git apply`-able diff with the evidence path, runs and cited decisions per section; `--open-pr` opens it in
   your fork, never upstream unless you ask.

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
and the web demo.

## Use it

```bash
# Local FalkorDB without Docker (falkordblite binaries; uv fetches Python 3.12)
npx -y lockstep-docs db start

# Index an organisation's repositories into one graph
npx -y lockstep-docs index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs

# Check a pull request: the agent with ANTHROPIC_API_KEY set, or graph mode without a model
npx -y lockstep-docs check https://github.com/FalkorDB/falkordb-py/pull/267
npx -y lockstep-docs check https://github.com/FalkorDB/falkordb-py/pull/267 --no-agent

# Run one docs example before and after a PR
npx -y lockstep-docs run "FalkorDB/docs:commands/graph.explain.mdx:0" --pr https://github.com/FalkorDB/falkordb-py/pull/267

# Record a maintainer decision; the next check cites it instead of re-flagging
npx -y lockstep-docs decide "The async client keeps positional kwargs until 2.0" --governs "FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__"

# The docs fix as a patch (and, with GITHUB_TOKEN, a PR in your fork)
npx -y lockstep-docs patch https://github.com/FalkorDB/falkordb-py/pull/267 [--open-pr]

# Web demo and API
npx -y lockstep-docs serve
```

**Claude Code (MCP):**

```bash
claude mcp add lockstep -e FALKORDB_URL=falkor://localhost:6379 -- npx -y lockstep-docs mcp
```

Every MCP tool description includes its Cypher, and every result lists the queries it ran with their timings.

**GitHub Action:** [`examples/lockstep.yml`](examples/lockstep.yml) comments on each pull request with the docs it can
falsify, across every repository in your graph. Configuration and deployment: [docs/DEPLOY.md](docs/DEPLOY.md).

## Graph model

Nodes: `Repo`, `File`, `Symbol{repo, qualname, kind, signature, status}`, `DocSection{repo, path, heading_path, anchor, body, idents}`,
`CodeExample{repo, path, index, lang, code}`, `PullRequest{url, before_sha, after_sha}`, `Decision{text, source_url, author, status}`,
`Verdict{verdict, reason, new_text, evidence, status}`, `Run{status, error, traceback, installed, side}`, `Check{model, status, trace}`.

Edges: `(Symbol)-[:DEFINED_IN]->(File)-[:IN_REPO]->(Repo)`, `(Symbol)-[:CALLS {resolved}]->(Symbol)`,
`(Repo)-[:DEPENDS_ON]->(Repo)`, `(DocSection)-[:MENTIONS]->(Symbol)`, `(CodeExample)-[:USES]->(Symbol)`,
`(CodeExample)-[:IN_SECTION]->(DocSection)`, `(DocSection)-[:LINKS_TO]->(DocSection)`,
`(Symbol)-[:CHANGED_IN {kind}]->(PullRequest)`, `(Decision)-[:GOVERNS]->(DocSection|Symbol)`,
`(Decision)-[:SUPERSEDES]->(Decision)`, `(Verdict)-[:ABOUT]->(DocSection)`, `(Verdict)-[:FOR]->(PullRequest)`,
`(Verdict)-[:CITES]->(Decision)`, `(Verdict)-[:EVIDENCE]->(Run)`, `(Run)-[:OF]->(CodeExample)`,
`(Run)-[:AT]->(PullRequest)`, `(Check)-[:FOR]->(PullRequest)`, `(Check)-[:PRODUCED]->(Verdict)`.

Symbols and sections that disappear on a re-index are marked `gone`, never deleted: decisions and verdicts keep
pointing at them.

### Every Cypher query the product depends on

<!-- generated:cypher:start -->
<!-- Generated by `npm run docs` from src/graph/queries.ts. Do not edit by hand. -->

| Tool | Cypher it runs |
|---|---|
| `impact` | `impact`, `prChanges`, `upsertPullRequest`, `upsertChangedIn`, `upsertMissingSymbols`, `lateLinkSections`, `lateLinkExamples` |
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
RETURN e.id AS id, e.lang AS lang, e.code AS code, e.repo AS repo, e.path AS path, e.url AS url, usedRepos,
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

**`priorVerdicts`** — What Lockstep concluded about this section on earlier pull requests, and what maintainers did with it.

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

Indexing and reporting queries (34 more) are in [docs/GRAPH-MODEL.md](docs/GRAPH-MODEL.md).
<!-- generated:cypher:end -->

## Limits, stated plainly

- **Python code only.** Docs can be any Markdown/MDX; code repositories are parsed as Python. JavaScript examples in
  the docs are indexed but not linked or run.
- **Call resolution is static.** Dynamic dispatch the types don't reveal falls back to by-name edges inside repositories
  the module imports (labelled `by-name` everywhere they appear), or to no edge.
- **The sandbox is a guard, not a security boundary.** It refuses network connections and DNS at the Python socket
  level, runs with no inherited secrets and a temp HOME, and kills on timeout. Run it inside a container for untrusted
  code.
- **Runs use today's third-party dependencies.** Repositories are installed from source at the exact commits; their
  dependencies resolve at run time.
- **Public repositories only.** Nothing private, login-protected or personal is indexed.

## Develop

```bash
npm install
npm run verify      # typecheck (engine + web) and the test suite; starts a local FalkorDB on :6380 without Docker
npm run build       # dist/ and web/dist/
npm run docs        # regenerate the Cypher section above and docs/GRAPH-MODEL.md from src/graph/queries.ts
```

Architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## AI assistance

Lockstep was written with Claude Code (Anthropic) as the coding assistant: implementation, tests and docs, under the
author's direction and review. The graph model, the queries and the design decisions are documented in this
repository so that every one of them can be explained and checked.

## License

MIT
