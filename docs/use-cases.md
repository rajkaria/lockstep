# Use cases

Nine ways teams use `staleproof`, each with the situation it fits, what it does there, the setup, what you get and its limits. Read the one closest to your team; every setup links to the reference page with the full options. The running examples are FalkorDB's client library (`FalkorDB/falkordb-py`), the SDK built on it (`FalkorDB/GraphRAG-SDK`) and its docs site (`FalkorDB/docs`).

## SDK and client-library teams with a separate docs site

**The situation.** Your client library, the SDK built on it and the docs site live in different repositories. A change in the client can make a docs page false without naming anything the page mentions: the page calls an SDK method, the SDK method calls the client, and the client function changed. Reviewers of the client pull request never see that page.

**What it does.** One graph spans all your repositories. Calls are resolved across them through imports, types and re-exports, and docs are linked to the code their prose mentions and their examples call. For a pull request in the client, [impact](tools.md#impact) follows the call edges into the SDK and on to the docs site, and gives the evidence path for every section it reaches. When it runs an example, it installs every repository the example needs from source at the right commits, using the dependencies the repositories declare on each other.

**Setup.** Index the repositories together, then check pull requests from any of them:

```bash
npx -y staleproof index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/276 --no-agent
```

To get a comment on every pull request in the client repository, add the [GitHub Action](github-action.md) with the other repositories in `also-index`, so the job indexes them together.

**What you get.** On [falkordb-py#276](https://github.com/FalkorDB/falkordb-py/pull/276), 4 changed symbols reach 43 doc sections, 41 of them in the other two repositories, through paths such as:

```text
AsyncGraph.query ← FalkorDBConnection.query (GraphRAG-SDK) ← GraphStore.delete_document_chunks ← GraphRAG.delete_document ← GraphRAG-SDK README
```

A whole-word grep for the changed names finds none of those 43 sections and matches 8 others. Of the 21 examples tried before and after #276, 10 pass both times, 6 fail both times (already broken, not by this pull request), 3 cannot be installed together at those commits, and 2 are skipped (placeholders to fill in; not Python). The 3 that cannot be installed show the reason: `dependency conflict: graphrag-sdk==1.4.0 requires falkordb[hiredis]>=1.8.0,<2`, because the SDK pins the client below the version under test. All figures are from [Facts from the graph](FACTS.md).

**Limits.**

- Code is read as Python, Go, or TypeScript and JavaScript in published npm packages; Python, JavaScript and TypeScript examples run, Go examples are checked only.
- Calls and doc links cross repositories only between repositories indexed in the same `index` command. Indexing or re-indexing one repository alone drops its cross-repository edges.
- Example runs install today's third-party dependencies, and version skew between repositories (an SDK pinning an older client) is recorded as an install error, not a result.
- Edges resolved by name rather than through types are labelled `by-name`; a path made of them is weaker evidence than an `exact` one.

## DevRel and docs teams after a release

**The situation.** A release merged dozens of pull requests across your repositories. You need to know which pages are now wrong, fix the most-read ones first, and send the fixes as reviewable pull requests.

**What it does.** Staleproof checks each merged pull request. In agent mode a model judges every impacted section and proposes replacement text for the ones that are wrong; each proposal is refused unless the graph has a path from the change to the section. [rank_sections](tools.md#rank_sections) orders sections by the PageRank of their page in your docs' own link graph, so the most central page comes first. `patch` turns a pull request's proposed edits into one diff across every docs repository it touches, with the evidence path, the example runs and any cited decisions for each edit, and `--open-pr` opens it as a pull request in your fork.

**Setup.** List the release's merged pull requests (here with the GitHub CLI), check each one with the agent, then build and open the patches:

```bash
prs=$(gh pr list --repo FalkorDB/falkordb-py --state merged --search "merged:>=2026-10-01" --json url --jq '.[].url')
for pr in $prs; do npx -y staleproof check "$pr"; done
for pr in $prs; do npx -y staleproof patch "$pr" --out "docs-$(basename "$pr").diff"; done
```

Review the diffs, then open the ones you want (needs `GITHUB_TOKEN`):

```bash
npx -y staleproof patch https://github.com/FalkorDB/falkordb-py/pull/<n> --open-pr
```

`--open-pr` forks each docs repository into your account, creates a branch named after the code pull request (for example `staleproof/FalkorDB-falkordb-py-276`) at the commit the graph indexed, commits the edited files and opens the pull request inside your fork. Add `--upstream` to open it against the original repository instead.

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

**What it does.** The [GitHub Action](github-action.md) runs on every pull request and posts one comment, updated in place on each run. It starts a FalkorDB in the job, indexes the repository, and runs up to 3 affected examples at the commit before the pull request and at the pull request. The comment leads with what broke: the examples run before and after, then the impacted sections with the change type, repository, evidence path and hops, the changed symbols no doc reaches (each with a `git grep` command to check the claim), and any verdicts. Without a model key it runs graph mode; with one, the agent judges each section and the comment adds its verdicts and summary.

**Setup.** Click **Add to owner/repo** on [staleproof.dev/#/install](https://staleproof.dev/#/install) and commit the file GitHub opens, or add the workflow as `.github/workflows/staleproof.yml` yourself. No secrets, no database:

```yaml
name: Staleproof
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/staleproof@v1
        with:
          also-index: FalkorDB/docs   # docs in another repository (optional)
          fail-on: breaks             # fail the check when an example passes before and fails after (optional)
```

**What you get.** A comment that starts with the hidden marker `<!-- staleproof -->`, titled with what broke (`this pull request breaks 1 docs example`, or how many sections it can make false), the examples table, the docs it can make false with the path for each, and the graph name and commits compared at the end. The same report goes to the job summary. [GitHub Action](github-action.md#the-comment) shows the full format.

**Limits.**

- The action has run end to end on a private test repository with the one-click workflow (no inputs).
- Graph mode samples: it runs at most 3 examples (the `runs` input), from exactly linked sections on the first impact page, and writes no verdicts.
- With the default FalkorDB nothing carries over between runs: no decisions, verdict history or recorded runs. Set `falkordb-url` to keep them; an open pull request is then diffed again whenever new commits are pushed.
- Some rows overstate the change: moving a file reports its definitions as removed, and a module that stops importing a name from its own package reports a removed export, both labelled breaking.
- Pull requests from forks get a read-only token and no secrets: the check runs in graph mode and its report goes to the job summary, but no comment is posted.
- Both modes install and run code from the pull request on the runner (the examples), with a guarded environment; see the [security notes](github-action.md#security-notes).

## A weekly docs audit

**The situation.** Docs drift between releases too, not only in the pull request that changed the code: an SDK renames a parameter, a docs site in another repository keeps the old call, and nobody runs the page again. You want a standing report of what is wrong now, and a number that says whether it is getting better.

**What it does.** The [docs audit](audit.md) checks every docs example against the code it calls, across repositories, without running it: unknown keywords, wrong argument counts, names that no longer exist. It adds the runs of up to 20 examples at the default branch and the share of the public API no doc covers, and scores it from 0 to 100. On a schedule the GitHub Action keeps one issue up to date with the report: opened when an example no longer fits or fails, updated on every run, closed once all is clear.

**Setup.** Add [examples/staleproof-audit.yml](../examples/staleproof-audit.yml) as `.github/workflows/staleproof-audit.yml` (or tick the weekly audit option on [staleproof.dev/#/install](https://staleproof.dev/#/install)):

```yaml
name: Staleproof docs audit
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:
permissions:
  contents: read
  issues: write
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/staleproof@v1
        with:
          also-index: FalkorDB/docs   # docs in another repository (optional)
```

To see a first report without CI, audit on [staleproof.dev/#/audit](https://staleproof.dev/#/audit) or run `npx -y staleproof audit <owner/repo>`. Put the badge the report prints in your README.

**What you get.** Lines like these, each linked to the line in the docs (all found on the current docs of real projects; [more](audit.md#what-it-finds-on-real-repositories)):

- the FalkorDB docs page `commands/graph.constraint-create.mdx` calls `client.create_constraint`, which `FalkorDB` does not have;
- GraphRAG-SDK's `docs/api-reference.mdx` documents `VectorStore(index_name=..., similarity_function=...)`, parameters the constructor no longer has;
- Flask's `docs/views.rst` calls `UserList.as_view()` without its required `name`.

Then the failing runs, the most used undocumented API, and the score with each deduction.

**Limits.**

- Static checks judge only calls resolved through imports and types; a clean audit is not proof that every example works. The runs cover the rest, for Python, JavaScript and TypeScript.
- Go examples get name and argument checks but are never run.
- Coverage counts a symbol as documented when any doc names or calls it, however briefly.
- The issue tracks examples that no longer fit or fail; low coverage lowers the score but opens no issue on its own.

## Developers, before they push

**The situation.** You are changing a function in a library whose docs, maybe in another repository, call it. You want to know which examples your change breaks before you push, not from a reviewer or a reader later.

**What it does.** `staleproof check` with no pull request URL diffs your checkout's uncommitted and unpushed changes against its merge base, walks the graph from the changed symbols to every doc that reaches them, and predicts which examples break: a removed or renamed name, an import that stops existing, a call the new signature rejects. Nothing runs and nothing is written to the graph. `staleproof docs-for <symbol>` answers the question before you start: which docs depend on this function.

**Setup.** Once, in the checkout (the first run indexes the repository; add `--with <owner/docs>` when the docs live elsewhere):

```bash
npx -y staleproof docs-for Graph.query --repo FalkorDB/falkordb-py
npx -y staleproof check
```

As a pre-push hook that stops the push when an example is predicted to break:

```bash
printf '#!/bin/sh\nnpx -y staleproof check --fail-on-predicted\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

**What you get.** The impacted sections with their evidence paths, then the examples predicted to break, each with its line and the reason, for example:

```text
Predicted to break (1): the call no longer fits the changed code
  ✗ docs/getting-started.mdx:0 line 18 g.query
    `Graph.query` requires `timeout`, which the example does not pass
```

(from the test suite's fixture organisation, after adding a required `timeout` to `Graph.query`), and the impacted lines that were already out of date. [CLI](cli.md#check-without-a-pull-request) has the full output.

**Limits.**

- It is static: it predicts breaks, it does not run examples. Open the pull request for the before/after runs.
- The docs' repository must be in the graph with the code; index them together (`--with`) the first time.
- Changes the static check cannot judge (a decorated function, a call with `**kwargs`) are listed as impact without a prediction.

## AI coding agents over MCP

**The situation.** You change code with an AI coding agent such as Claude Code, and want the same session to find and fix the docs the change affects before a human reviews it.

**What it does.** The MCP server gives the agent the Staleproof tools: `check_pull_request` returns the whole report for a pull request in one call, and the graph tools let it read the sections, run the examples before and after, check maintainer decisions, record verdicts or propose edits, and get the docs patch as a diff to apply locally. Every result includes the Cypher queries it ran.

**Setup.** With nothing installed, the hosted server (public repositories, no example runs):

```bash
claude mcp add --transport http staleproof https://staleproof.dev/api/mcp
```

Or the local server over stdio, which runs examples and reads private repositories with `GITHUB_TOKEN`; it starts a local FalkorDB and indexes each pull request's repository on first use:

```bash
claude mcp add staleproof -- npx -y staleproof mcp
```

Cursor, VS Code and Claude Desktop have one-click buttons or a URL to paste on [staleproof.dev/#/install](https://staleproof.dev/#/install).

Prompts to try, after pushing your branch and opening the pull request:

- "What docs can https://github.com/FalkorDB/falkordb-py/pull/267 falsify? Show the evidence path for each section."
- "Run the examples in those sections before and after that pull request and tell me which ones it breaks."
- "Which of those sections is most central in the docs?"
- "Check the maintainer decisions for each section, then record a verdict for the ones that still hold and propose an edit for the ones that don't."
- "Give me the docs patch for that pull request and apply it to my checkout of FalkorDB/docs."

[MCP server](mcp.md) walks through a full session.

**What you get.** Answers grounded in the graph, with the evidence path and Cypher behind each, verdicts and proposed edits stored on the graph for the next check, and a diff you can apply.

**Limits.**

- `check_pull_request` and the graph tools take a GitHub pull request URL; for edits not pushed yet, see [the next use case](#coding-agents-before-the-pull-request).
- The hosted server reads public repositories only and does not offer `run_example`.
- First-use indexing indexes the pull request's repository alone; index a docs site that lives elsewhere together with it first (`staleproof index <code repo> <docs repo>`).
- `propose_edit` and `record_verdict` need `pr_url` over MCP; there is no pull request "under check" to default to.
- One local MCP server serves the graph named by `STALEPROOF_ORG`, else the graph of the owner of the repository each call names. Register a second server with another `STALEPROOF_ORG` to pin another graph.
- `run_example` installs repositories and runs docs code on the machine running the local MCP server. See the security notes in [MCP server](mcp.md).

## Coding agents, before the pull request

**The situation.** An AI coding agent edits your library. Docs should change in the same commit as the code, but the agent does not know which pages call the function it is changing, and nothing tells it until a human reviews the pull request.

**What it does.** Two MCP tools work before there is a pull request. `docs_for_symbol` takes a function, class or method and returns every doc section and example that depends on it, with the evidence path, so the agent knows what to update. `check_changes` takes the files it edited (path and new content) and returns the docs they can make false and the examples predicted to break, compared with the commit the graph indexed; on a local server it can read the checkout's working tree instead. Neither writes anything.

**Setup.** Add the MCP server ([hosted or local](mcp.md)), then put these rules in the repository's `AGENTS.md` or `CLAUDE.md` so the agent calls the tools unasked (the install page has them to copy):

```markdown
## Docs stay true to code (Staleproof MCP)
- Before changing a public function, class or method, call docs_for_symbol with its name:
  update every doc section and example it lists in the same change.
- Before committing, call check_changes with the files you edited: fix every example
  it predicts to break (its call no longer fits the new signature).
```

**What you get.** For a change that adds a required `timeout` to `Graph.query` in the fixture organisation: `docs_for_symbol` lists the 3 doc sections that reach it, and `check_changes` names the one example line that breaks (`` `Graph.query` requires `timeout`, which the example does not pass ``) with a link to it. [MCP server](mcp.md#before-a-pull-request) shows the calls.

**Limits.**

- `check_changes` is static: it predicts breaks and runs nothing.
- The hosted server cannot read your disk: send `files` with `repo`. It reads public repositories only.
- The rules are instructions to the agent, not enforcement; pair them with the [pre-push hook](#developers-before-they-push) or the GitHub Action.

## Platform teams with many repositories or organisations

**The situation.** You run docs tooling for several product lines or several organisations, and want one service rather than one setup per team.

**What it does.** Each organisation gets its own graph on the same FalkorDB server; the graph name is the organisation slug. The CLI defaults to the graph of the repository's owner; `--org` or `STALEPROOF_ORG` names another, and the MCP server and the HTTP server use `STALEPROOF_ORG`, else `falkordb`. `serve --hosted` goes further and gives every repository owner a workspace graph of its own on demand, as staleproof.dev does. A second graph built from [encode/httpx](https://github.com/encode/httpx) sits next to `falkordb` on the same server: one repository, 544 symbols, 182 doc sections and 194 code examples ([its facts](FACTS-encode.md)).

**Setup.**

```bash
npx -y staleproof index encode/httpx
npx -y staleproof check https://github.com/encode/httpx/pull/<n> --no-agent
```

Both use the graph `encode`, the repository's owner.

Serve the [HTTP API](http-api.md) once per organisation (without `--hosted` the server answers for one graph), on separate ports:

```bash
STALEPROOF_ORG=falkordb npx -y staleproof serve --port 8080
STALEPROOF_ORG=encode npx -y staleproof serve --port 8081
```

Or embed the [library](library.md), which can open any graph on the server from one process:

```ts
import { GraphStore, loadConfig, runGraphCheck } from 'staleproof';

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
- One `serve` process answers for one organisation (or, with `--hosted`, for every owner from one FalkorDB server, within the [hosted limits](DEPLOY.md#limits)) and runs one check at a time; further checks queue.
- The HTTP API has no authentication. Its POST endpoints (checks, indexing, decisions, verdict reviews) are rate-limited per client, 30 an hour by default, and nothing more; put it behind your own access control.
- GitHub repositories only. Private ones need `GITHUB_TOKEN`; a hosted server indexes whatever its token can read, so give it a token limited to public repositories.

## Recording maintainer decisions so docs stop being re-flagged

**The situation.** Some docs are intentionally as they are: the async client keeps an old keyword argument until 2.0, or a page documents the previous release on purpose. Without memory, every check flags them again.

**What it does.** A decision is a sentence, its source and author, and the doc sections or symbols it governs. Before judging a section, the agent calls [decisions_for](tools.md#decisions_for), which finds decisions that govern the section directly or govern a symbol within 2 call hops of what the section mentions or its examples call. A decision on one function therefore covers the docs of the code that calls it. The agent then records a `governed` verdict that must cite the decision, instead of proposing an edit. A newer decision can supersede an older one; lookups resolve to the active successor. Maintainers can also accept or reject each verdict, and the agent sees earlier verdicts and their review status on the next check.

**Setup.** Find the ids to govern: section ids come from impact (`check --json`), and a symbol id is `<owner>/<repo>:<qualname>`, the qualified name shown in evidence paths. Then record the decision:

```bash
npx -y staleproof decide "The async client keeps positional kwargs until 2.0" \
  --governs "FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__" \
  --source https://github.com/FalkorDB/falkordb-py/issues/<n> --author "<maintainer>"
```

It prints `Recorded decision dec-… governing 1 node(s).` To replace it later:

```bash
npx -y staleproof decide "The async client drops positional kwargs in 2.0" \
  --governs "FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__" \
  --supersedes dec-<id>
```

Accept or reject a verdict the agent wrote (rejected edits are left out of the patch):

```bash
npx -y staleproof verdict reject ver-<id> --by "<maintainer>"
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
