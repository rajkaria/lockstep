# Use cases

Six ways teams use `lockstep-docs`, each with the situation it fits, what it does there, the setup, what you get and its limits. Read the one closest to your team; every setup links to the reference page with the full options. The running examples are FalkorDB's client library (`FalkorDB/falkordb-py`), the SDK built on it (`FalkorDB/GraphRAG-SDK`) and its docs site (`FalkorDB/docs`).

## SDK and client-library teams with a separate docs site

**The situation.** Your client library, the SDK built on it and the docs site live in different repositories. A change in the client can make a docs page false without naming anything the page mentions: the page calls an SDK method, the SDK method calls the client, and the client function changed. Reviewers of the client pull request never see that page.

**What it does.** One graph spans all your repositories. Calls are resolved across them through imports, types and re-exports, and docs are linked to the code their prose mentions and their examples call. For a pull request in the client, [impact](tools.md#impact) follows the call edges into the SDK and on to the docs site, and gives the evidence path for every section it reaches. When it runs an example, it installs every repository the example needs from source at the right commits, using the dependencies the repositories declare on each other.

**Setup.** Index the repositories together, then check pull requests from any of them:

```bash
npx -y lockstep-docs index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
npx -y lockstep-docs check https://github.com/FalkorDB/falkordb-py/pull/276 --no-agent
```

To get a comment on every pull request in the client repository, add the [GitHub Action](github-action.md).

**What you get.** On [falkordb-py#276](https://github.com/FalkorDB/falkordb-py/pull/276), 4 changed symbols reach 43 doc sections, 41 of them in the other two repositories, through paths such as:

```text
AsyncGraph.query ← FalkorDBConnection.query (GraphRAG-SDK) ← GraphStore.delete_document_chunks ← GraphRAG.delete_document ← GraphRAG-SDK README
```

A whole-word grep for the changed names finds none of those 43 sections and matches 8 others. Of the 21 examples tried before and after #276, 10 pass both times, 6 fail both times (already broken, not by this pull request), 3 cannot be installed together at those commits, and 2 are skipped (placeholders to fill in; not Python). The 3 that cannot be installed show the reason: `dependency conflict: graphrag-sdk==1.4.0 requires falkordb[hiredis]>=1.8.0,<2`, because the SDK pins the client below the version under test. All figures are from [Facts from the graph](FACTS.md).

**Limits.**

- Code repositories are parsed as Python only.
- Calls and doc links cross repositories only between repositories indexed in the same `index` command. Indexing or re-indexing one repository alone drops its cross-repository edges.
- Example runs install today's third-party dependencies, and version skew between repositories (an SDK pinning an older client) is recorded as an install error, not a result.
- Edges resolved by name rather than through types are labelled `by-name`; a path made of them is weaker evidence than an `exact` one.

## DevRel and docs teams after a release

**The situation.** A release merged dozens of pull requests across your repositories. You need to know which pages are now wrong, fix the most-read ones first, and send the fixes as reviewable pull requests.

**What it does.** Lockstep checks each merged pull request. In agent mode a model judges every impacted section and proposes replacement text for the ones that are wrong; each proposal is refused unless the graph has a path from the change to the section. [rank_sections](tools.md#rank_sections) orders sections by the PageRank of their page in your docs' own link graph, so the most central page comes first. `patch` turns a pull request's proposed edits into one diff across every docs repository it touches, with the evidence path, the example runs and any cited decisions for each edit, and `--open-pr` opens it as a pull request in your fork.

**Setup.** List the release's merged pull requests (here with the GitHub CLI), check each one with the agent, then build and open the patches:

```bash
prs=$(gh pr list --repo FalkorDB/falkordb-py --state merged --search "merged:>=2026-10-01" --json url --jq '.[].url')
for pr in $prs; do npx -y lockstep-docs check "$pr"; done
for pr in $prs; do npx -y lockstep-docs patch "$pr" --out "docs-$(basename "$pr").diff"; done
```

Review the diffs, then open the ones you want (needs `GITHUB_TOKEN`):

```bash
npx -y lockstep-docs patch https://github.com/FalkorDB/falkordb-py/pull/<n> --open-pr
```

`--open-pr` forks each docs repository into your account, creates a branch named after the code pull request (for example `lockstep/FalkorDB-falkordb-py-276`) at the commit the graph indexed, commits the edited files and opens the pull request inside your fork. Add `--upstream` to open it against the original repository instead.

For ranking, graph mode prints a pull request's sections in PageRank order, and the GitHub Action comment uses the same order. To rank a whole release at once, pass the section ids from several checks to `rank_sections` through an [MCP client](mcp.md) or the [library](library.md).

**What you get.** Per pull request: a `git apply`-able diff, a pull request description with the reason and evidence path for each edited section, the sections that were checked and left unchanged with their verdicts, and the sections that could not be applied.

**Limits.**

- There is no release-level command: you check and patch one pull request at a time, and each gives its own patch and its own docs pull request per docs repository.
- Only agent mode proposes edits. Graph mode writes no verdicts, so its patch is empty.
- No edit has been proposed on FalkorDB's repositories yet: the pull requests checked there are fixes, and every verdict on #262, #267 and #276 is `ok`. Edits and the patch are exercised by the test suite on a fixture organisation.
- An edit is not applied when its section's text changed since the docs repository was indexed, or when the file is gone. Sections longer than 8,000 characters always conflict, because the graph stores only their first 8,000 characters.
- `--open-pr` always creates or reuses a fork, even with `--upstream`.
- The ranking in graph-mode output and in the comment covers the first impact page (40 sections).

## Open-source maintainers reviewing pull requests

**The situation.** Contributors send pull requests that change behaviour. You want to know, during review, which docs pages a change can falsify, without paying for a model on every pull request.

**What it does.** The [GitHub Action](github-action.md) runs on every pull request and posts one comment, updated in place on each run: the impacted sections with the change type, repository, evidence path and hops; the changed symbols no doc reaches, each with a `git grep` command to check the claim; and the verdicts already recorded for the pull request. Without a model key it renders the comment from the graph alone (graph mode); with one, the agent judges each section first and the comment adds its verdicts and summary.

**Setup.** Index your repositories into a FalkorDB the GitHub runners can reach (FalkorDB Cloud works), store its URL as the secret `LOCKSTEP_FALKORDB_URL`, and add the workflow as `.github/workflows/lockstep.yml`:

```yaml
name: Lockstep
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/lockstep/action@main
        with:
          falkordb-url: ${{ secrets.LOCKSTEP_FALKORDB_URL }}
          org: falkordb
```

**What you get.** A comment that starts with the hidden marker `<!-- lockstep-docs -->`, lists the docs the pull request can falsify with the path for each, and ends with the graph name and the commits compared. [GitHub Action](github-action.md#the-comment) shows the full format.

**Limits.**

- The Action is written and its commands are tested, but it has not yet run on a live repository.
- Without a key, the Action runs `check --no-agent --format markdown`, which renders the comment only: it runs no examples and stores no check.
- A pull request is diffed once, the first time it is checked. Later pushes to the same pull request reuse that first diff, so the comment does not reflect new commits.
- Some rows overstate the change: moving a file reports its definitions as removed, and a module that stops importing a name from its own package reports a removed export, both labelled breaking.
- GitHub gives workflows triggered by pull requests from forks no access to repository secrets, so those runs cannot reach the graph.
- The pull request's repository must already be indexed in the graph. Re-index on a schedule with every repository together; the Action's `reindex` input re-indexes one repository alone and drops its cross-repository edges.

## AI coding agents over MCP

**The situation.** You change code with an AI coding agent such as Claude Code, and want the same session to find and fix the docs the change affects before a human reviews it.

**What it does.** `lockstep-docs mcp` gives the agent the ten tools over stdio: it can ask what a pull request reaches, read the sections, run the examples before and after, check maintainer decisions, record verdicts or propose edits, and get the docs patch as a diff to apply locally. Every result includes the Cypher queries it ran.

**Setup.**

```bash
claude mcp add lockstep -e FALKORDB_URL=falkor://localhost:6379 -e LOCKSTEP_ORG=falkordb -- npx -y lockstep-docs mcp
```

Prompts to try, after pushing your branch and opening the pull request:

- "What docs can https://github.com/FalkorDB/falkordb-py/pull/267 falsify? Show the evidence path for each section."
- "Run the examples in those sections before and after that pull request and tell me which ones it breaks."
- "Which of those sections is most central in the docs?"
- "Check the maintainer decisions for each section, then record a verdict for the ones that still hold and propose an edit for the ones that don't."
- "Give me the docs patch for that pull request and apply it to my checkout of FalkorDB/docs."

[MCP server](mcp.md) walks through a full session.

**What you get.** Answers grounded in the graph, with the evidence path and Cypher behind each, verdicts and proposed edits stored on the graph for the next check, and a diff you can apply.

**Limits.**

- The tools take a GitHub pull request URL. Uncommitted or unpushed changes cannot be checked; the pull request's repository must be public and indexed.
- `propose_edit` and `record_verdict` need `pr_url` over MCP; there is no pull request "under check" to default to.
- One MCP server serves one organisation's graph. Register a second server with another `LOCKSTEP_ORG` for another graph.
- `run_example` installs repositories and runs docs code on the machine running the MCP server. See the security notes in [MCP server](mcp.md).

## Platform teams with many repositories or organisations

**The situation.** You run docs tooling for several product lines or several organisations, and want one service rather than one setup per team.

**What it does.** Each organisation gets its own graph on the same FalkorDB server; the graph name is the organisation slug. Every command, the MCP server and the HTTP server work on the graph named by `--org` or `LOCKSTEP_ORG` (default `falkordb`). A second graph built from [encode/httpx](https://github.com/encode/httpx) sits next to `falkordb` on the same server: one repository, 544 symbols, 182 doc sections and 194 code examples ([its facts](FACTS-encode.md)).

**Setup.**

```bash
npx -y lockstep-docs --org encode index encode/httpx
npx -y lockstep-docs --org encode check https://github.com/encode/httpx/pull/<n> --no-agent
```

Serve the [HTTP API](http-api.md) once per organisation (the server answers for one graph), on separate ports:

```bash
LOCKSTEP_ORG=falkordb npx -y lockstep-docs serve --port 8080
LOCKSTEP_ORG=encode npx -y lockstep-docs serve --port 8081
```

Or embed the [library](library.md), which can open any graph on the server from one process:

```ts
import { GraphStore, loadConfig, runGraphCheck } from 'lockstep-docs';

const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
try {
  console.log(await store.listGraphs());
  const graph = store.org('encode');
  const result = await runGraphCheck({ graph, config }, 'https://github.com/encode/httpx/pull/<n>', { maxRuns: 0 });
  console.log(result.status, result.summary);
} finally {
  await store.close();
}
```

**What you get.** Isolated graphs per organisation on shared infrastructure, each with its own checks, verdicts, decisions and runs.

**Limits.**

- Graphs do not link to each other: a dependency between organisations is not followed.
- One `serve` process answers for one organisation and runs one check at a time; further checks queue.
- The HTTP API has no authentication. Its POST endpoints (checks, decisions, verdict reviews) are rate-limited per client, 30 an hour by default, and nothing more; put it behind your own access control.
- Public GitHub repositories only.

## Recording maintainer decisions so docs stop being re-flagged

**The situation.** Some docs are intentionally as they are: the async client keeps an old keyword argument until 2.0, or a page documents the previous release on purpose. Without memory, every check flags them again.

**What it does.** A decision is a sentence, its source and author, and the doc sections or symbols it governs. Before judging a section, the agent calls [decisions_for](tools.md#decisions_for), which finds decisions that govern the section directly or govern a symbol within 2 call hops of what the section mentions or its examples call. A decision on one function therefore covers the docs of the code that calls it. The agent then records a `governed` verdict that must cite the decision, instead of proposing an edit. A newer decision can supersede an older one; lookups resolve to the active successor. Maintainers can also accept or reject each verdict, and the agent sees earlier verdicts and their review status on the next check.

**Setup.** Find the ids to govern: section ids come from impact (`check --json`), and a symbol id is `<owner>/<repo>:<qualname>`, the qualified name shown in evidence paths. Then record the decision:

```bash
npx -y lockstep-docs decide "The async client keeps positional kwargs until 2.0" \
  --governs "FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__" \
  --source https://github.com/FalkorDB/falkordb-py/issues/<n> --author "<maintainer>"
```

It prints `Recorded decision dec-… governing 1 node(s).` To replace it later:

```bash
npx -y lockstep-docs decide "The async client drops positional kwargs in 2.0" \
  --governs "FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__" \
  --supersedes dec-<id>
```

Accept or reject a verdict the agent wrote (rejected edits are left out of the patch):

```bash
npx -y lockstep-docs verdict reject ver-<id> --by "<maintainer>"
```

**What you get.** Fewer repeat flags in agent mode, a `governed` verdict that names the decision, and a record of who decided what and where.

**Limits.**

- Decisions inform the agent's judgement only. Impact still lists a governed section, and graph mode and the graph-mode comment do not consult decisions.
- Citing the decision is the model's job, guided by its instructions; the graph enforces only that a `governed` verdict cites at least one decision id.
- `decide` refuses when none of the `--governs` ids exists in the graph. An unknown `--supersedes` id is ignored without an error.
- Decisions come from people: the agent is never given the tool that writes them.

## Related

- [Quickstart](getting-started.md)
- [CLI](cli.md)
- [GitHub Action](github-action.md)
- [MCP server](mcp.md)
- [Decisions and memory](memory.md)
