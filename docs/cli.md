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

## Install or run with npx

| How | Command | Notes |
|---|---|---|
| No install | `npx -y staleproof <command>` | `-y` answers npx's install prompt. Pin a version for repeatable runs: `npx -y staleproof@0.2.0 <command>`. |
| Global install | `npm install -g staleproof`, then `staleproof <command>` | Puts `staleproof` on your `PATH`. |
| From a clone | `npm install && npm run build`, then `node dist/cli.js <command>` | Or `npm run dev -- <command>` to run the TypeScript source. |

All three need Node.js 20 or newer. The package carries the built web UI, the tree-sitter Python grammar, the sandbox shim and `scripts/falkordb-local.sh`. Examples on this page use `npx -y staleproof`; with a global install, drop `npx -y`.

## Global options

| Option | Default | Meaning |
|---|---|---|
| `--org <org>` | `STALEPROOF_ORG`, else the owner of the repository the command is about, else `falkordb` | The organisation, which names the graph (one graph per organisation). The value is turned into a slug: trimmed, lowercased, every run of characters other than `a-z`, `0-9`, `_` and `-` replaced by `-`. An empty result fails with `invalid org name`. |
| `--db <url>` | `FALKORDB_URL`, else `falkor://localhost:6379` | The FalkorDB server holding the graph. `falkor://` and `redis://` connect in plain TCP, `falkors://` and `rediss://` with TLS; credentials go in as `user:password@`. |
| `-V`, `--version` | | Print the package version. |
| `-h`, `--help` | | Print help. `staleproof <command> --help` or `staleproof help <command>` shows one command. |

Global options work before or after the command: `staleproof --org encode check …` and `staleproof check … --org encode` are the same. Results go to stdout; progress and log lines go to stderr, so you can pipe `--json` output safely.

**The default graph.** Without `--org` or `STALEPROOF_ORG`, a command uses the graph of the owner of the repository it is about, slugged: `check https://github.com/encode/httpx/pull/<n>` reads the graph `encode`, and FalkorDB's repositories land in `falkordb`. The repository is the first one given to `index`, the pull request's for `check` and `patch`, the example id's for `run`, and the first `--governs` id's for `decide`. `mcp`, `serve`, `verdict` and `facts` name no repository and use `falkordb`. Pass `--org` when one graph holds repositories of several owners.

### FalkorDB on first use

Every command except `db` connects to FalkorDB. When neither `--db` nor `FALKORDB_URL` is set and nothing answers on `localhost:6379`, it first starts a local server there, the same one as `db start` (falkordblite, installed into `$STALEPROOF_HOME/falkordb/venv` on first use, which takes a minute), logs `No FalkorDB on localhost:6379: starting a local one (falkordblite; the first start installs it, which takes a minute).` on stderr, and leaves it running. With `--db` or `FALKORDB_URL` set, an unreachable server is an error: `cannot reach FalkorDB at <url>: …`.

## Exit status

| Status | When |
|---|---|
| `0` | The command finished. |
| `1` | Any error. The message is printed to stderr as `staleproof: <message>`. Typical causes: an invalid pull request URL, a repository not indexed in the graph, FalkorDB unreachable (`cannot reach FalkorDB at <url>: …`), missing model credentials, the GitHub API rate limit, an invalid `STALEPROOF_EFFORT`. |
| `1` | `check` in agent mode, when the check ends with status `error` or `refused`. The output is printed and the check is stored first. `done` and `incomplete` exit `0`. |
| `1` | `check --no-agent --format markdown`, when the stored check ends with status `error`. The comment is written first. |
| `1` | `db status`, when no server answers on the port. |

`check --no-agent` without `--format markdown` exits `0` even when the stored check ends with status `error` (for example when the impact query fails after the pull request was read); the summary line says so.

## Ids

Commands and tools refer to graph nodes by id:

| Node | Format | Example | Where to find it |
|---|---|---|---|
| Symbol | `<owner>/<repo>:<qualname>` | `FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__` | The qualified names in "Changed symbols" and in evidence paths; prefix the repository. |
| DocSection | `<owner>/<repo>:<path>#<anchor>` | `FalkorDB/docs:commands/graph.explain.mdx#<anchor>` | Impact results (`check --json`, MCP `impact`). The anchor is the heading's slug; the text before a file's first heading has an empty anchor (the id ends in `#`). |
| CodeExample | `<owner>/<repo>:<path>:<index>` | `FalkorDB/docs:commands/graph.explain.mdx:0` | Impact results (`examples` on each section) and `read_section`. `index` is the block's 0-based position among all fenced blocks in the file, whatever their language. An example script file has index `0`. |
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

