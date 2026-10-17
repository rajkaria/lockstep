# Troubleshooting and FAQ

This page explains the error messages you can meet when running `staleproof` (each with what it means and how to fix it), the FalkorDB version behaviour the queries are written around, the limits of what the tool does today, and answers to the questions developers ask most. It is for anyone using the CLI, the server, the MCP tools or the library. Messages are quoted as the code writes them; `<...>` marks a value that varies.

## Common errors

The CLI prints errors as `staleproof: <message>` and exits with code 1. The HTTP API returns them as `{"error": "<message>"}`, tools return them as error results, and failed example runs record them as the run's reason.

### Setup and configuration

#### FalkorDB is not reachable

```text
cannot reach FalkorDB at <url>: <message>
Start one locally with `npx staleproof db start` (or scripts/falkordb-local.sh start), or set FALKORDB_URL.
```

Nothing answered at `FALKORDB_URL` (or `--db`) within 5 seconds, or the credentials were refused. The password in `<url>` is shown as `***`. With neither of them set, CLI commands start a local server on `localhost:6379` instead of failing, so from the CLI this error means a URL you configured did not answer, or the local server did not come up. Fix the URL (`falkors://` for TLS endpoints, the password URL-encoded; [URL forms](configuration.md#graph-and-organisation)), or unset it to use the local server. After a connection drops, the client retries four times and then reports `FalkorDB unreachable`.

When the automatic start itself fails, the command stops, after the script's own message ([Local FalkorDB does not start](#local-falkordb-does-not-start)), with:

```text
could not start a local FalkorDB (see above). Start one yourself, e.g. docker run -d -p 6379:6379 falkordb/falkordb, or set FALKORDB_URL to a FalkorDB you have.
```

#### A query failed

`FalkorDB <query name> failed on graph "<graph>": <message>`

FalkorDB rejected or failed a statement; `<query name>` is the name in [Graph model and Cypher](GRAPH-MODEL.md), or `adhoc` for unnamed statements. Check the server version ([version notes](#falkordb-version-notes)) and that the server has the FalkorDB module loaded.

#### Invalid organisation name

`invalid org name: "<name>"`

`--org` or `STALEPROOF_ORG` contains no letter, digit, `_` or `-` (an empty `STALEPROOF_ORG` also gives this). Names are slugged: `Acme Inc` becomes the graph `acme-inc`.

#### Invalid effort

`STALEPROOF_EFFORT must be one of low, medium, high, xhigh, max`

The variable is checked when the configuration loads, so this stops every command except `db`, even with `--effort` on the command line. Fix or unset the variable. `check --effort` itself is not checked locally: an unknown value is sent to the model API as is, and if the API rejects it the check ends with `error`.

#### Scratch URL with credentials

`STALEPROOF_SCRATCH_URL must not carry credentials: docs examples connect to the scratch server without a password`

Docs examples connect to `localhost:6379` without a password, so the scratch server cannot require one. Because the configuration loads in every command, this stops all of them except `db`. Point `STALEPROOF_SCRATCH_URL` at an unauthenticated server on a private network, or unset it to use the managed local server on port 6390. A value that cannot be parsed at all gives `invalid STALEPROOF_SCRATCH_URL: <url>`.

#### Broken installation

`tree-sitter-python.wasm not found (expected in <package>/grammars/)` (or `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`)

A grammar is missing from the package, which happens with a partial install or a copied `dist/` without `grammars/`. Reinstall the package; in a custom image, copy `grammars/` and `python/` next to `dist/`.

#### Local FalkorDB does not start

```text
falkordb-local: need uv (https://docs.astral.sh/uv/) or Python 3.12+ to install falkordblite; or run FalkorDB in Docker: docker run -d -p 6379:6379 falkordb/falkordb
falkordb-local: falkordblite needs Python 3.12+ (python3 is <version>): install uv (https://docs.astral.sh/uv/), which fetches one, or run FalkorDB in Docker: docker run -d -p 6379:6379 falkordb/falkordb
```

`staleproof db start` (and the managed scratch server, and the local server a command starts when no FalkorDB is configured) installs the `falkordblite` wheel once, with uv or with `python3 -m venv` and pip. The wheel needs Python 3.12 or later: install uv, which fetches a Python 3.12, or run FalkorDB in Docker and leave `FALKORDB_URL` at its default.

`falkordb-local: server did not answer PING on port <port> — see <data>/redis.log`

The server did not come up within 5 seconds. The log usually says why, for example that the port is already in use. `staleproof db status --port <port>` reports whether a server is running there.

### Indexing

#### Not a repository name

`not a GitHub repository: "<input>" (expected owner/name or a github.com URL)`

`index` accepts `owner/name`, `https://github.com/owner/name[.git]` and `git@github.com:owner/name[.git]`.

#### git failed

`git <arguments> failed in <directory>: <git's error>`

Common causes:

- **A `--ref` git cannot check out.** The ref is passed to `git checkout --detach` unchanged. A bare branch name resolves to the clone's local branch, which fetching does not advance; use `origin/<branch>`, a tag or a SHA.
- **A private or missing repository.** Terminal prompts are disabled, so a private repository fails here unless `GITHUB_TOKEN` (or `GH_TOKEN`) is set to a token that can read it; git then sends it to github.com. Check the name, and the token's access.
- **No network.** Clones and fetches need github.com. Without git installed at all, indexing downloads tarballs instead (next section).

#### Tarball download failed

Without git, or with `STALEPROOF_INGEST=github`, repositories are downloaded as tarballs ([Indexing](indexing.md#without-git-tarballs)):

| Message | Meaning |
|---|---|
| `GitHub: <owner/repo>[@<ref>] not found (is it public? private repositories need GITHUB_TOKEN)` | GitHub answered 404: a wrong name or ref, or a private repository without a token that can read it |
| `GitHub: downloading <owner/repo> failed: <status>` | Any other failed download |
| `GitHub: the archive of <owner/repo> carries no commit id` | The archive had no pax header with the commit; nothing was indexed |
| `<owner/repo> is too large to index from an archive here (<what>; the limit is 150 MB and <n> files). Run Staleproof where git is installed (npx -y staleproof check <pr-url>, which clones instead) or in the GitHub Action.` | The archive is over 150 MB, or it has more than 4000 files the indexer reads (3000 on a hosted server). The CLI writes the same text, so where git is available, install it and index again |

#### Repository configuration error

`.staleproof.toml: ignore must be a list of glob strings` (or `skip-examples`, or `pyproject.toml: …`)

The repository's [configuration](configuration.md#repository-configuration) has a key with the wrong type, for example `ignore = "docs/old"` instead of `ignore = ["docs/old"]`. A file that is not valid TOML stops the index with the TOML parser's message. Fix the file in the repository and index again.

### Pull requests and GitHub

#### Not a pull request URL

```text
not a GitHub pull request URL: "<input>" (expected https://github.com/<owner>/<repo>/pull/<n>)
```

Accepted forms: `https://github.com/<owner>/<repo>/pull/<n>`, with an optional trailing `/files`, query or fragment, and `<owner>/<repo>#<n>`. Issue URLs, commit URLs and URLs of other hosts are refused. The HTTP API answers 400 for this.

#### Repository not indexed

```text
<owner/repo> is not indexed in the "<graph>" graph. Run: staleproof index <owner/repo> (plus the repositories that document it).
```

The pull request's repository is not in this graph, and the caller does not index on first use: `check --no-index`, `run --pr`, the library, or the check form and `POST /api/check` of `staleproof serve` without `--hosted`. `check`, both MCP servers and hosted servers index the repository themselves. Index it together with the repositories that document it, and check that the graph is the one you indexed into: the CLI and the stdio MCP server default to the graph of the repository's owner, `serve` to `STALEPROOF_ORG`, else `falkordb`.

#### GitHub rate limit

`GitHub API rate limit reached (60 requests/hour without a token; set GITHUB_TOKEN to raise it). It resets in <n> min.`

Unauthenticated GitHub API requests are limited per IP address. Set `GITHUB_TOKEN` (or `GH_TOKEN`). Ingesting a pull request costs one request with git and up to five without it (Vercel, or `STALEPROOF_INGEST=github`); merged pull requests are cached under `STALEPROOF_HOME`. With a token the message is `GitHub API rate limit reached. It resets in <n> min.` The reset time is left out when GitHub does not send it.

On a hosted server, whose token you cannot change, a check that hits the limit ends with the same message followed by `This shared server reads pull requests through GitHub's API, which limits it per hour. Until then, run the same check yourself (npx -y staleproof check <pr-url>) or add the GitHub Action: both use your own GitHub quota.`

#### Not found

`GitHub: <path> not found (a private repository needs GITHUB_TOKEN with read access)`

GitHub answered 404: the pull request number is wrong, the repository is private, or it was renamed. With a token the message is `GitHub: <path> not found`, and a private repository then means the token cannot read it. Other GitHub failures read `GitHub <METHOD> <path> failed: <status> <start of the response>`, and a failed file read reads `GitHub raw <path>@<sha7> failed: <status>`.

#### Merge commit without a parent

`merge commit <sha> has no parent`

The merge commit GitHub reports for the pull request has no parent to compare against. This is unusual; check the pull request on GitHub.

### Before a pull request

| Message | Meaning |
|---|---|
| `cannot tell which GitHub repository <dir> is (origin: <url>); pass --repo owner/name` | `staleproof check` without a pull request (or `check_changes` with `dir`) could not read a github.com `origin` remote (`origin: none` when there is none). Pass `--repo` (`repo` over MCP) |
| `<owner/repo> is not indexed in the "<graph>" graph: staleproof index <owner/repo>` | The working tree's repository is not in the graph and indexing on first use is off (`--no-index`) or not available |
| `repo (owner/name) is required with files` | `check_changes` with `files` but no `repo` |
| `send the changed files: files: [{path, content}] with repo (this server cannot read your disk)` | `check_changes` with `dir` (or with neither) on the hosted server or `staleproof serve`: only the stdio server reads a checkout |
| `No live symbol in the "<graph>" graph is named <symbol>.` | `docs-for` (or `docs_for_symbol`) found nothing: check the spelling, the graph (`--repo` or `--org`; a bare name with neither uses `falkordb`), and that the repository is indexed |
| `git <arguments> failed in <directory>: …` | The directory is not a git checkout, or `--base` names a ref that does not exist there ([git failed](#git-failed)) |

### Docs audit

| Message | Meaning |
|---|---|
| `not indexed in the "<graph>" graph: <repos>` | `audit --no-index`, or `audit_docs`, for repositories the graph does not hold. Drop `--no-index`, or index them |
| `unknown --format <x> (text, markdown or json)`, `--run must be a whole number, got <x>`, `--limit must be a whole number, got <x>`, `--fail-under must be a score from 0 to 100, got <x>` | A bad option value; nothing ran |
| `health score <s> is below --fail-under <n>`, `<n> example(s) no longer fit the code (--fail-on-mismatch)` | Not errors: the reason `audit` exits 1 after printing the report |
| `… Indexed by an older Staleproof: examples are not checked against the code until the repositories are indexed again (staleproof index).` | The graph was written before Staleproof 0.3, so it has no `MISMATCH` edges or export flags and the audit cannot judge the examples. Index the repositories again |
| A grey `docs health: not audited` badge | The server behind the badge URL has not indexed the repository. Audit it there once ([the page](https://staleproof.dev/#/audit)); the badge is cached for 5 minutes |
| `Could not open the audit issue (the job needs issues: write). The report is in the job summary.` | The GitHub Action's workflow lacks `permissions: issues: write` |

### Agent and models

#### Agent mode without credentials

```text
the agent needs model API credentials: set ANTHROPIC_API_KEY (or run `ant auth login`) for the Claude API, or ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY and STALEPROOF_MODEL for an Anthropic-compatible provider such as DeepSeek. Use `check --no-agent` to run the graph tools without a model.
```

`check` runs agent mode by default and found no credentials ([where it looks](configuration.md#model-agent-mode)). Set a key, or run `check --no-agent`. The same message with the API's own error appended in parentheses means the key was found but rejected; the check then ends with status `error`.

On the server, the equivalent is `409 {"error": "agent mode needs model API credentials on the server (ANTHROPIC_API_KEY); graph mode works without them", "agentUnavailable": true}` for `mode: "agent"`. Graph mode needs no credentials.

A hosted server also limits agent checks per day: `429 {"error": "today's hosted agent checks are used up; graph mode still works, and the agent runs anywhere with your own key (npx -y staleproof check <pr-url>)", "agentUnavailable": true}`. The count resets at midnight UTC.

#### A Claude model name on a compatible provider

```text
"claude-sonnet-5-5" is a Claude model name, but the model endpoint is an Anthropic-compatible provider, which would answer with its own model under that name; set STALEPROOF_MODEL to the provider's model (e.g. deepseek-v4-pro)
```

`ANTHROPIC_BASE_URL` points at a host other than `api.anthropic.com`, and the model name starts with `claude-` (here the default, because `STALEPROOF_MODEL` is unset). Set `STALEPROOF_MODEL` (or `--model`) to the provider's model, for example `deepseek-v4-pro`. The server still reports `agent.available: true` in this state, and every agent check fails with this message as an `error` event. If `ANTHROPIC_BASE_URL` is not a valid URL at all, the server treats it as a compatible provider and `GET /api/health` answers 500 (`Invalid URL`).

#### The check stopped early

These are summaries of checks that ended `incomplete`, not errors; the sections still open are listed in `missing`:

- `Stopped after 40 model turns with <n> impacted section(s) still open.` Raise the limit with `check --max-steps <n>` (the server always uses 40).
- `Stopped at this server's 240 s time limit after <n> model turns with <m> impacted section(s) still open; the CLI has no time limit.` The server's `STALEPROOF_CHECK_BUDGET_MS` (240 s by default on Vercel) ran out. Run large checks from the CLI.
- A check where the model finished with sections still open, after two reminders. Each reminder appears as a `nudge` event.

`The model declined to continue (<category>).` is the summary of a `refused` check: the model stopped with a refusal.

#### A tool call was cut off

`The check failed: a tool call was cut off at max_tokens; raise max_tokens and re-run the check`

A model turn hit its output limit (32,000 tokens) in the middle of a tool call. The CLI has no option for the limit; the library's `AnthropicModel` takes `maxTokens`. Re-running often succeeds, because the model chooses differently.

#### Errors the model sees and recovers from

These come back to the model as error results, so a check continues; they also appear in the trace and, over MCP, to your client:

| Message | Meaning |
|---|---|
| `unknown tool <name>` | The tool does not exist |
| `<tool> has no parameter <names>; its parameters are <list>` | An argument the tool does not declare. The agent loop and the MCP server both refuse it instead of dropping it |
| `invalid input for <tool>: <path>: <message>` (MCP: `invalid input: ...`) | The input failed the tool's schema; `give section_id or section_ids` is the `record_verdict` rule |
| `<pr> has not been checked yet; call impact first` | `run_example` with a `pr_url` the graph has not ingested. Call `impact` first; `staleproof run --pr` does it for you |
| `no code example <id>` | No example with that id (`owner/repo:path:index`) |
| `refused: no path in the graph from <pr>'s changes to <section>. Staleproof never edits a paragraph without a path; record_verdict instead if it needs no change.` | `propose_edit` on a section the pull request does not reach within 3 call hops |
| `new_text is identical to the current section; use record_verdict with ok` | The proposed edit changes nothing |
| `a governed verdict must cite the decision id(s)` | `record_verdict` with `governed` needs `cites` |
| `pr_url is required` | `propose_edit` or `record_verdict` without a pull request. In agent mode it defaults to the pull request under check; over MCP and in the library pass it |
| `no doc section <id> or pull request <pr> in the graph` | The section id or the pull request is unknown |
| `none of <ids> is a DocSection or Symbol id; decision not recorded` | `write_decision` (or `decide`, or `POST /api/decisions`) with no valid id in `governs` |

### Example runs

A run that cannot be prepared is recorded with status `error`, and `run_example` reports `The sandbox could not be prepared: <first line of the reason>`. Error runs are never answered from the cache, so the next request tries again.

#### Scratch server is the org server

```text
refusing to flush <host>:<port>: it is the server holding the org graph (FALKORDB_URL). Point STALEPROOF_SCRATCH_URL / STALEPROOF_SCRATCH_PORT at a separate server.
```

Every run starts by flushing the scratch database, and its host and port equal those of `FALKORDB_URL`. Staleproof refuses rather than delete your graph. Unset `STALEPROOF_SCRATCH_URL` to use the managed scratch server on port 6390, or point it at another server.

#### Install dependency conflict

```text
dependency conflict: <pin> requires <requirement>, which the other checkouts don't satisfy (installing <repo@sha>, <repo@sha>)
```

The repositories an example needs cannot be installed together at those commits. On FalkorDB's repositories, `graphrag-sdk==1.4.0` at its indexed commit requires `falkordb[hiredis]>=1.8.0,<2`, which the falkordb-py checkout under test does not satisfy, so three examples of falkordb-py#276 could not be run ([FACTS](FACTS.md#example-runs-sandbox)). The pull request is not to blame: it is version skew between the checkouts. There is nothing to fix in Staleproof; the agent records such sections as `skipped`. Other install failures read `installing <repo@sha, ...> failed:` followed by the end of the installer's output, and a failed virtualenv reads `uv venv failed: ...` or `python3 -m venv failed: ...`.

#### Network refused in the sandbox

`Staleproof sandbox: outbound network is disabled (tried <host>:<port>); only FalkorDB on localhost:6379 is available`

`Staleproof sandbox: DNS is disabled (<host>)`

The example tried to reach a server other than FalkorDB on `localhost:6379` (which the sandbox redirects to the scratch server). The run is recorded as `fail` with this error. Examples that call external services are not runnable here; when the code mentions `requests.get(`, `httpx.post(`, `boto3`, `neo4j` and similar, it is skipped before it runs with `calls an external service`.

#### Timeouts

A run that does not exit within `STALEPROOF_RUN_TIMEOUT_MS` (30 s by default) is killed and recorded as `timeout` with the reason `no exit after 30s`. Raise the variable for slow examples. Creating a virtualenv and installing into it have fixed limits of 300 s and 600 s.

#### Not executed on this host

`this deployment cannot execute examples (no git/uv sandbox runtime); runs recorded by other Staleproof hosts are answered from the graph`

The host lacks `git`, or both `uv` and `python3` (Vercel, for example). Recorded runs for the same program and commits are still answered. Run examples from a host that has them (`scripts/seed.sh`, `staleproof run`) to record them on the graph.

#### An async example fails with a SyntaxError

`SyntaxError: 'await' outside function`, or `'async with' outside async function`

Since 0.2.0, examples with a top-level `await`, `async with` or `async for` run on an event loop ([Async examples](example-runner.md#async-examples)). A run recorded before that has the same program and commits, so it is answered from the graph with its old error. Re-run it with `staleproof run <example-id> --pr <url> --fresh`.

#### Skipped runs

A skipped run is not an error: it says why the example cannot prove anything. The reasons are `not Python (<lang>)`, `empty example`, `needs an LLM provider (<match>); Staleproof does not hold provider keys`, `reads a local file the docs do not provide (<file>)`, `contains placeholders to fill in (e.g. "<your-host>")`, `waits for user input`, `calls an external service`, `uses no symbol from an indexed repository`, and `fragment: <error> (the page never defines it)` for a fragment that uses a name nothing on its page defines. [Example runner](example-runner.md) has the exact rules.

### Docs patch

#### Not checked

`<url> has not been checked`

`patch` (or `GET /api/patch`, or `docs_patch`) for a pull request the graph has never ingested. Run a check first.

#### No proposed edits

`patch` prints `(no proposed edits)` when no section has a `stale` verdict with new text that a maintainer has not rejected. Graph mode records no verdicts, so the patch of a graph-mode-only pull request is always empty. On falkordb-py #262, #267 and #276 the patch is empty too: every verdict the agent recorded on them is `ok`.

#### Edits not applied

The patch description lists them under "Not applied (file changed since indexing)", and the API under `conflicts`:

- `<path> changed since it was indexed at <sha7>`: the section's text at the indexed commit differs from the text the verdict was written against, usually because the docs repository was re-indexed after the check. Check the pull request again so the edit is proposed against the current text.
- `<path> not found in <repo>@<sha7>`: the file is missing at the indexed commit.
- A section longer than 8,000 characters always conflicts: its stored text is cut at 8,000 characters, so it never matches the file.

#### Opening the pull request

- `opening a pull request needs GITHUB_TOKEN`: set `GITHUB_TOKEN` or `GH_TOKEN`.
- `the patch is empty: no proposed edits to open a pull request for`: there is nothing to open.
- `fork <owner/name> did not become available`: GitHub did not finish creating the fork within 30 polls 2 seconds apart. Run the command again; the existing fork is reused.
- `--upstream and --in-repo are different targets: pick one`: pass one of them.
- `no pull request opened: no proposed edit is in a repository this token may write to`: with `--in-repo --only <repos>`, every proposed edit is in another repository. Open those with `patch --open-pr` from an account that can write to them.
- `Could not open the docs fix pull request (the job needs contents: write and pull-requests: write).`: the GitHub Action's `open-docs-pr` step, without those permissions (or on a branch the token cannot push to).

### Hosted service

These come from a server in hosted mode (staleproof.dev, `serve --hosted`): as an `error` event in the stream of `POST /api/check` or `POST /api/index`, as an MCP error result, or as `400 {"error": ...}` elsewhere. The limits are in [Deploy](DEPLOY.md#limits).

| Message | Meaning |
|---|---|
| `the hosted workspace gh-<owner> would hold <n> repositories (limit 4: <repos>). Run Staleproof yourself for bigger organisations: npx -y staleproof index <repos>` | A workspace holds at most 4 repositories, counting the ones already in it |
| `<repos> came to <mb> MB of graph, over the hosted limit of 20 MB. Run it on your own FalkorDB: npx -y staleproof check <pr-url>, or the GitHub Action.` | The indexed workspace was too big; it was dropped |
| `the hosted service is full right now. Run Staleproof on your own machine or in CI instead: npx -y staleproof check <pr-url>, or the GitHub Action.` | Evicting the least recently used workspaces did not bring the server under 70 MB |
| `the hosted service has indexed 500 workspaces today, its daily limit. Run it yourself: npx -y staleproof check <pr-url>` | The daily indexing budget is spent; it resets at midnight UTC |
| `gh-<owner> is being indexed by another request; try again in a minute` | Another request held the workspace's lock for more than 150 seconds |
| `<owner/repo> is in the curated "<graph>" graph, which the hosted service does not re-index; index other repositories on their own.` | `with` named repositories for a repository of the curated graph |
| `<owner/repo> is too large to index from an archive here (...)` | The archive is over 150 MB or has more than 3000 files the indexer reads ([above](#tarball-download-failed)) |
| `name a repository: pass a pull request URL (pr_url), repo or repos ("owner/name"), or ids that start with owner/repo:` | MCP: the call names no repository, so the hosted server cannot pick a graph |
| `<owner/repo> is not indexed yet: call check_pull_request with one of its pull requests first` | MCP: a tool that does not index on first use (for example `read_section` or `docs_patch`; the indexing ones are `check_pull_request`, `impact`, `clearance`, `check_changes`, `docs_for_symbol` and `audit_docs`) for a repository no workspace holds |
| `404 this server indexes from the CLI only: staleproof index <owner/repo>...` | `POST /api/index` on a server that is not in hosted mode |

### Server and web app

| Status and message | Meaning |
|---|---|
| `429 rate limited: try again later` | Over 30 POST requests from one client in the last hour ([rate limits](http-api.md#rate-limits)) |
| `404 no such check`, `no such section`, `no such verdict` | The id is unknown in this graph (in hosted mode, in every graph); check `--org` |
| `404 <owner/repo> is not indexed` | Hosted mode: `GET /api/patch` or `POST /api/decisions` for a repository no graph holds |
| `404 <owner/repo> is not indexed yet: POST /api/audit {"repo": "owner/name"} indexes and audits it` | `GET /api/audit` for a repository no graph holds (without hosted mode: `…: staleproof index <owner/repo>`) |
| `400 symbol required, e.g. ?symbol=Graph.query&repo=owner/name`, `400 repo required (owner/name), or a symbol id that starts with owner/repo:` | `GET /api/docs-for` without `symbol`, or in hosted mode without a repository |
| `400 id required` | `GET /api/sections` without `id`. `GET /api/patch` without `pr` answers `400 not a GitHub pull request URL: ""…` |
| `400 status must be accepted or rejected` | The review body needs `status` |
| `400 decision text is limited to 500 characters` | The HTTP API caps decision text; the CLI `decide` does not |
| `503 the Staleproof API is not connected to FalkorDB (<message>); set FALKORDB_URL` | Vercel only: the function cannot reach FalkorDB |

The CLI's `verdict` command reports `action must be accept or reject` and `no verdict <id>`.

The web app shows `the Staleproof API is unreachable and no snapshot is bundled` when the API fails and there is no snapshot for that page, and `Live checks need the Staleproof API connected to FalkorDB; this deployment is showing a snapshot. Run it locally: npx staleproof serve` when you try to run a check or record a decision in [snapshot mode](http-api.md#snapshot-mode).

## FalkorDB version notes

Staleproof has run on two FalkorDB versions: 4.18.3 (the falkordblite build that `staleproof db start` and the test suite use) and 4.22.0 (FalkorDB Cloud, where [FACTS.md](FACTS.md) was generated). Each has a traversal behaviour the queries are written around.

- **4.18.3: an unbound variable-length pattern can drop nodes.** When a node is reachable along two routes of different length, a pattern such as `(err)<-[:CALLS*0..3]-(t)` that binds no path variable can miss some of the callers. In GraphRAG-SDK, `RetrievalStrategy.search` calls `RetrieverError` directly and through `_validate`, and the pattern found 4 of the 6 callers. Clearance then used `WHERE NOT (pattern)` and "proved" a symbol undocumented while the docs' quickstart was three calls away. Binding the path (`MATCH p = (s)<-[:CALLS*0..3]-(t)`) gives the right answer on both versions, so every variable-length pattern in Staleproof binds one, and clearance counts bound paths (`OPTIONAL MATCH p = ... WITH count(p) AS reach WHERE reach = 0`) instead of using a pattern predicate.
- **4.22.0: an exact length of 2 or more toward a labelled node returns nothing.** For example `MATCH (:N {name: 'd'})<-[:R*2]-(t:N)` returns no rows on the chain `a->b->c->d`. No Staleproof query uses an exact length: every range starts at 0 or 1.

[test/traversal.test.ts](../test/traversal.test.ts) reproduces the GraphRAG-SDK shape and fails if any query reintroduces an unbound variable-length pattern or a range that does not start at 0 or 1. Follow the same two rules in your own Cypher.

Other version-dependent behaviour:

- `rank_sections` calls `algo.pageRank`; on any error it falls back to counting inbound links per page and reports `method: "in-degree"`.
- Between example runs the scratch server is cleared with `FLUSHALL` and `GRAPH.UDF FLUSH`; servers without UDF support reject the second command, and that error is ignored.
- `GET /api/health` reads the version with `MODULE LIST` and shows `unknown` when the server does not allow it.
- [docker-compose.yml](../docker-compose.yml) uses `falkordb/falkordb:latest` unless `FALKORDB_IMAGE` is set, so the version you get there has not been tested; pin `FALKORDB_IMAGE` for reproducible runs.

## Limits

Stated plainly; most are "not yet" rather than "never".

**What is analysed**

- **Python, TypeScript, JavaScript and Go code.** Python is read anywhere in a repository; TypeScript and JavaScript only inside a published npm package (a `package.json` with a `name`, not `private`); Go in every package under a `go.mod`. Other languages are not parsed, and notebooks are not read.
- **Argument checks follow each language.** TypeScript's optional, default and rest parameters are respected, and in JavaScript files every parameter is optional, so a JavaScript example is flagged for too many arguments only past a rest-free signature; overloads, decorators and functions that read `arguments` are not judged. Go examples are checked (variadic aware) but not run; JavaScript and TypeScript examples run in Node ([JavaScript and TypeScript](example-runner.md#javascript-and-typescript)).
- **reStructuredText is scanned, not built.** Titles, code directives (`code-block`, `testcode`, `doctest`, …), `::` literal blocks, `>>>` doctests, API roles and `:doc:`/`:ref:` links are read. `.. include::`, autodoc output (`.. autofunction::` and the like), substitutions and Sphinx extensions are not expanded, and `:ref:` resolves only to labels on the same page.
- **Static checks follow exact resolutions only.** An example call is judged only when it resolved through imports and types, to a function whose signature no unknown decorator wraps, on a class or module whose members are all visible, without `*args`/`**kwargs` splats. The rest is silent, so no mismatch and no predicted break is not proof that an example works; runs are.
- **Static call resolution.** Calls are resolved through imports, re-exports, attribute types, return annotations and base classes. Where the types do not say, a method call falls back to a by-name edge when 1 to 4 functions of that name exist in repositories the module imports; such edges are labelled `by-name` everywhere. Generic names (`get`, `run`, `close`, ...) are never matched by name.
- **Cross-repository resolution needs the repositories indexed together.** Edges between repositories are resolved only within one `index` command. Indexing a repository alone (including indexing on first use without `--with`, and the Action's `reindex` without `also-index`) drops its cross-repository edges until the organisation is indexed together again.
- **Re-index semantics.** A re-index re-resolves calls and doc links and marks vanished symbols and sections `gone`. It also removes the late links that pull request ingestion created for removed symbols, and already-ingested pull requests are not ingested again (unless an open one moves). The Action's `reindex` uses the remote default branch head, not the base branch.
- **Change detection.** `export-removed` is reported for any module that stops importing a name from its own package, not only `__init__.py`, so it can flag internal refactors. A moved or renamed file is reported as every definition removed and added, because renames are paired only within the same parent.
- **Private repositories need a token.** The CLI, a server you run and the GitHub Action read private GitHub repositories with `GITHUB_TOKEN` (the Action's default token reads its own repository). The hosted site, staleproof.dev, indexes public repositories only. Nothing outside GitHub is read.

**Runs**

- **The sandbox is a guard, not a security boundary.** The example refuses network connections and DNS at the Python socket level, runs with no inherited environment and a temporary HOME, and its process group is killed on timeout. The install step before it runs the repositories' build code with network access and an allow-listed environment (paths, locale, proxies, certificates, `UV_*`, `PIP_*`; [details](configuration.md#example-runner)), without `FALKORDB_URL`, model keys or `GITHUB_TOKEN`. Run it inside a container for untrusted code.
- **Runs use today's third-party dependencies.** The repositories are installed from source at the exact commits; their dependencies resolve at install time, so an old commit can fail for reasons unrelated to the pull request. A recorded run is reused for the same program and commits even if the dependencies have moved since; `staleproof run --fresh` re-runs it.
- **Without uv, Python is not pinned.** The fallback uses whatever `python3` is installed.
- **Graph mode samples.** It ranks the first impact page (up to 40 sections) and runs at most 3 exactly-linked examples on it. It writes no verdicts.

**Checks and patches**

- **Proposed edits are tested on fixtures, not shown on the live graph.** The agent proposing a docs fix with its evidence path is tested on the project's fixture organisation. On FalkorDB's own repositories, every verdict on falkordb-py #262, #267 and #276 is `ok`: those pull requests fixed code, and no edit was proposed.
- **Model paths.** The agent was written for Claude; the Claude API path is tested against a local fake API only. It has run on `deepseek-v4-pro` through DeepSeek's Anthropic-compatible API. The GitHub Action's pull request check has run end to end on a private test repository; the Docker image is written but has not been built.
- **An agent may edit an already-broken example only when it proved it.** Besides what a pull request falsified, the agent may fix an example that it ran and that fails both before and after the pull request, saying so in the reason and citing both runs. The path guard still applies: no edit without a path from the pull request's changes to the section.
- **Sections over 8,000 characters always conflict in the patch**, because their stored text is truncated.
- **The hosted service runs no examples.** Checks and audits on staleproof.dev and its MCP endpoint report impact, predicted breaks, clearance, ranking and the static checks; runs come from the GitHub Action, the CLI or a local MCP server.
- **Checks before a pull request are static.** `check` without a URL, `check_changes` and `docs-for` predict and trace; they run no example and record nothing.
- **Pull requests are re-read only when they move.** A later check reuses the stored diff unless the pull request is open and its head changed (or it was merged since); `impact` and the other tools alone never re-read it. The library's `ingestPullRequest` always re-ingests. The GitHub Action's default FalkorDB starts empty on every run, so there each run diffs the pull request afresh.
- **Verdicts written over MCP** have no check id, so no check counts them.
- **Verdict ids are not printed** in the CLI's text output or in the pull request comment; they are in the trace (`check --json`, `GET /api/checks/<id>`).
- **The HTTP API has no authentication**, and its rate limit is in memory, per process.

## FAQ

### Which languages does it support?

Code in Python, Go, and TypeScript and JavaScript in published npm packages; docs in Markdown, MDX and reStructuredText (Sphinx) from any repository. Python, JavaScript and TypeScript examples are linked to code, checked against its signatures and run; Go examples are linked and checked but not run. Other languages are not parsed.

### Do I need an LLM API key?

No. Indexing, graph-mode checks (`check --no-agent`), example runs, the patch, the MCP server and the HTTP API's graph mode need no key. Over MCP, your own client's model (Claude Code, for example) drives the tools. Only agent mode, where Staleproof's loop calls a model, needs credentials.

### Which models can run the agent?

The agent was written for Claude: the default model is `claude-sonnet-5-5`, with adaptive thinking and the server-side refusal fallback. It runs on any Anthropic-compatible API through `ANTHROPIC_BASE_URL`, sending only the portable request fields; the live demo runs `deepseek-v4-pro` through DeepSeek's Anthropic-compatible endpoint. The Claude path is tested against a local fake API only. Any model works through the library by implementing `ModelClient` ([library](library.md#agent-and-checks)).

### What does a check cost?

There is no published figure. Every agent check records the tokens it used: the CLI prints the total at the end, the `check_finished` event has `usage` (input, output, cache reads), and the `Check` node stores `input_tokens` and `output_tokens`. Multiply by your provider's prices. Spending is bounded by the turn limit (40 by default), the output limit per turn (32,000 tokens) and the size of each tool result handed back (24,000 characters). Graph mode uses no model and costs nothing beyond your FalkorDB and GitHub usage.

### What is sent to the model provider?

In agent mode: the system prompt, the tool definitions, the pull request URL, a one-sentence summary of what changed in the graph since the previous check (pull request URLs, counts, and the text of new decisions), and every tool result the model asks for. Tool results contain the text of doc sections and their code examples, symbol names and signatures, evidence paths, example run results (status, the last line of the error, the end of the traceback and of the output), and decisions with their text, author and source. All of it comes from the public repositories you indexed, plus what maintainers wrote into decisions. Your `GITHUB_TOKEN`, model key and other environment variables are never part of a tool result; example processes inherit no environment, and the install step that builds the repositories gets only an allow-list without those secrets. Graph mode sends nothing to a model.

### Does it open pull requests on its own?

No. A check writes verdicts and proposed edits to the graph only. `staleproof patch` prints the diff and the description; `patch --open-pr` opens the pull request, and only when you pass that flag: in your fork by default, against the original repository with `--upstream`, or as a branch of the docs repository itself with `--in-repo`. The GitHub Action posts or updates one comment, keeps one audit issue in audit mode, and opens a docs fix pull request into the checked pull request's branch only with `open-docs-pr: 'true'`.

### How long does a check take?

The impact query itself takes about 1 to 2 ms server-side on FalkorDB 4.22 ([FACTS](FACTS.md#impact-query-timing-server-side-falkordb)). The rest depends on the model and on example runs. A 43-section agent check takes about 6 minutes; the server on Vercel stops agent checks at 240 s, and the CLI has no time limit. Each example run is limited to 30 s by default, and the first run against a new set of commits also builds a virtualenv.

### Can I use private repositories?

Yes, with the CLI, a server you run and the GitHub Action. Set `GITHUB_TOKEN` (or `GH_TOKEN`) to a token that can read them: it is sent to the GitHub API, to `raw.githubusercontent.com` and, through git's environment configuration, to git clones of github.com ([how](configuration.md#github)). In the Action the workflow's default token already reads its own repository. The hosted site, staleproof.dev, indexes public repositories only.

### Do I need to set up FalkorDB?

No. The CLI starts a local FalkorDB (falkordblite) when no `FALKORDB_URL` is set and nothing answers on `localhost:6379`; the GitHub Action starts one inside the job; the website and the hosted MCP server bring their own. Set up your own only to keep one graph for a team, as in [Deploy](DEPLOY.md).

### Can one server hold several organisations?

Yes. Each organisation is its own graph on the same FalkorDB server, selected with `--org` or `STALEPROOF_ORG` (the CLI defaults to the repository's owner); a second graph built from encode/httpx sits next to `falkordb` on the same server. Graphs never share edges, verdicts or decisions. One `staleproof mcp` process, or `staleproof serve` without `--hosted`, serves one organisation; run one per organisation. `serve --hosted` answers for every owner from one process, indexing each into its own workspace graph on demand.

### How do I measure precision?

Review verdicts: `staleproof verdict accept <verdict-id>` or `verdict reject <verdict-id>` (with `--by <name>`), or `POST /api/verdicts/<id>/review`. Each review sets the verdict's `status`, `reviewed_by` and `reviewed_at`, and a rejected edit is left out of the patch. Verdict ids are in the check's trace: `check --json` or `GET /api/checks/<check-id>`, in the `tool_result` of `propose_edit` (`data.id`) and `record_verdict` (`data.ids`). Count reviews by verdict with Cypher:

```cypher
MATCH (v:Verdict) WHERE v.status IN ['accepted', 'rejected']
RETURN v.verdict AS verdict, v.status AS status, count(v) AS n ORDER BY verdict, status
```

The [library](library.md#run-your-own-cypher) shows how to run it from Node.js.

### Why FalkorDB?

Because the question is a graph traversal. Impact is a variable-length path from a changed symbol through callers in any repository to a doc section; clearance is the same pattern counted to zero, a proof that no doc is reachable; decisions govern symbols transitively through `CALLS*0..2` and resolve through `SUPERSEDES` chains; ranking runs PageRank over the docs' links. FalkorDB runs the impact query in about 1 to 2 ms server-side, and its multiple graphs per server give one graph per organisation. Every statement is in [Graph model and Cypher](GRAPH-MODEL.md).

### Does a re-check notice new commits on the pull request?

Yes, since 0.3.0. Before a check (`staleproof check`, `POST /api/check`, MCP `check_pull_request`) of an open pull request, Staleproof compares its head with the one it ingested; when it moved, the old diff is dropped and the current one is read, and the CLI logs `<pr> has new commits since it was last checked: reading its current diff`. `impact` and the other tools on their own reuse the stored diff, so start with a check. A merged pull request is never re-read. Example runs are still answered from recorded runs of the same program and commits; `staleproof run --fresh` re-runs one.

### Can I check changes before opening a pull request?

Yes, statically. `staleproof check` with no URL checks the working tree of the checkout you are in, and `--fail-on-predicted` makes it a pre-push hook; `staleproof docs-for <symbol>` lists the docs that depend on a function before you change it; over MCP, `check_changes` takes edited files and `docs_for_symbol` a symbol. They predict which examples break; running examples before and after needs the pull request ([CLI](cli.md#check-without-a-pull-request)).

### Why is an example I know is wrong not flagged?

The static checks report only what the source settles: a call reached by name rather than through imports and types, a function behind an unknown decorator, a class with an external base or a `__getattr__`, or a call with `*args`/`**kwargs` is left alone, and JavaScript calls get no argument checks ([the rules](indexing.md#static-checks-of-examples)). Run the example (`staleproof run <example-id>`, or `audit --run <n>`) to prove it, and check that it is not marked `skip` or matched by `skip-examples`.

## Related

- [Configuration](configuration.md): every variable and its default
- [Deploy](DEPLOY.md): hosts and the production checklist
- [Example runner](example-runner.md): the sandbox, skip rules and run outcomes
- [The agent](agent.md): the loop, its stop condition and model providers
- [HTTP API](http-api.md)
