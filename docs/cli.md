# CLI

Every `staleproof` command and option, with defaults taken from the code, examples, what each command prints or writes, and its exit status. It is for anyone running Staleproof from a terminal, a script or CI. For the environment variables behind the defaults, see [Configuration](configuration.md).

## Common tasks

```bash
npx -y staleproof db start
npx -y staleproof index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/262 --no-agent
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/262
npx -y staleproof run "FalkorDB/falkordb-py:README.md:4" --pr https://github.com/FalkorDB/falkordb-py/pull/262
npx -y staleproof patch https://github.com/FalkorDB/falkordb-py/pull/262
```

The first line starts a local FalkorDB (optional: any command starts one when none is configured, see [FalkorDB on first use](#falkordb-on-first-use)), the second indexes three repositories into one graph, the third checks a pull request without a model ([graph mode](#check)), the fourth checks it with the agent (needs model credentials), the fifth runs one docs example before and after the pull request, and the last prints the docs patch.

For a repository nobody has indexed, `check` alone is enough: it indexes the pull request's repository on first use.

```bash
npx -y staleproof check https://github.com/<owner>/<repo>/pull/<n> --no-agent
```

Before there is a pull request, and with none at all:

```bash
npx -y staleproof check --fail-on-predicted
npx -y staleproof docs-for Graph.query --repo FalkorDB/falkordb-py
npx -y staleproof audit FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
```

And with no graph at all, in about a second:

```bash
npx -y staleproof lint
```

It checks every path, link, anchor, command (scripts, make targets, the repository's own CLI and its flags) and code example in the docs, READMEs and AI agent files against the checkout ([`lint`](#lint), [Lint docs and agent files](lint.md)).
Fix what lint found, after a look at the diff:

```bash
npx -y staleproof fix --dry-run
npx -y staleproof fix
```

Each fix is checked again before it is applied ([`fix`](#fix), [Fix stale docs](fix.md)). Before tagging a release, `npx -y staleproof release` lists the breaking API changes since the last tag that the changelog does not name, and the docs still relying on them ([`release`](#release)); after an audit, `staleproof digest` posts what changed to Slack, Discord or any webhook ([`digest`](#digest)).


The first checks the working tree of the checkout you are in (uncommitted and unpushed changes) and exits 1 when an example is predicted to break, which makes it a pre-push hook ([below](#check-without-a-pull-request)); the second lists the docs that depend on a symbol before you change it; the third audits the docs as they are ([Docs audit](audit.md)).

## Install or run with npx

| How | Command | Notes |
|---|---|---|
| No install | `npx -y staleproof <command>` | `-y` answers npx's install prompt. Pin a version for repeatable runs: `npx -y staleproof@0.6.1 <command>`. |
| Global install | `npm install -g staleproof`, then `staleproof <command>` | Puts `staleproof` on your `PATH`. |
| From a clone | `npm install && npm run build`, then `node dist/cli.js <command>` | Or `npm run dev -- <command>` to run the TypeScript source. |

All three need Node.js 20 or newer. The package carries the built web UI, the tree-sitter grammars (Python, TypeScript, TSX), the sandbox shim and `scripts/falkordb-local.sh`. Examples on this page use `npx -y staleproof`; with a global install, drop `npx -y`.

## Global options

| Option | Default | Meaning |
|---|---|---|
| `--org <org>` | `STALEPROOF_ORG`, else the owner of the repository the command is about, else `falkordb` | The organisation, which names the graph (one graph per organisation). The value is turned into a slug: trimmed, lowercased, every run of characters other than `a-z`, `0-9`, `_` and `-` replaced by `-`. An empty result fails with `invalid org name`. |
| `--db <url>` | `FALKORDB_URL`, else `falkor://localhost:6379` | The FalkorDB server holding the graph. `falkor://` and `redis://` connect in plain TCP, `falkors://` and `rediss://` with TLS; credentials go in as `user:password@`. |
| `-V`, `--version` | | Print the package version. |
| `-h`, `--help` | | Print help. `staleproof <command> --help` or `staleproof help <command>` shows one command. |

Global options work before or after the command: `staleproof --org encode check …` and `staleproof check … --org encode` are the same. Results go to stdout; progress and log lines go to stderr, so you can pipe `--json` output safely.

**The default graph.** Without `--org` or `STALEPROOF_ORG`, a command uses the graph of the owner of the repository it is about, slugged: `check https://github.com/encode/httpx/pull/<n>` reads the graph `encode`, and FalkorDB's repositories land in `falkordb`. The repository is the first one given to `index` or `audit`, the pull request's for `check` and `patch`, the checkout's for `check` without a pull request, the first `--repo` (else the symbol id's) for `docs-for`, the example id's for `run`, and the first `--governs` id's for `decide`. `mcp`, `serve`, `verdict` and `facts` name no repository and use `falkordb`, and so do `audit` with no repository and `docs-for` with a bare name and no `--repo`. Pass `--org` when one graph holds repositories of several owners.

### FalkorDB on first use

Every command except `db` connects to FalkorDB. When neither `--db` nor `FALKORDB_URL` is set and nothing answers on `localhost:6379`, it first starts a local server there, the same one as `db start` (falkordblite, installed into `$STALEPROOF_HOME/falkordb/venv` on first use, which takes a minute), logs `No FalkorDB on localhost:6379: starting a local one (falkordblite; the first start installs it, which takes a minute).` on stderr, and leaves it running. With `--db` or `FALKORDB_URL` set, an unreachable server is an error: `cannot reach FalkorDB at <url>: …`.

## Exit status

| Status | When |
|---|---|
| `0` | The command finished. |
| `1` | Any error. The message is printed to stderr as `staleproof: <message>`. Typical causes: an invalid pull request URL, a repository not indexed in the graph, FalkorDB unreachable (`cannot reach FalkorDB at <url>: …`), missing model credentials, the GitHub API rate limit, an invalid `STALEPROOF_EFFORT`. |
| `1` | `check` in agent mode, when the check ends with status `error` or `refused`. The output is printed and the check is stored first. `done` and `incomplete` exit `0`. |
| `1` | `check --no-agent --format markdown`, when the stored check ends with status `error`. The comment is written first. |
| `1` | `check --fail-on-predicted` without a pull request, when an example is predicted to break. The report is printed first. |
| `1` | `audit --fail-under <score>`, when the health score is below it; `audit --fail-on-mismatch`, when any example line no longer fits the code. The report is printed (or written) first, and the reason is logged on stderr. |
| `1` | `db status`, when no server answers on the port. |

`check --no-agent` without `--format markdown` exits `0` even when the stored check ends with status `error` (for example when the impact query fails after the pull request was read); the summary line says so.

## Ids

Commands and tools refer to graph nodes by id:

| Node | Format | Example | Where to find it |
|---|---|---|---|
| Symbol | `<owner>/<repo>:<qualname>` | `FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__` | The qualified names in "Changed symbols" and in evidence paths; prefix the repository. |
| DocSection | `<owner>/<repo>:<path>#<anchor>` | `FalkorDB/docs:commands/graph.explain.mdx#<anchor>` | Impact results (`check --json`, MCP `impact`). The anchor is the heading's slug; the text before a file's first heading has an empty anchor (the id ends in `#`). |
| CodeExample | `<owner>/<repo>:<path>:<index>` | `FalkorDB/docs:commands/graph.explain.mdx:0` | Impact results (`examples` on each section) and `read_section`. `index` is the block's 0-based position among all code blocks in the file, whatever their language (fenced blocks in Markdown and MDX; code directives, `::` literal blocks and `>>>` doctest blocks in reStructuredText). An example script file has index `0`. |
| PullRequest | its URL | `https://github.com/FalkorDB/falkordb-py/pull/267` | `<owner>/<repo>#<n>` is accepted too. |
| Decision | `dec-` and 10 hex characters | `dec-<id>` | Printed by `decide`. |
| Verdict | `ver-` and 12 hex characters | `ver-<id>` | `check --json` (results of `propose_edit` and `record_verdict`), MCP results, or a Cypher query (below). |
| Run | `run-` and 20 hex characters | `run-<key>` | `run --json` (`data.runs[].id`). A run that could not be prepared gets `run-<key>-err-<ms>`. |
| Check | `chk-` and 12 hex characters | `chk-<id>` | The last line of `check`. |

List the impacted sections and their examples for a pull request, without running any example:

```bash
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/267 --no-agent --runs 0 --json \
  | jq -r '.events[] | select(.type == "tool_result" and .name == "impact" and (.isError | not)) | .data.sections[] | "\(.section)\t\(.examples | join(" "))"'
```

This lists the first impact page (up to 40 sections). List the verdicts an agent check recorded:

```bash
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/267 --json \
  | jq -r '.events[] | select(.type == "tool_result" and (.name == "propose_edit" or .name == "record_verdict") and (.isError | not)) | .data | (.id // .ids[])'
```

Or query the graph directly for every verdict on a pull request, from any check:

```cypher
MATCH (v:Verdict)-[:FOR]->(:PullRequest {url: 'https://github.com/FalkorDB/falkordb-py/pull/267'})
MATCH (v)-[:ABOUT]->(d:DocSection)
RETURN v.id, v.verdict, v.status, d.id
ORDER BY v.created_at DESC
```

## Commands

### `index`

Clone or update GitHub repositories, or download them where there is no git, and index their code and docs into the organisation's graph.

```text
staleproof index [--ref <repo=ref>]... [--json] <repos...>
```

**Arguments.** `<repos...>`: one or more repositories as `owner/name`, `https://github.com/owner/name` (with or without `.git`) or `git@github.com:owner/name.git`.

| Option | Default | Meaning |
|---|---|---|
| `--ref <repo=ref>` | the remote default branch head | Check out `ref` for that repository. Repeatable. The ref is passed to `git checkout --detach`; use `origin/<branch>`, a tag or a commit SHA, because a bare branch name can resolve to a stale local branch. |
| `--json` | off | Print the index report as JSON instead of the summary. |

**Examples.**

```bash
npx -y staleproof index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
npx -y staleproof --org encode index https://github.com/encode/httpx
npx -y staleproof index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs --ref FalkorDB/docs=origin/main --json > index-report.json
```

**What it does.** Each repository is cloned blob-less over HTTPS into `<STALEPROOF_HOME>/repos/<owner>/<name>` the first time and fetched afterwards, then checked out at the ref; with `GITHUB_TOKEN` (or `GH_TOKEN`) set, git sends the token to github.com, so private repositories the token can read work too. When git is not installed, or with `STALEPROOF_INGEST=github`, each repository is downloaded as a tarball instead and only the files the indexer reads are extracted, into `<STALEPROOF_HOME>/tarballs/<owner>/<name>/<sha>` ([details](indexing.md#without-git-tarballs)). Python files, and the TypeScript and JavaScript files of published npm packages, are parsed with tree-sitter; calls are resolved across every repository in the command; Markdown, MDX and reStructuredText pages become doc sections and code examples linked to the code they mention or call; every example call is checked against the signature it reaches, and the lines that no longer fit are recorded as `MISMATCH` edges; and dependencies between the repositories are read from `pyproject.toml`, `requirements*.txt` and `package.json` files and from the docs' imports. A repository's `.staleproof.toml` (or `[tool.staleproof]` in `pyproject.toml`) can leave paths out or mark examples not to run ([Configuration](configuration.md#repository-configuration)). [Indexing](indexing.md) has the rules.

**Prints.** On stderr, `checkout  <repo>` per repository, then one line per phase (`parse`, `write`, `resolve`, `docs`, `done`). On stdout, `Indexed <n> repositories into graph "<org>" in <s>s`, then one line per repository (commit, symbols, calls and how many cross repositories, parse errors if any), one line per repository with docs (sections, examples, uses, mentions, links, and when there are any, `<n> mismatches (staleproof audit <repo>)`: example lines that no longer fit the code) and one line per dependency, for example `FalkorDB/GraphRAG-SDK → FalkorDB/falkordb-py (declares falkordb)`.

With `--json`: `{org, run, repos: [{repo, sha, files, symbols, calls: {exact, byName, crossRepo}, gone, parseErrors}], docs: [{repo, pages, sections, examples: {total, python}, mentions, uses: {exact, byName}, links, mismatches, gone}], dependsOn: [{from, to, spec}], ms}`.

**Notes.**

- Index related repositories in one command. Calls and doc links cross repositories only among the repositories of one run; indexing a repository alone re-resolves its edges against itself and drops the cross-repository ones.
- Re-indexing updates nodes in place. Symbols, sections and examples that disappeared are marked `gone`, never deleted, so decisions and verdicts keep pointing at them. Links that an earlier pull request check added for removed symbols (`late` links) are dropped and not recreated.
- Without git, `--ref` must be a branch, tag or commit SHA that GitHub knows; `origin/<branch>` names a ref in a git clone only.
- Private repositories need `GITHUB_TOKEN` (or `GH_TOKEN`) with read access to them.
- The graph defaults to the owner of the first repository: `index encode/httpx` writes `encode`.

### `check`

Check a pull request against the graph: with the agent (default) or in graph mode (`--no-agent`), as terminal text, JSON or a pull request comment. With no pull request, check the working tree of the checkout you are in, statically ([below](#check-without-a-pull-request)).

```text
staleproof check [options] [pr-url]
```

**Arguments.** `[pr-url]`: `https://github.com/<owner>/<repo>/pull/<n>` (a trailing `/files`, query or fragment is accepted) or `<owner>/<repo>#<n>`. When the graph does not have the repository yet, it is indexed first ([below](#check)), unless `--no-index` is given. Owner and name are case-insensitive: the URL is rewritten to the repository's indexed spelling. Leave it out to check your working tree instead.

| Option | Default | Meaning |
|---|---|---|
| `--no-agent` | agent mode | Graph mode: run the tools in a fixed order with no model. |
| `--model <id>` | `STALEPROOF_MODEL`, else `claude-sonnet-5-5` | Agent mode only. The model to call. With an Anthropic-compatible provider, a `claude-*` name is refused. |
| `--effort <level>` | `STALEPROOF_EFFORT`, else `medium` | Agent mode only. `low`, `medium`, `high`, `xhigh` or `max`. The flag is passed to the model as given; only the environment variable is validated. |
| `--max-steps <n>` | `40` | Agent mode only. Model turns before the loop stops; the check is then `incomplete`. |
| `--max-hops <n>` | `3` | Graph mode only. Maximum call hops from a changed symbol to a doc. Clearance always uses 3. |
| `--runs <n>` | `3` | Graph mode only. At most this many examples are run before and after the pull request; `0` runs none. |
| `--json` | off | Print the check result as JSON instead of the trace and summary. Ignored with `--no-agent --format markdown`. |
| `--format <format>` | `text` | `text` for the terminal, or `markdown` for the pull request comment the [GitHub Action](github-action.md) posts. |
| `--out <file>` | stdout | With `--format markdown`, write the comment to this file. Ignored otherwise. |
| `--with <repos...>` | none | Repositories to index together with the pull request's when the graph is missing any of them, for example the docs site: `--with FalkorDB/docs`. Each as `owner/name` or a GitHub URL. |
| `--no-index` | index on first use | Fail with `<owner/repo> is not indexed in the "<graph>" graph` instead of indexing a repository the graph does not have. |
| `--dir <path>` | the current directory | Without a pull request: the git checkout to check. |
| `--base <ref>` | the merge base with `origin/HEAD`, else `origin/main`, else `origin/master`, else `HEAD` | Without a pull request: the commit the working tree is compared with. |
| `--repo <owner/name>` | the checkout's `origin` remote on github.com | Without a pull request: the GitHub repository the checkout is. |
| `--fail-on-predicted` | off | Without a pull request: exit 1 when an example is predicted to break (a pre-push hook or a CI gate). |
| `--annotations` | off | With a pull request: also print the docs references it makes wrong as GitHub workflow commands on stdout (`::error file=…,line=…::…`), which a GitHub Actions job turns into annotations. The [GitHub Action](github-action.md#docs-this-pull-request-makes-wrong) passes it. |

**Docs this pull request makes wrong.** A pull request check also lints the repository's docs, READMEs and AI agent files at the two commits the pull request is compared between and reports the findings only the second has (in the comment of both modes, in graph mode's text and JSON, and with `--annotations`): a path the pull request moved that `AGENTS.md` still names, a script it renamed that the README still runs ([Lint: only what a change introduced](lint.md#only-what-a-change-introduced)). The commits come from the local clone the check uses (else from GitHub's tarballs, with `GITHUB_TOKEN` for private repositories). Graph mode runs it as its first step, `new_findings`; examples stay with the graph (predicted breaks and runs), so lint's own example checks are left out here. It is skipped when the graph recorded no real commits for the pull request, and its failure (or a run over 120 s) never fails the check: the comment then says `docs references not checked: <why>`.

**The four invocations.**

| Invocation | What runs | What it stores |
|---|---|---|
| `check <pr>` | The agent loop: the model calls the tools until every impacted section has a verdict or an edit. | A Check node with the full trace, verdicts, example runs. |
| `check <pr> --no-agent` | Graph mode: `impact`, `clearance`, `rank_sections` over the first impact page, then `run_example` for at most `--runs` examples: those predicted to break (with an `exact` match) first, then examples on sections whose evidence path is `exact`. | A Check node (model `graph-only (no model)`) with the trace and runs. No verdicts. |
| `check <pr> --format markdown` | The agent check, then the comment, including the agent's summary. | As the agent check. |
| `check <pr> --no-agent --format markdown` | Graph mode as above (its trace lines go to stderr), then the comment: the examples run before and after, impact, clearance, ranking and the verdicts already recorded for the pull request. This is what the [GitHub Action](github-action.md) runs without a model key. | As graph mode. |

**Indexing on first use.** Before the check, `check` looks for the pull request's repository and every `--with` repository in the graph. If any is missing, it fetches all of them (a git clone, or a tarball without git) at their default branch heads and indexes them together in one run, logging `checkout  fetching <repo>`, the index phases and `indexed <repo>@<sha7>, … into graph "<org>" in <s>s` on stderr. When all are present it indexes nothing, so later checks start at once; re-index with [`index`](#index) to move the graph to newer commits.

**Examples.**

```bash
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/262 --no-agent
npx -y staleproof check https://github.com/acme/acme-client/pull/12 --no-agent --with acme/acme-docs
npx -y staleproof check FalkorDB/falkordb-py#276 --no-agent --runs 0
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/267 --max-steps 60
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/267 --no-agent --format markdown --out comment.md
```

**Prints, graph mode.** The shape of the output, with placeholders in angle brackets:

```text
Docs this pull request makes wrong (<k>)
  lint at <before> and <after>
  AI agent instructions
    <path>
      <line>:<column>  error    <message>  [<rule>]

<pull request title>
<url> (<state>, <before>..<after>)

Changed symbols (<n>)
  <change>       <qualname>

Impacted doc sections (<total>)
  <BREAKING|SIGNATURE|BEHAVIOR> <heading> [<repo>] (other repo)
    path: <changed symbol> ← <caller> ← <doc>
    <hops> hops, <exact|by-name|late>, <k> example(s) · <url>

Predicted to break (<p>): the call no longer fits the changed code
  ✗ <path>:<index> line <line> <call as written>
    <why, e.g. `Graph.query` requires `timeout`, which the example does not pass>

Already out of date before this PR (<k>)
  ! <path>:<index> line <line> <what does not fit>

Cleared: reach no doc within 3 hops (<m>)
  ✓ <qualname> (<change>; <t> raw text matches in docs; check: git grep -nw <name> -- '*.md' '*.mdx' '*.rst')

<example id>
<example url>

FAIL before <repo@sha, …>
  <traceback>

PASS after <repo@sha, …>

<summary>
Stored as chk-<id>.
```

Sections are ordered by the PageRank of their page in the docs' link graph. Only the first 40 are listed, followed by `… <n> more` when there are more. **Predicted to break** lists, over every impacted section, the example lines whose call no longer fits the code after the pull request: a removed or renamed symbol, a name the package stops exporting, or a call the new signature rejects that the old one accepted ([Predicted breaks](concepts.md#predicted-breaks)); a line marked `(matched by name)` was linked by name rather than through types. **Already out of date** lists impacted example lines that did not fit the code before the pull request either. Both blocks are left out when empty. A pull request that already edits docs adds a line `This PR already edits: <paths>`. A run answered from the graph is marked `(recorded)`.

**Prints, agent mode.** The trace, one or more lines per event:

```text
Staleproof checking <pr> (<model>, chk-<id>)
since the last check: <what the graph learned since the previous check>
  <the model's summarised reasoning>
→ impact(pr_url=<pr>)
← <tool summary>
  <n> Cypher queries: impact, prChanges, … · <ms> ms
! <n> impacted section(s) still need a verdict; reminding the model

Done <turns> turns, <calls> tool calls (impact → read_section → …), <v> verdicts, <tokens> tokens
<the model's closing summary>

Patch: staleproof patch <pr>   Trace: stored on chk-<id>
```

The final status is `Done`, `Incomplete`, `refused` or `error`. The check is `Done` only when every impacted section, on every impact page, has a verdict or an edit. When the model stops with sections still open it is reminded up to twice; after that, or after `--max-steps` turns, the check is `Incomplete` and lists the open sections.

**Prints, `--format markdown`.** The report the GitHub Action posts as its comment, on stdout or into `--out`: the title (what broke first), the impact summary, "Docs this pull request makes wrong" (the new lint findings, AI agent instructions first), the examples predicted to break, a table of the examples run before and after the pull request, the impacted sections with their evidence paths, the lines already out of date, the cleared symbols, the verdicts and, in agent mode, the agent's summary. It ends with machine-readable lines: `<!-- staleproof:findings new=<n> errors=<n> warnings=<n> -->` when the docs references were checked, then `<!-- staleproof:counts breaks=<n> predicted=<n> sections=<n> mismatched=<n> -->`. [GitHub Action](github-action.md#the-comment) shows the format.

**JSON.** `{checkId, pr, status, summary, events, impacted, missing, toolOrder, since, newFindings}`. `events` holds every trace event, including each tool's full result in `tool_result.data`. In graph mode `impacted` and `missing` are empty; read the sections from the `impact` result in `events`. `newFindings` (graph mode, when the docs references were checked) is `{repo, base, head, findings, total, fixed, summary, files, ms}`, `findings` in the [lint JSON shape](lint.md#json-output).

**Notes.**

- The first check of a pull request reads its metadata from GitHub and diffs it into symbol-level changes. For a merged pull request the commits compared are the merge commit's first parent and the merge commit; for an open one, the merge base and the head. Before each later check of an open pull request, `check` asks GitHub for its head: when new commits were pushed (or it was merged since), it logs `<pr> has new commits since it was last checked: reading its current diff` and diffs it again. A merged pull request is never re-diffed. When GitHub cannot be reached, the stored diff is used.
- Agent mode needs model credentials: `ANTHROPIC_API_KEY` (or another credential the Anthropic SDK finds) for Claude, or `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and `STALEPROOF_MODEL` for an Anthropic-compatible provider. Without them it stops with an error naming those variables. See [The agent](agent.md).
- The CLI puts no time limit on an agent check. A large pull request takes minutes: a 43-section check takes about 6 minutes.
- Graph mode samples: it ranks the first impact page and runs at most `--runs` examples. It never judges sections or writes verdicts.
- Two kinds of change are reported more broadly than they happened. A moved or renamed file reports every definition in it as removed and added. A module that stops importing a name from its own package reports that name as a removed export (`BREAKING`), even when the import was not a public re-export.

#### Check without a pull request

With no pull request URL, `check` checks the working tree of a git checkout against the commit it started from: before you commit, before you push, or from a pre-push hook.

```bash
npx -y staleproof check
npx -y staleproof check --dir ../acme-client --base origin/release --format markdown --out report.md
```

What it does:

1. Finds the checkout's top directory (from `--dir`, default the current directory), the GitHub repository it is (`--repo`, else its `origin` remote), the base commit (`--base`, else the merge base of `HEAD` with `origin/HEAD`, `origin/main` or `origin/master`, else `HEAD` itself) and the current branch.
2. Indexes the repository (and the `--with` repositories) when the graph does not have it, as a pull request check does, unless `--no-index`.
3. Compares the base commit with the files on disk: staged, unstaged and untracked (not ignored) files, and any commits since the base, so unpushed commits count. Python and TypeScript/JavaScript library files become symbol-level changes, as for a pull request.
4. Walks the graph from the changed symbols: the impacted sections with their evidence paths, the examples [predicted to break](concepts.md#predicted-breaks), the impacted lines already out of date, and the cleared symbols.
5. Lints the docs and agent files on disk and at the base commit, and lists the findings only the working tree has under "Docs these changes make wrong" (as [`lint --new --base <base>`](lint.md#only-what-a-change-introduced) would).

Nothing runs and nothing about the changes is written to the graph: no pull request, no check, no run. The agent and run options (`--no-agent`, `--model`, `--runs`, …) do not apply.

**Prints.** The same blocks as graph mode, without runs. From the test suite's fixture organisation, after adding a required keyword-only `timeout` to `Graph.query`:

```text
Changed symbols (1)
  signature      miniclient.graph.Graph.query
                 def query(self, q: str, params=None)
               → def query(self, q: str, params=None, *, timeout: float)

Impacted doc sections (3)
  SIGNATURE Getting started > Connect [acme/mini-docs] (other repo)
    path: miniclient.graph.Graph.query ← acme/mini-docs:docs/getting-started.mdx:0
    1 hops, exact, 1 example(s) · https://github.com/acme/mini-docs/blob/<sha>/docs/getting-started.mdx#L14
  …

Predicted to break (1): the call no longer fits the changed code
  ✗ docs/getting-started.mdx:0 line 18 g.query
    `Graph.query` requires `timeout`, which the example does not pass

Already out of date before these changes (2)
  ! docs/stale.md:1 line 19 `Graph.query` takes at most 2 positional arguments; the example passes 3
  ! docs/stale.md:1 line 20 `Graph` has no attribute `read_only`

Cleared: reach no doc within 3 hops (0)

1 changed symbol reaches 3 doc sections (0 breaking, 3 signature, 0 behavior; 3 in other repositories). 1 example is predicted to break, the call no longer fitting the changed code.
Static check of the working tree: nothing was run or written to the graph. Push and open a pull request to run the examples before and after.
```

With `--json`: `{summary, impact, cleared, newFindings}`, where `impact` has the shape of the [`impact` result](tools.md#impact-result) (`pr.state` is `local`) and `newFindings` lists the docs references the working tree makes wrong (`head` is `WORKTREE`). With `--format markdown`: the comment format, titled `these changes are predicted to break <n> docs example(s)` (or `<n> doc section(s) these changes can make false`), written to `--out` when given.

**As a pre-push hook.** `--fail-on-predicted` exits 1 when any example is predicted to break, so git stops the push:

```bash
printf '#!/bin/sh\nnpx -y staleproof check --fail-on-predicted\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

`git push --no-verify` skips the hook once.

**Errors.** `cannot tell which GitHub repository <dir> is (origin: <url>); pass --repo owner/name` when the `origin` remote is not on github.com (or missing); `<owner/repo> is not indexed in the "<graph>" graph: staleproof index <owner/repo>` with `--no-index`; git's own error when the directory is not a checkout or `--base` does not resolve.

### `docs-for`

Which docs depend on a symbol, with the evidence path for each: what to update before you change it.

```text
staleproof docs-for [--repo <owner/name...>] [--json] <symbol>
```

**Arguments.** `<symbol>`: a Symbol id (`<owner>/<repo>:<qualname>`), a qualified name (`miniclient.graph.Graph.query`), a dotted suffix (`Graph.query` matches every qualified name ending in `.Graph.query`) or a bare name (`query`). Only live symbols count, never modules. An exact id or qualified name wins over suffix and bare-name matches; otherwise the first 5 matches, in qualified-name order, are looked up together and the summary says the name is ambiguous.

| Option | Default | Meaning |
|---|---|---|
| `--repo <owner/name...>` | any repository | Only symbols defined in these repositories. The first one also picks the graph (its owner). |
| `--json` | off | Print `{summary, query, symbols, ambiguous, sections, mismatched}` |

**What it does.** The [impact](concepts.md#impact) walk started from the symbol instead of a pull request: symbol ← up to 3 callers in any repository ← the doc sections that name them and the examples that call them, then the lines in those examples that already do not fit the code. It reads the graph and writes nothing. The MCP tool [`docs_for_symbol`](tools.md#docs_for_symbol) and [`GET /api/docs-for`](http-api.md#get-apidocs-for) give the same answer.

**Prints.** From the fixture organisation, `docs-for Graph.query --repo acme/mini-client`:

```text
miniclient.graph.Graph.query method · acme/mini-client
  def query(self, q: str, params=None)

  Getting started > Connect [acme/mini-docs] 1 hops, exact, 1 example(s)
    path: miniclient.graph.Graph.query ← acme/mini-docs:docs/getting-started.mdx:0
    https://github.com/acme/mini-docs/blob/<sha>/docs/getting-started.mdx#L14
  Upgrading guide > Query [acme/stale-docs] 1 hops, exact, 1 example(s)
    path: miniclient.graph.Graph.query ← acme/stale-docs:docs/stale.md:1
    https://github.com/acme/stale-docs/blob/fixture/docs/stale.md#L14
  Getting started > Read-only queries [acme/mini-docs] 2 hops, exact, 1 example(s)
    path: miniclient.graph.Graph.query ← miniclient.graph.Graph.ro_query ← acme/mini-docs:docs/getting-started.mdx:1
    https://github.com/acme/mini-docs/blob/<sha>/docs/getting-started.mdx#L21
  ! acme/stale-docs:docs/stale.md:1 line 19: `Graph.query` takes at most 2 positional arguments; the example passes 3
  ! acme/stale-docs:docs/stale.md:1 line 20: `Graph` has no attribute `read_only`

3 doc sections reach miniclient.graph.Graph.query (2 name or call it directly; 2 repositories). 2 line(s) in those examples already do not fit the code.
```

No match prints `No live symbol in the "<graph>" graph is named <symbol>.`; a symbol no doc reaches, `No doc section or example reaches <qualname> within 3 call hops: changing it cannot make a doc false through the code.` Without `--repo` or an id, the graph is `STALEPROOF_ORG`, else `falkordb`: pass `--repo` or `--org` for other organisations.

### `lint`

Check every claim the docs, READMEs and AI agent instruction files (`AGENTS.md`, `CLAUDE.md`, Cursor, Copilot, Windsurf and Cline rules) make about the repository: the paths they name, the links and anchors they follow, the commands they run (package scripts, make/just/task targets, the repository's own CLI subcommands and flags), and their code examples. Needs no FalkorDB and no network. [Lint docs and agent files](lint.md) explains what is read, each rule and the precision guards; [Lint rules](rules.md) lists every rule.

```text
staleproof lint [options] [dir]
```

**Arguments.** `[dir]`: the checkout to lint (default `.`). Git-tracked files are read when it is a git checkout, otherwise every non-hidden file.

| Option | Default | Meaning |
|---|---|---|
| `--format <format>` | `text` | `text`, `json`, `sarif` (2.1.0, for code scanning), `github` (workflow annotations) or `markdown` |
| `--out <file>` | stdout | Write the report to a file; logs `wrote <file>: <summary>` on stderr |
| `--fail-on <level>` | `error` | Exit 1 when a finding is at or above `error`, `warning` or `info`; `never` always exits 0 |
| `--rule <ids...>` | all | Only these rules |
| `--disable <ids...>` | none | Skip these rules |
| `--files <paths...>` | all | Report only findings in these files, or about them (a missing path or link target among them) |
| `--with <dirs...>` | none | Other local checkouts whose code the docs examples call |
| `--no-examples` | examples on | Skip the static checks of docs code examples (no code is parsed) |
| `--repo <owner/name>` | origin remote | The GitHub repository the checkout is, for links in reports |
| `--new` | off | Only findings the changes introduced: absent at the base commit |
| `--base <ref>` | `HEAD` with uncommitted changes, else the merge base with the default branch | With `--new`: the commit to compare with (read from the local clone, never fetched). `--base` without `--new` is a usage error |
| `--staged` | off | Lint the git index (what the next commit contains) instead of the files on disk; with `--new` the base is `HEAD` |
| `--no-cache` | cache on | Parse every file again instead of reading the local parse cache in `.staleproof/cache/` (also `STALEPROOF_CACHE=off`); see [Lint: the parse cache](lint.md#the-parse-cache) |
| `--fixes` | off | Attach the verified fix to each finding it can fix (two more lints): `fix:` lines in text, `Fix:` in `github` annotations, `fixes` in SARIF. Ignored with `--staged`. See [Fix stale docs](fix.md) |

**Examples.**

```bash
npx -y staleproof lint
npx -y staleproof lint --new
npx -y staleproof lint --staged --new --fail-on error
npx -y staleproof lint --format github
npx -y staleproof lint ../acme-docs --with ../acme-client --format markdown --out lint.md
npx -y staleproof lint --rule path-missing link-broken --fail-on warning
```

**Prints.** Findings grouped by section (AI agent instructions first, then READMEs, docs, code examples), each as `line:column  severity  message  [rule]`, then a summary: `<n> errors, <n> warnings in <files> files (<checked> files checked, <ms> ms)`, or `No stale references in <n> files`. Config warnings (unknown keys) are printed as `warning: …` and never stop the run. Unknown rule ids fail with `unknown rule <id>`; a bad `--format` or `--fail-on` with the allowed values. With `--new`, only the new findings are printed and stderr says what was compared: `new findings only: <working tree|index> against <base> (<why>); <n> fixed`. [Lint: only what a change introduced](lint.md#only-what-a-change-introduced) explains the base and the fingerprints.

**Exit status.** 1 when a finding is at or above `--fail-on`; 2 on a usage or internal error; otherwise 0.

### `fix`

Apply the fixes Staleproof could re-check: a renamed script, Make or just target, CLI flag or subcommand, file, heading, environment variable, symbol or parameter written the new way, and close typos (`npm run buld` → `npm run build`). Each fix is applied in a mirror of the checkout and linted again first; only fixes whose finding goes away and that add none are applied. [Fix stale docs](fix.md) explains where fixes come from and when Staleproof refuses one.

```text
staleproof fix [options] [dir]
```

| Option | Default | Meaning |
|---|---|---|
| `--dry-run` | off | Print the unified diff and write nothing |
| `--rule <ids...>` | all fixable | Only fix findings of these rules |
| `--disable <ids...>` | none | Skip these rules |
| `--new` | off | Only fix what the changes introduced (findings absent at the base) |
| `--base <ref>` | `HEAD` with uncommitted changes, else the merge base with the default branch | The commit renames are detected against (and `--new` compares with); read from the local clone, never fetched |
| `--fail-on <level>` | `error` | Exit 1 when a finding at or above this is left |
| `--format <format>` | `text` | `text` or `json` |
| `--with <dirs...>`, `--no-examples`, `--repo <owner/name>`, `--no-cache` | | As for `lint` |

**Examples.**

```bash
npx -y staleproof fix --dry-run
npx -y staleproof fix
npx -y staleproof fix --new --rule command-missing path-missing
```

**Prints.** With `--dry-run`, the unified diff first. Then one line per fix, `fixed  path:line:column  rule  description` (`would fix` with `--dry-run`), a `hint` line for each fix that did not pass re-checking (not applied), and a summary: `Fixed <n> findings in <files> files; <n> findings left.` A second run prints `Nothing to fix automatically; <n> findings left (run staleproof lint to see them).` or `Nothing to fix.` On stderr: `renames detected against <base> (<why>)`. A file edited while Staleproof worked is skipped (`skipped <path>: …`), never overwritten.

**Exit status.** As for `lint`, measured after the fixes: 1 when a finding at or above `--fail-on` is left (with `--dry-run`: would be left); a usage or internal error exits non-zero as `lint` does; otherwise 0.

### `hook`

Run one coding-agent hook: read the hook's JSON on stdin (Claude Code's or Cursor's), lint the working tree against `HEAD`, and print what the agent should know, as the agent's hook JSON. The [Claude Code plugin](claude-code.md) runs it; `init --claude` and `init --cursor` write it into the agent's settings. Needs no FalkorDB and sends nothing anywhere.

```text
staleproof hook [options] <event>
```

**Arguments.** `<event>`: `session-start` (lint once to warm the cache, remember what was already new), `post-edit` (the docs the edited files made wrong), or `stop` (the docs the session made wrong, before the agent stops).

| Option | Default | Meaning |
|---|---|---|
| `--cursor` | read from the input | Answer in Cursor's hook JSON (`additional_context`, `followup_message`) |
| `--no-graph` | graph on | `stop`: skip the docs examples predicted to break, read from a FalkorDB already running on this machine |

**Prints.** Nothing when there is nothing to say. `post-edit`: `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "<list>"}}`. `stop`: `{"decision": "block", "reason": "<list>"}`, or `{"systemMessage": "<list>"}` with `[hooks] stop = "warn"`, `STALEPROOF_HOOK=warn` or when the agent is already continuing for a stop hook. The list has at most ten items, `path:line:column message [rule]`. [Claude Code plugin](claude-code.md#other-agents) has the fields each event reads.

**Exit status.** Always 0, also on an error or after its time limit (10 seconds for `post-edit`, 50 for `stop`): a hook never fails the agent. An unknown event exits 1.

### `init`

Set Staleproof up in a repository: detect the GitHub repository (origin remote), languages, docs folders, agent files and a separate docs repository the README links to, then offer each file and write the ones you accept. Run again, it leaves what is in place alone and writes nothing.

```text
staleproof init [options] [dir]
```

| Option | Default | Meaning |
|---|---|---|
| `-y`, `--yes` | ask in a terminal | Take the detected defaults without asking (also the default when stdin is not a terminal) |
| `--dry-run` | off | Print the plan with each new file's content and each change as a diff, and write nothing |
| `--claude` | off | Add the [hooks](claude-code.md#without-the-plugin) to `.claude/settings.json`, merged with what is there |
| `--cursor` | off | Add the [hooks](claude-code.md#cursor) to `.cursor/hooks.json` |
| `--docs-repo <owner/name>` | asked when one is detected | The docs live in another repository: the workflow indexes it with this one (`also-index`) |
| `--skip <items...>` | none | Leave out `config`, `workflow`, `badge`, `pre-commit`, `gitignore` or `vscode` |

| File | Written when | Content |
|---|---|---|
| `.staleproof.toml` | there is none (and no `[tool.staleproof]` in `pyproject.toml`) | What init found, every setting commented out, `[hooks] stop = "block"` |
| `.github/workflows/staleproof.yml` | no workflow uses `rajkaria/staleproof@` yet | The pull request check and a weekly audit (`uses: rajkaria/staleproof@v1`) |
| `README.md` | it has no badge yet | The [docs health badge](audit.md#the-readme-badge) at the end of the badge row, else after the title |
| `.pre-commit-config.yaml` | it exists, or the repository is Python | The [`staleproof` hook](pre-commit.md), in the file's own list style |
| `lefthook.yml` or `.husky/pre-commit` | either exists (and pre-commit is not used) | `staleproof lint --new --staged` on commit |
| `.gitignore` | it does not ignore `.staleproof/` | `.staleproof/` (the parse cache) |
| `.claude/settings.json`, `.cursor/hooks.json` | `--claude`, `--cursor` | The agent hooks |

**Examples.**

```bash
npx -y staleproof init
npx -y staleproof init --yes --dry-run
npx -y staleproof init --yes --claude --docs-repo acme/docs
```

**Prints.** One line per file (`create`, `update`, `unchanged`, or `manual` with what to add by hand when a file cannot be edited safely, such as a README that starts with HTML), then the next steps: commit the workflow, `pre-commit install`, restart Claude Code. A JSON settings file that is not plain JSON is never rewritten.

### `audit`

Audit docs with no pull request: a 0-100 health score, the example lines that no longer fit the code, API coverage and the example runs at the indexed commits. [Docs audit](audit.md) explains each part, the score and how to read the report.

```text
staleproof audit [options] [repos...]
```

**Arguments.** `[repos...]`: the repositories to audit, as `owner/name` or GitHub URLs. When the graph is missing any of them, all of them are fetched and indexed together at their default branch heads first (as `check` does). With none, every repository in the graph is audited.

| Option | Default | Meaning |
|---|---|---|
| `--run <n>` | `0` | First run up to `n` Python, JavaScript and TypeScript examples at the indexed commits, examples with a mismatch first (needs `git`, and uv or Python 3.12+ for Python, Node for JavaScript and TypeScript) |
| `--limit <n>` | `25` | How many undocumented symbols to list |
| `--format <format>` | `text` | `text`, `markdown` (the GitHub Action's job summary and issue body) or `json` |
| `--out <file>` | stdout | Write the report to a file; logs `wrote <file>: <summary>` on stderr |
| `--fail-under <score>` | none | Exit 1 when the health score is below this (a whole number) |
| `--fail-on-mismatch` | off | Exit 1 when any example line no longer fits the code |
| `--no-index` | index on first use | Fail with `not indexed in the "<graph>" graph: <repos>` instead of indexing |

**Examples.**

```bash
npx -y staleproof audit FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
npx -y staleproof audit encode/httpx --run 20 --format markdown --out audit.md
npx -y staleproof audit acme/acme-client acme/acme-docs --fail-under 80 --fail-on-mismatch
```

**Prints.** The score and grade, the indexed commits, a summary, the deductions, every example line that no longer fits the code (`✗ <path>:<index> line <n> · <repo>`, then the detail, its kind and the call), the failing runs, API coverage with the most used undocumented symbols, and for one repository the README badge Markdown. [Docs audit](audit.md#the-cli) shows a full report and the JSON shape. `--format`, `--run`, `--limit` and `--fail-under` are validated before anything runs: `unknown --format <x> (text, markdown or json)`, `--run must be a whole number, got <x>`, `--fail-under must be a score from 0 to 100, got <x>`.

**Exit status.** 1 when the score is below `--fail-under` (logs `health score <s> is below --fail-under <n>`) or, with `--fail-on-mismatch`, when any line no longer fits (logs `<n> example(s) no longer fit the code (--fail-on-mismatch)`); the report is printed or written first. Otherwise 0, whatever the score.

### `digest`

Post what changed in the docs health since the last digest: score and change, new drift with links, problems fixed, verified fixes. [Docs audit](audit.md#weekly-digest-to-slack-or-discord) explains the payloads and the state.

```text
staleproof digest [options] [repos...]
```

| Option | Default | Meaning |
|---|---|---|
| `--webhook <url>` | `STALEPROOF_DIGEST_WEBHOOK` | Post there: Slack and Discord by host, JSON otherwise. Logged by host only |
| `--as <kind>` | `auto` | Force the payload: `slack`, `discord` or `json` |
| `--format <format>` | `text` | What to print: `text`, `markdown`, `json`, or the `slack`/`discord` payload |
| `--previous <file>` | none | The previous state: an audit issue body or a state file |
| `--state-out <file>` | none | Append the new `<!-- staleproof:state ... -->` line to this file |
| `--graph-state` | off | Read and write the state in the graph |
| `--link <url>` | none | The full report to link to |

The repositories must be indexed (`staleproof audit` first). Exit status 1 when the webhook refuses the post.

### `release`

The release gate: breaking public API changes since the last tag, whether the changelog names them, docs still relying on what changed, lint at the release. No graph, no network. See [Release gate](release.md).

```text
staleproof release [dir] [--from <ref>] [--to <ref>] [--changelog <file>] [--fail-on <gates>] [--format text|markdown|json] [--out <file>] [--repo <owner/name>]
```

**Exit status.** 0 when no selected gate fails, 1 when `undocumented-breaking` or `stale-docs` fails, 2 for a usage error or unreadable commits.

### `run`

Run one docs code example in the sandbox, once at the indexed commits or before and after a pull request.

```text
staleproof run [--pr <url>] [--fresh] [--json] <example-id>
```

**Arguments.** `<example-id>`: a CodeExample id, `<owner>/<repo>:<path>:<index>`.

| Option | Default | Meaning |
|---|---|---|
| `--pr <url>` | none | Run twice: with the pull request's repository installed at the commit before the pull request, then at the pull request. Other repositories are installed at their indexed commits. The pull request is read first if it has not been checked. Without `--pr`, the example runs once at the indexed commits. |
| `--fresh` | off | Run even if an identical run (same program, same commits) is recorded, and replace the stored run. Only this command offers it. |
| `--json` | off | Print the tool result as JSON: `{tool, summary, data: {example, url, verdict, runs}, queries}`. |

**Examples.**

```bash
npx -y staleproof run "FalkorDB/falkordb-py:README.md:4" --pr https://github.com/FalkorDB/falkordb-py/pull/262
npx -y staleproof run "FalkorDB/docs:commands/graph.explain.mdx:0" --pr https://github.com/FalkorDB/falkordb-py/pull/267 --fresh
npx -y staleproof run "FalkorDB/docs:commands/graph.profile.mdx:0" --json
```

**Prints.** The example id and URL; per run, a status line (`PASS`, `FAIL`, `TIMEOUT`, `SKIPPED` or `ERROR`, then `before` or `after`, the `repo@sha` list installed, and `(recorded)` when answered from the graph), the examples stitched in front of it, the reason for a skip or error, and the traceback of a failure; then a one-line summary. The verdict is one of:

| Verdict | Meaning |
|---|---|
| `breaks` | Passes before, fails after: the pull request breaks the example. |
| `fixes` | Fails before, passes after. |
| `passes` | Passes on every run. |
| `already-broken` | Fails before and after with the same error: broken already, not by this pull request. |
| `changed-failure` | Fails before and after with different errors. |
| `fails` | Fails at the indexed commits (no `--pr`). |
| `skipped` | Not run, with the reason. When the run before the pull request is skipped, the run after it is not attempted. |
| `error` | The sandbox could not be prepared (for example an install conflict). Such runs are never answered from the graph. |

**Notes.**

- Examples are skipped, with the reason recorded, when they are not Python, need an LLM provider key, read a local file the docs do not provide, contain placeholders to fill in, wait for input, or call an external service. A fragment that uses names an earlier block on the page defines is run with those blocks stitched in front of it. See [Example runner](example-runner.md).
- Each run gets a fresh virtualenv per set of commits (cached), a scratch FalkorDB that is flushed first, no network other than that server, and a timeout (`STALEPROOF_RUN_TIMEOUT_MS`, default 30 seconds). Runs execute one at a time.
- Needs `git`, `tar`, and uv or `python3`. On a host without them, runs are reported as skipped and not recorded; runs recorded by other hosts are still answered from the graph.

### `decide`

Record a maintainer decision. Future agent checks cite it instead of re-flagging the sections it governs.

```text
staleproof decide <text> --governs <id...> [--source <url>] [--author <name>] [--supersedes <decision-id>]
```

**Arguments.** `<text>`: the decision, in one sentence.

| Option | Default | Meaning |
|---|---|---|
| `--governs <id...>` | required | DocSection and/or Symbol ids the decision governs. At least one must exist in the graph. |
| `--source <url>` | empty | Where it was decided: an issue, a pull request comment, an ADR. |
| `--author <name>` | `unknown` | Who decided. |
| `--supersedes <decision-id>` | none | The decision this one replaces. The old one is marked `superseded`; an unknown id is ignored without an error. |

**Examples.**

```bash
npx -y staleproof decide "The async client keeps positional kwargs until 2.0" \
  --governs "FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__" \
  --source https://github.com/FalkorDB/falkordb-py/issues/<n> --author "<maintainer>"
npx -y staleproof decide "The async client drops positional kwargs in 2.0" \
  --governs "FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__" --supersedes dec-<id>
```

**Prints.** `Recorded decision dec-<id> governing <n> node(s).`, with `, superseding <id>` when it replaces one. Fails with `none of <ids> is a DocSection or Symbol id; decision not recorded` when no id matches.

**Notes.** Put the decision text before `--governs`: the option takes every value that follows it, up to the next option. [Decisions and memory](memory.md) explains how decisions are matched to sections.

### `verdict`

Accept or reject a verdict. Rejected edits are left out of the patch, and later checks see the review.

```text
staleproof verdict [--by <name>] <accept|reject> <verdict-id>
```

| Option | Default | Meaning |
|---|---|---|
| `--by <name>` | `$USER`, else `maintainer` | The reviewer recorded on the verdict. |

**Example.**

```bash
npx -y staleproof verdict accept ver-<id> --by "<maintainer>"
```

**Prints.** `<verdict-id> accepted` or `<verdict-id> rejected`. Sets the verdict's `status`, `reviewed_by` and `reviewed_at`. Fails with `action must be accept or reject` or `no verdict <id>`.

### `patch`

Print the docs patch for a checked pull request: a unified diff and a pull request description with the evidence behind each edit. Optionally open it as a pull request.

```text
staleproof patch [--out <file>] [--open-pr [--upstream | --in-repo [--base <branch>] [--only <repos...>]]] <pr-url>
```

| Option | Default | Meaning |
|---|---|---|
| `--out <file>` | stdout | Write the diff to `<file>` and the title and description to `<file>.md`. |
| `--open-pr` | off | Open the fix as a pull request, one per docs repository. Needs `GITHUB_TOKEN` (or `GH_TOKEN`). |
| `--upstream` | off | With `--open-pr`: open it against the original repository instead of inside your fork. |
| `--in-repo` | off | With `--open-pr`: push a branch to each docs repository itself and open the pull request there, with no fork: what a CI token can do. Cannot be combined with `--upstream`. |
| `--base <branch>` | the repository's default branch | With `--in-repo`: the branch the fix starts from and targets, for example the checked pull request's own branch. |
| `--only <repos...>` | every edited repository | With `--in-repo`: only these repositories; edits in others are skipped (a CI token can write to its own repository only). |

**Examples.**

```bash
npx -y staleproof patch https://github.com/FalkorDB/falkordb-py/pull/267
npx -y staleproof patch https://github.com/FalkorDB/falkordb-py/pull/267 --out docs-267.diff
npx -y staleproof patch <pr-url> --open-pr
npx -y staleproof patch <pr-url> --open-pr --in-repo --base my-feature --only acme/acme-client
```

**Prints.** The diff, or `(no proposed edits)`, then `# docs: update for <repo>#<number> (<pull request title>)` and the description: per edited section, the reason, the evidence path, the example runs and the cited decisions; then the sections checked and left unchanged with their verdicts; then any edit that could not be applied. With `--out`, it writes the two files and logs `wrote <file> and <file>.md (<n> files)` on stderr. With `--open-pr`, it prints `opened <url> (fork)`, `opened <url> (upstream)` or `opened <url> (same-repo)` per docs repository; when `--only` leaves nothing, it logs `no pull request opened: no proposed edit is in a repository this token may write to`.

**Notes.**

- The patch uses the latest verdict on each section from any check, MCP client or API call. An edit is a `stale` verdict with replacement text that a maintainer has not rejected. Graph mode writes no verdicts, so a graph-mode check alone gives an empty patch.
- Each file is read at the commit the graph indexed, from the local clone when there is one, otherwise from `raw.githubusercontent.com`. An edit whose section changed since indexing, or whose file is missing at that commit, is not applied and is listed instead. Sections longer than 8,000 characters always conflict, because the graph stores only their first 8,000 characters.
- Diff paths are relative to each docs repository. When the patch spans several repositories, apply each file's part in its own repository with `git apply`, or use `--open-pr`.
- `--open-pr` forks each docs repository into your account (always, even with `--upstream`), syncs the fork, creates or resets the branch `staleproof/<owner>-<repo>-<number>` (named after the code pull request) at the indexed commit, commits each edited file, and opens the pull request. It fails with `opening a pull request needs GITHUB_TOKEN` without a token and with `the patch is empty: no proposed edits to open a pull request for` when there is nothing to open.
- `--in-repo` creates or resets the branch `staleproof/docs-<owner>-<repo>-<number>` in the docs repository at the head of `--base` (default: its default branch), commits each edited file, and opens a pull request into `--base`, or reuses the open one from that branch. The edits were written against the indexed commit; each is applied to the file as it is on `--base`, like `git apply`, so the branch's own changes to that file are kept. A file `--base` changed where an edit applies (or no longer has) is left out and named in the pull request (`left out of the pull request in <repo>: <path>: ...`); when every file is left out, nothing is opened and the command fails with `the docs fix was not opened: the target branch has other text where each edit applies (...)`. The token needs `contents: write` and `pull-requests: write` on that repository. This is how the GitHub Action's `open-docs-pr` puts the docs fix into the checked pull request's branch ([GitHub Action](github-action.md#open-the-docs-fix-as-a-pull-request)).
- Fails with `<url> has not been checked` for a pull request the graph has never read.

### `suggest`

Post the verified fixes for the docs references a pull request makes wrong as GitHub suggestions on its diff: lint base and head (the local clone, else the archives), keep the new findings, fix them with renames detected between the two commits, and post one review on the head commit. A suggestion already posted on the same lines is updated (or left when it says the same); one on lines that changed is left as it is; nothing is posted twice. The GitHub Action runs it in check mode (`suggestions: true`).

```text
staleproof suggest [options] <pr-url>
```

| Option | Default | Meaning |
|---|---|---|
| `--dry-run` | off | Plan the suggestions, post nothing |
| `--out <file>` | none | Write the Markdown that lists the verified fixes outside the diff (for the pull request comment) |
| `--author <login>` | any | Only comments by this account count as earlier Staleproof suggestions |
| `--json` | off | Print the findings, the planned comments, the fixes outside the diff and what was posted |

Needs `GITHUB_TOKEN` with `pull-requests: write`. **Prints** `<n> new finding(s), <n> with a verified fix: <n> suggestion(s) on the diff, <n> outside it (posted <n>, updated <n>, already there <n>, superseded <n>: <review url>)`. A read-only token (a fork's) prints a warning and exits 0.

### `fix-pr`

Renovate for docs: lint the default branch, apply every verified fix on the branch `staleproof/fix-docs` (rebuilt from the default branch on every run), and keep one pull request, `Staleproof: fix <n> stale docs references`, with a table of the fixes and the evidence for each. Closes it when nothing is left; does not reopen fixes someone closed without merging until they change. Writes no ref outside `staleproof/` and never touches another branch. The Action runs it with `mode: fix`.

```text
staleproof fix-pr [options] <owner/name>
```

| Option | Default | Meaning |
|---|---|---|
| `--dir <dir>` | clone or download | A checkout of the default branch to use as it is |
| `--branch <name>` | `staleproof/fix-docs` | The fix branch; must start with `staleproof/` |
| `--dry-run` | off | Say what would change, write nothing |
| `--json` | off | Print the result as JSON |

Needs `GITHUB_TOKEN` with `contents: write` and `pull-requests: write`. **Prints** one line: `Opened the fix pull request with <n> verified fixes in <n> files: <url>`, `Updated …`, `The fix pull request is up to date …`, `Nothing left to fix at <branch>: closed <url>`, or `Nothing to fix at <branch> (<sha>).`

### `mcp`

Serve the tools over the Model Context Protocol on stdio.

```text
staleproof mcp
```

**Example.**

```bash
claude mcp add staleproof -- npx -y staleproof mcp
```

**Prints.** On stderr, `staleproof mcp: serving graph "<org>" from <url>` (or `serving each repository's owner graph`) with any password masked, and `staleproof: <message>` lines while it indexes. Stdout carries the protocol. It connects to FalkorDB at start ([FalkorDB on first use](#falkordb-on-first-use)) and uses the graph named by `--org` or `STALEPROOF_ORG`, else the graph of the owner of the repository each call is about (as `check` does). `check_pull_request`, `impact` and `clearance` index the pull request's repository into that graph the first time they see it; `audit_docs` and `docs_for_symbol` index the repositories named in `repos`, and `check_changes` the repository it checks (named in `repo`, or the `origin` of the checkout in `dir`, default the directory the server runs in). [MCP server](mcp.md) covers clients, tools, the hosted server and security.

### `lsp`

Serve the [language server](editors.md) on stdin and stdout, for editors: diagnostics for the docs pages, READMEs, AI agent files and docstrings open in the editor (re-checked from the unsaved text 300 ms after the last edit), verified fixes and "ignore this rule here" as code actions, hover and go to definition from a docs code span to the code, and "documented in N places", find references and a code lens from the code to the docs. Reads the files, git and the parse cache (`.staleproof/cache`); needs no FalkorDB and sends nothing anywhere.

```text
staleproof lsp [--stdio]
```

**Example.** Neovim 0.11:

```lua
vim.lsp.config('staleproof', { cmd = { 'staleproof', 'lsp' }, filetypes = { 'markdown', 'python', 'typescript' }, root_markers = { '.git' } })
vim.lsp.enable('staleproof')
```

**Prints.** Stdout carries the protocol; anything else goes to stderr. Each workspace folder is linted once at start (like `lint`), then again in the background after a save or a file change. The VS Code extension, other editors' setup and the server's commands (`staleproof.fixAll`, `staleproof.audit`) are in [Editors](editors.md).

**Exit status.** 0 after the client's `shutdown` and `exit`; 1 when the client exits without `shutdown`.

### `serve`

Serve the web UI and the HTTP API.

```text
staleproof serve [--port <port>] [--host <host>] [--preload <urls...>] [--hosted]
```

| Option | Default | Meaning |
|---|---|---|
| `--port <port>` | `PORT`, else `8080` | Port to listen on. |
| `--host <host>` | `HOST`, else `127.0.0.1` | Interface to bind. `0.0.0.0` accepts connections from other machines. |
| `--preload <urls...>` | `STALEPROOF_PRELOADED` (comma-separated), else falkordb-py #262, #267 and #276 | Pull requests listed on the home page. |
| `--hosted` | off, unless `STALEPROOF_HOSTED=on` | Hosted mode, as on staleproof.dev: a pull request in any public repository the served graph does not hold is downloaded and indexed on demand into a workspace graph of its owner (`gh-<owner>`). See [Deploy](DEPLOY.md#hosted-mode). |

**Example.**

```bash
npx -y staleproof serve --host 0.0.0.0 --port 8080
```

**Prints.** On stderr, `staleproof serve: http://<host>:<port> (graph "<org>", agent on, <model>; MCP at /api/mcp)`, with `, hosted: any public repository on demand` after the graph in hosted mode, and `agent off: no model credentials, graph mode only` when no model credentials are found. Agent mode is on when `ANTHROPIC_API_KEY` or another credential the Anthropic SDK finds is present.

**Notes.** It connects to FalkorDB before it listens ([FalkorDB on first use](#falkordb-on-first-use)). The server runs one check at a time and queues the rest. It serves MCP over Streamable HTTP at `/api/mcp`. Its POST endpoints other than `/api/mcp` are rate-limited per client (30 an hour) and it has no authentication. An agent check in the server has no time limit unless `STALEPROOF_CHECK_BUDGET_MS` is set (it defaults to 240 seconds on Vercel). See [HTTP API](http-api.md) and [Deploy](DEPLOY.md).

### `facts`

Compute every number Staleproof quotes from the graph and write it as Markdown.

```text
staleproof facts [--out <file>] [--json]
```

| Option | Default | Meaning |
|---|---|---|
| `--out <file>` | `docs/FACTS.md` | Output file, relative to the current directory. The directory must exist. |
| `--json` | off | Print the facts as JSON instead of writing Markdown. |

**Example.**

```bash
npx -y staleproof facts --out FACTS.md
```

**Prints.** `wrote <file>` on stderr. The file lists the repositories, node and edge counts, resolution quality, dependencies between repositories, sample cross-repository paths, the pull requests checked, the grep baseline per pull request, the example runs (the latest attempt of each) and the impact query's server-side timing. [Facts from the graph](FACTS.md) is this file for FalkorDB's repositories.

### `db`

Run a local FalkorDB without Docker, from the redis-server and FalkorDB module binaries in the `falkordblite` Python wheel.

```text
staleproof db [--port <port>] <start|stop|status>
```

| Option | Default | Meaning |
|---|---|---|
| `--port <port>` | `6379` | Port to start, stop or check. |

**Examples.**

```bash
npx -y staleproof db start
npx -y staleproof db status
npx -y staleproof db stop --port 6390
```

**What it does.** Runs `bash scripts/falkordb-local.sh <action> <port>` from the package. The first use installs `falkordblite==0.10.0` (override with `FALKORDBLITE_VERSION`) into `$STALEPROOF_HOME/falkordb/venv` with uv, or with `python3 -m venv` and pip when uv is missing; the wheel needs Python 3.12 or newer. `start` launches a daemonised server bound to `127.0.0.1`, keeping RDB snapshots in `$STALEPROOF_HOME/falkordb/data-<port>` (saved every 60 seconds after a change, and on `stop`).

**Prints.** `falkordb-local: running on port <port> (data: <dir>)`, `falkordb-local: already running on port <port>`, `falkordb-local: stopped port <port>`, `falkordb-local: nothing running on port <port>`, or for `status`, `running on port <port>` or `not running on port <port>` (exit status 1). When the script fails, the CLI prints `staleproof: Command failed: bash …` and exits with 1. The undocumented action `bin` prints the directory holding `redis-server` and `redis-cli`.

**Notes.** The scratch server that examples run against is started with the same script on port 6390, unless `STALEPROOF_SCRATCH_URL` names another server.

## Environment variables

The variables most commands read. [Configuration](configuration.md) lists all of them.

| Variable | Default | Used for |
|---|---|---|
| `FALKORDB_URL` | `falkor://localhost:6379` | The graph's server (`--db`). |
| `STALEPROOF_ORG` | the owner of the repository the command is about, else `falkordb` | The graph name (`--org`). |
| `STALEPROOF_HOME` | `~/.staleproof` | Clones, downloaded tarballs, the GitHub response cache, virtualenvs, the local FalkorDB. |
| `GITHUB_TOKEN`, else `GH_TOKEN` | none | GitHub API requests (60 an hour without a token), clones, tarball downloads and file reads, so private repositories work; required by `patch --open-pr`. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `STALEPROOF_MODEL`, `STALEPROOF_EFFORT` | none, none, `claude-sonnet-5-5`, `medium` | Agent mode. |
| `STALEPROOF_SCRATCH_URL`, `STALEPROOF_SCRATCH_PORT` | none, `6390` | The disposable FalkorDB examples run against. A URL with credentials is refused. |
| `STALEPROOF_RUN_TIMEOUT_MS` | `30000` | Timeout for each example run. |

## Related

- [Quickstart](getting-started.md)
- [Configuration](configuration.md)
- [Tools reference](tools.md)
- [GitHub Action](github-action.md)
- [Troubleshooting and FAQ](troubleshooting.md)
- [Fix stale docs](fix.md)
- [Editors (LSP)](editors.md)
- [Release gate](release.md)