**What it does.** Each repository is cloned blob-less over HTTPS into `<STALEPROOF_HOME>/repos/<owner>/<name>` the first time and fetched afterwards, then checked out at the ref; with `GITHUB_TOKEN` (or `GH_TOKEN`) set, git sends the token to github.com, so private repositories the token can read work too. When git is not installed, or with `STALEPROOF_INGEST=github`, each repository is downloaded as a tarball instead and only the files the indexer reads are extracted, into `<STALEPROOF_HOME>/tarballs/<owner>/<name>/<sha>` ([details](indexing.md#without-git-tarballs)). Python files are parsed with tree-sitter, calls are resolved across every repository in the command, Markdown/MDX pages become doc sections and code examples linked to the code they mention or call, and dependencies between the repositories are read from `pyproject.toml` and `requirements*.txt` files and from the docs' imports. [Indexing](indexing.md) has the rules.

**Prints.** On stderr, `checkout  <repo>` per repository, then one line per phase (`parse`, `write`, `resolve`, `docs`, `done`). On stdout, `Indexed <n> repositories into graph "<org>" in <s>s`, then one line per repository (commit, symbols, calls and how many cross repositories, parse errors if any), one line per repository with docs (sections, examples, uses, mentions, links) and one line per dependency, for example `FalkorDB/GraphRAG-SDK → FalkorDB/falkordb-py (declares falkordb)`.

With `--json`: `{org, run, repos: [{repo, sha, files, symbols, calls: {exact, byName, crossRepo}, gone, parseErrors}], docs: [{repo, pages, sections, examples: {total, python}, mentions, uses: {exact, byName}, links, gone}], dependsOn: [{from, to, spec}], ms}`.

**Notes.**

- Index related repositories in one command. Calls and doc links cross repositories only among the repositories of one run; indexing a repository alone re-resolves its edges against itself and drops the cross-repository ones.
- Re-indexing updates nodes in place. Symbols, sections and examples that disappeared are marked `gone`, never deleted, so decisions and verdicts keep pointing at them. Links that an earlier pull request check added for removed symbols (`late` links) are dropped and not recreated.
- Without git, `--ref` must be a branch, tag or commit SHA that GitHub knows; `origin/<branch>` names a ref in a git clone only.
- Private repositories need `GITHUB_TOKEN` (or `GH_TOKEN`) with read access to them.
- The graph defaults to the owner of the first repository: `index encode/httpx` writes `encode`.

### `check`

Check a pull request against the graph: with the agent (default) or in graph mode (`--no-agent`), as terminal text, JSON or a pull request comment.

```text
staleproof check [options] <pr-url>
```

**Arguments.** `<pr-url>`: `https://github.com/<owner>/<repo>/pull/<n>` (a trailing `/files`, query or fragment is accepted) or `<owner>/<repo>#<n>`. When the graph does not have the repository yet, it is indexed first ([below](#check)), unless `--no-index` is given. Owner and name are case-insensitive: the URL is rewritten to the repository's indexed spelling.

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

**The four invocations.**

| Invocation | What runs | What it stores |
|---|---|---|
| `check <pr>` | The agent loop: the model calls the tools until every impacted section has a verdict or an edit. | A Check node with the full trace, verdicts, example runs. |
| `check <pr> --no-agent` | Graph mode: `impact`, `clearance`, `rank_sections` over the first impact page, then `run_example` for at most `--runs` examples on sections whose evidence path is `exact`. | A Check node (model `graph-only (no model)`) with the trace and runs. No verdicts. |
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
<pull request title>
<url> (<state>, <before>..<after>)

Changed symbols (<n>)
  <change>       <qualname>

Impacted doc sections (<total>)
  <BREAKING|SIGNATURE|BEHAVIOR> <heading> [<repo>] (other repo)
    path: <changed symbol> ← <caller> ← <doc>
    <hops> hops, <exact|by-name|late>, <k> example(s) · <url>

Cleared: reach no doc within 3 hops (<m>)
  ✓ <qualname> (<change>; <t> raw text matches in docs; check: git grep -nw <name> -- '*.md' '*.mdx')

<example id>
<example url>

FAIL before <repo@sha, …>
  <traceback>

PASS after <repo@sha, …>

<summary>
Stored as chk-<id>.
```

Sections are ordered by the PageRank of their page in the docs' link graph. Only the first 40 are listed, followed by `… <n> more` when there are more. A pull request that already edits docs adds a line `This PR already edits: <paths>`. A run answered from the graph is marked `(recorded)`.

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

**Prints, `--format markdown`.** The report the GitHub Action posts as its comment, on stdout or into `--out`: the title (what broke first), the impact summary, a table of the examples run before and after the pull request, the impacted sections with their evidence paths, the cleared symbols, the verdicts and, in agent mode, the agent's summary. [GitHub Action](github-action.md#the-comment) shows the format.

**JSON.** `{checkId, pr, status, summary, events, impacted, missing, toolOrder, since}`. `events` holds every trace event, including each tool's full result in `tool_result.data`. In graph mode `impacted` and `missing` are empty; read the sections from the `impact` result in `events`.

**Notes.**

- The first check of a pull request reads its metadata from GitHub and diffs it into symbol-level changes. For a merged pull request the commits compared are the merge commit's first parent and the merge commit; for an open one, the merge base and the head. The diff is never redone: re-checking an open pull request after new pushes reuses the first diff.
- Agent mode needs model credentials: `ANTHROPIC_API_KEY` (or another credential the Anthropic SDK finds) for Claude, or `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and `STALEPROOF_MODEL` for an Anthropic-compatible provider. Without them it stops with an error naming those variables. See [The agent](agent.md).
- The CLI puts no time limit on an agent check. A large pull request takes minutes: a 43-section check takes about 6 minutes.
- Graph mode samples: it ranks the first impact page and runs at most `--runs` examples. It never judges sections or writes verdicts.
- Two kinds of change are reported more broadly than they happened. A moved or renamed file reports every definition in it as removed and added. A module that stops importing a name from its own package reports that name as a removed export (`BREAKING`), even when the import was not a public re-export.

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
staleproof patch [--out <file>] [--open-pr [--upstream]] <pr-url>
```

| Option | Default | Meaning |
|---|---|---|
| `--out <file>` | stdout | Write the diff to `<file>` and the title and description to `<file>.md`. |
| `--open-pr` | off | Open the fix as a pull request, one per docs repository. Needs `GITHUB_TOKEN` (or `GH_TOKEN`). |
| `--upstream` | off | With `--open-pr`: open it against the original repository instead of inside your fork. |

**Examples.**

```bash
npx -y staleproof patch https://github.com/FalkorDB/falkordb-py/pull/267
npx -y staleproof patch https://github.com/FalkorDB/falkordb-py/pull/267 --out docs-267.diff
npx -y staleproof patch <pr-url> --open-pr
```

**Prints.** The diff, or `(no proposed edits)`, then `# docs: update for <repo>#<number> (<pull request title>)` and the description: per edited section, the reason, the evidence path, the example runs and the cited decisions; then the sections checked and left unchanged with their verdicts; then any edit that could not be applied. With `--out`, it writes the two files and logs `wrote <file> and <file>.md (<n> files)` on stderr. With `--open-pr`, it prints `opened <url> (fork)` or `opened <url> (upstream)` per docs repository.

**Notes.**

- The patch uses the latest verdict on each section from any check, MCP client or API call. An edit is a `stale` verdict with replacement text that a maintainer has not rejected. Graph mode writes no verdicts, so a graph-mode check alone gives an empty patch.
- Each file is read at the commit the graph indexed, from the local clone when there is one, otherwise from `raw.githubusercontent.com`. An edit whose section changed since indexing, or whose file is missing at that commit, is not applied and is listed instead. Sections longer than 8,000 characters always conflict, because the graph stores only their first 8,000 characters.
- Diff paths are relative to each docs repository. When the patch spans several repositories, apply each file's part in its own repository with `git apply`, or use `--open-pr`.
- `--open-pr` forks each docs repository into your account (always, even with `--upstream`), syncs the fork, creates or resets the branch `staleproof/<owner>-<repo>-<number>` (named after the code pull request) at the indexed commit, commits each edited file, and opens the pull request. It fails with `opening a pull request needs GITHUB_TOKEN` without a token and with `the patch is empty: no proposed edits to open a pull request for` when there is nothing to open.
- Fails with `<url> has not been checked` for a pull request the graph has never read.

### `mcp`

Serve the tools over the Model Context Protocol on stdio.

```text
staleproof mcp
```

**Example.**

```bash
claude mcp add staleproof -- npx -y staleproof mcp
```

**Prints.** On stderr, `staleproof mcp: serving graph "<org>" from <url>` (or `serving each repository's owner graph`) with any password masked, and `staleproof: <message>` lines while it indexes. Stdout carries the protocol. It connects to FalkorDB at start ([FalkorDB on first use](#falkordb-on-first-use)) and uses the graph named by `--org` or `STALEPROOF_ORG`, else the graph of the owner of the repository each call is about (as `check` does). `check_pull_request`, `impact` and `clearance` index the pull request's repository into that graph the first time they see it. [MCP server](mcp.md) covers clients, tools, the hosted server and security.

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
