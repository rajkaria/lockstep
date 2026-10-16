# Troubleshooting and FAQ

This page explains the error messages you can meet when running `lockstep-docs` (each with what it means and how to fix it), the FalkorDB version behaviour the queries are written around, the limits of what the tool does today, and answers to the questions developers ask most. It is for anyone using the CLI, the server, the MCP tools or the library. Messages are quoted as the code writes them; `<...>` marks a value that varies.

## Common errors

The CLI prints errors as `lockstep-docs: <message>` and exits with code 1. The HTTP API returns them as `{"error": "<message>"}`, tools return them as error results, and failed example runs record them as the run's reason.

### Setup and configuration

#### FalkorDB is not reachable

```text
cannot reach FalkorDB at <url>: <message>
Start one locally with `npx lockstep-docs db start` (or scripts/falkordb-local.sh start), or set FALKORDB_URL.
```

Nothing answered at `FALKORDB_URL` (or `--db`) within 5 seconds, or the credentials were refused. The password in `<url>` is shown as `***`. Start a local server with `npx -y lockstep-docs db start`, or fix the URL: `falkors://` for TLS endpoints, the password URL-encoded ([URL forms](configuration.md#graph-and-organisation)). After a connection drops, the client retries four times and then reports `FalkorDB unreachable`.

#### A query failed

`FalkorDB <query name> failed on graph "<graph>": <message>`

FalkorDB rejected or failed a statement; `<query name>` is the name in [Graph model and Cypher](GRAPH-MODEL.md), or `adhoc` for unnamed statements. Check the server version ([version notes](#falkordb-version-notes)) and that the server has the FalkorDB module loaded.

#### Invalid organisation name

`invalid org name: "<name>"`

`--org` or `LOCKSTEP_ORG` contains no letter, digit, `_` or `-` (an empty `LOCKSTEP_ORG` also gives this). Names are slugged: `Acme Inc` becomes the graph `acme-inc`.

#### Invalid effort

`LOCKSTEP_EFFORT must be one of low, medium, high, xhigh, max`

The variable is checked when the configuration loads, so this stops every command except `db`, even with `--effort` on the command line. Fix or unset the variable. `check --effort` itself is not checked locally: an unknown value is sent to the model API as is, and if the API rejects it the check ends with `error`.

#### Scratch URL with credentials

`LOCKSTEP_SCRATCH_URL must not carry credentials: docs examples connect to the scratch server without a password`

Docs examples connect to `localhost:6379` without a password, so the scratch server cannot require one. Because the configuration loads in every command, this stops all of them except `db`. Point `LOCKSTEP_SCRATCH_URL` at an unauthenticated server on a private network, or unset it to use the managed local server on port 6390. A value that cannot be parsed at all gives `invalid LOCKSTEP_SCRATCH_URL: <url>`.

#### Broken installation

`tree-sitter-python.wasm not found (expected in <package>/grammars/)`

The Python grammar is missing from the package, which happens with a partial install or a copied `dist/` without `grammars/`. Reinstall the package; in a custom image, copy `grammars/` and `python/` next to `dist/`.

#### Local FalkorDB does not start

`falkordb-local: need uv or python3 to install falkordblite`

`lockstep-docs db start` (and the managed scratch server) installs the `falkordblite` wheel once, with uv or with `python3 -m venv` and pip. Install uv or Python 3.12 or later.

`falkordb-local: server did not answer PING on port <port> — see <data>/redis.log`

The server did not come up within 5 seconds. The log usually says why, for example that the port is already in use. `lockstep-docs db status --port <port>` reports whether a server is running there.

### Indexing

#### Not a repository name

`not a GitHub repository: "<input>" (expected owner/name or a github.com URL)`

`index` accepts `owner/name`, `https://github.com/owner/name[.git]` and `git@github.com:owner/name[.git]`.

#### git failed

`git <arguments> failed in <directory>: <git's error>`

Common causes:

- **A `--ref` git cannot check out.** The ref is passed to `git checkout --detach` unchanged. A bare branch name resolves to the clone's local branch, which fetching does not advance; use `origin/<branch>`, a tag or a SHA.
- **A private or missing repository.** Clones are unauthenticated HTTPS with terminal prompts disabled, so a private repository fails here. Only public repositories are supported.
- **No network, or git not installed.** Indexing always needs git; there is no API fallback for it.

### Pull requests and GitHub

#### Not a pull request URL

```text
not a GitHub pull request URL: "<input>" (expected https://github.com/<owner>/<repo>/pull/<n>)
```

Accepted forms: `https://github.com/<owner>/<repo>/pull/<n>`, with an optional trailing `/files`, query or fragment, and `<owner>/<repo>#<n>`. Issue URLs, commit URLs and URLs of other hosts are refused. The HTTP API answers 400 for this on `POST /api/check` but 500 on `GET /api/patch`.

#### Repository not indexed

```text
<owner/repo> is not indexed in the "<graph>" graph. Run: lockstep-docs index <owner/repo> (plus the repositories that document it).
```

The pull request's repository is not in this graph. Index it together with the repositories that document it, and check that `--org` or `LOCKSTEP_ORG` names the graph you indexed into.

#### GitHub rate limit

`GitHub API rate limit reached (60/hour without a token). Set GITHUB_TOKEN to raise it.`

Unauthenticated GitHub API requests are limited per IP address. Set `GITHUB_TOKEN` (or `GH_TOKEN`). Ingesting a pull request costs one request with git and up to five without it (Vercel, or `LOCKSTEP_INGEST=github`); merged pull requests are cached under `LOCKSTEP_HOME`.

#### Not found

`GitHub: <path> not found (private repositories are not supported)`

GitHub answered 404: the pull request number is wrong, the repository is private, or it was renamed. Other GitHub failures read `GitHub <METHOD> <path> failed: <status> <start of the response>`, and a failed file read reads `GitHub raw <path>@<sha7> failed: <status>`.

#### Merge commit without a parent

`merge commit <sha> has no parent`

The merge commit GitHub reports for the pull request has no parent to compare against. This is unusual; check the pull request on GitHub.

### Agent and models

#### Agent mode without credentials

```text
the agent needs model API credentials: set ANTHROPIC_API_KEY (or run `ant auth login`) for the Claude API, or ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY and LOCKSTEP_MODEL for an Anthropic-compatible provider such as DeepSeek. Use `check --no-agent` to run the graph tools without a model.
```

`check` runs agent mode by default and found no credentials ([where it looks](configuration.md#model-agent-mode)). Set a key, or run `check --no-agent`. The same message with the API's own error appended in parentheses means the key was found but rejected; the check then ends with status `error`.

On the server, the equivalent is `409 {"error": "agent mode needs Claude API credentials on the server (ANTHROPIC_API_KEY); graph mode works without them", "agentUnavailable": true}` for `mode: "agent"`. Graph mode needs no credentials.

#### A Claude model name on a compatible provider

```text
"claude-sonnet-5-5" is a Claude model name, but the model endpoint is an Anthropic-compatible provider, which would answer with its own model under that name; set LOCKSTEP_MODEL to the provider's model (e.g. deepseek-v4-pro)
```

`ANTHROPIC_BASE_URL` points at a host other than `api.anthropic.com`, and the model name starts with `claude-` (here the default, because `LOCKSTEP_MODEL` is unset). Set `LOCKSTEP_MODEL` (or `--model`) to the provider's model, for example `deepseek-v4-pro`. The server still reports `agent.available: true` in this state, and every agent check fails with this message as an `error` event. If `ANTHROPIC_BASE_URL` is not a valid URL at all, the server treats it as a compatible provider and `GET /api/health` answers 500 (`Invalid URL`).

#### The check stopped early

These are summaries of checks that ended `incomplete`, not errors; the sections still open are listed in `missing`:

- `Stopped after 40 model turns with <n> impacted section(s) still open.` Raise the limit with `check --max-steps <n>` (the server always uses 40).
- `Stopped at this server's 240 s time limit after <n> model turns with <m> impacted section(s) still open; the CLI has no time limit.` The server's `LOCKSTEP_CHECK_BUDGET_MS` (240 s by default on Vercel) ran out. Run large checks from the CLI.
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
| `<pr> has not been checked yet; call impact first` | `run_example` with a `pr_url` the graph has not ingested. Call `impact` first; `lockstep-docs run --pr` does it for you |
| `no code example <id>` | No example with that id (`owner/repo:path:index`) |
| `refused: no path in the graph from <pr>'s changes to <section>. Lockstep never edits a paragraph without a path; record_verdict instead if it needs no change.` | `propose_edit` on a section the pull request does not reach within 3 call hops |
| `new_text is identical to the current section; use record_verdict with ok` | The proposed edit changes nothing |
| `a governed verdict must cite the decision id(s)` | `record_verdict` with `governed` needs `cites` |
| `pr_url is required` | `propose_edit` or `record_verdict` without a pull request. In agent mode it defaults to the pull request under check; over MCP and in the library pass it |
| `no doc section <id> or pull request <pr> in the graph` | The section id or the pull request is unknown |
| `none of <ids> is a DocSection or Symbol id; decision not recorded` | `write_decision` (or `decide`, or `POST /api/decisions`) with no valid id in `governs` |

### Example runs

A run that cannot be prepared is recorded with status `error`, and `run_example` reports `The sandbox could not be prepared: <first line of the reason>`. Error runs are never answered from the cache, so the next request tries again.

#### Scratch server is the org server

```text
refusing to flush <host>:<port>: it is the server holding the org graph (FALKORDB_URL). Point LOCKSTEP_SCRATCH_URL / LOCKSTEP_SCRATCH_PORT at a separate server.
```

Every run starts by flushing the scratch database, and its host and port equal those of `FALKORDB_URL`. Lockstep refuses rather than delete your graph. Unset `LOCKSTEP_SCRATCH_URL` to use the managed scratch server on port 6390, or point it at another server.

#### Install dependency conflict

```text
dependency conflict: <pin> requires <requirement>, which the other checkouts don't satisfy (installing <repo@sha>, <repo@sha>)
```

The repositories an example needs cannot be installed together at those commits. On FalkorDB's repositories, `graphrag-sdk==1.4.0` at its indexed commit requires `falkordb[hiredis]>=1.8.0,<2`, which the falkordb-py checkout under test does not satisfy, so three examples of falkordb-py#276 could not be run ([FACTS](FACTS.md#example-runs-sandbox)). The pull request is not to blame: it is version skew between the checkouts. There is nothing to fix in Lockstep; the agent records such sections as `skipped`. Other install failures read `installing <repo@sha, ...> failed:` followed by the end of the installer's output, and a failed virtualenv reads `uv venv failed: ...` or `python3 -m venv failed: ...`.

#### Network refused in the sandbox

`Lockstep sandbox: outbound network is disabled (tried <host>:<port>); only FalkorDB on localhost:6379 is available`

`Lockstep sandbox: DNS is disabled (<host>)`

The example tried to reach a server other than FalkorDB on `localhost:6379` (which the sandbox redirects to the scratch server). The run is recorded as `fail` with this error. Examples that call external services are not runnable here; when the code mentions `requests.get(`, `httpx.post(`, `boto3`, `neo4j` and similar, it is skipped before it runs with `calls an external service`.

#### Timeouts

A run that does not exit within `LOCKSTEP_RUN_TIMEOUT_MS` (30 s by default) is killed and recorded as `timeout` with the reason `no exit after 30s`. Raise the variable for slow examples. Creating a virtualenv and installing into it have fixed limits of 300 s and 600 s.

#### Not executed on this host

`this deployment cannot execute examples (no git/uv sandbox runtime); runs recorded by other Lockstep hosts are answered from the graph`

The host lacks `git`, or both `uv` and `python3` (Vercel, for example). Recorded runs for the same program and commits are still answered. Run examples from a host that has them (`scripts/seed.sh`, `lockstep-docs run`) to record them on the graph.

#### Skipped runs

A skipped run is not an error: it says why the example cannot prove anything. The reasons are `not Python (<lang>)`, `empty example`, `needs an LLM provider (<match>); Lockstep does not hold provider keys`, `reads a local file the docs do not provide (<file>)`, `contains placeholders to fill in (e.g. "<your-host>")`, `waits for user input`, `calls an external service`, `uses no symbol from an indexed repository`, and `fragment: <error> (the page never defines it)` for a fragment that uses a name nothing on its page defines. [Example runner](example-runner.md) has the exact rules.

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

### Server and web app

| Status and message | Meaning |
|---|---|
| `429 rate limited: try again later` | Over 30 POST requests from one client in the last hour ([rate limits](http-api.md#rate-limits)) |
| `404 no such check`, `no such section`, `no such verdict` | The id is unknown in this graph; check `--org` |
| `400 id required`, `pr required` | The query parameter is missing |
| `400 status must be accepted or rejected` | The review body needs `status` |
| `400 decision text is limited to 500 characters` | The HTTP API caps decision text; the CLI `decide` does not |
| `503 the Lockstep API is not connected to FalkorDB (<message>); set FALKORDB_URL` | Vercel only: the function cannot reach FalkorDB |

The CLI's `verdict` command reports `action must be accept or reject` and `no verdict <id>`.

The web app shows `the Lockstep API is unreachable and no snapshot is bundled` when the API fails and there is no snapshot for that page, and `Live checks need the Lockstep API connected to FalkorDB; this deployment is showing a snapshot. Run it locally: npx lockstep-docs serve` when you try to run a check or record a decision in [snapshot mode](http-api.md#snapshot-mode).

## FalkorDB version notes

Lockstep has run on two FalkorDB versions: 4.18.3 (the falkordblite build that `lockstep-docs db start` and the test suite use) and 4.22.0 (FalkorDB Cloud, where [FACTS.md](FACTS.md) was generated). Each has a traversal behaviour the queries are written around.

- **4.18.3: an unbound variable-length pattern can drop nodes.** When a node is reachable along two routes of different length, a pattern such as `(err)<-[:CALLS*0..3]-(t)` that binds no path variable can miss some of the callers. In GraphRAG-SDK, `RetrievalStrategy.search` calls `RetrieverError` directly and through `_validate`, and the pattern found 4 of the 6 callers. Clearance then used `WHERE NOT (pattern)` and "proved" a symbol undocumented while the docs' quickstart was three calls away. Binding the path (`MATCH p = (s)<-[:CALLS*0..3]-(t)`) gives the right answer on both versions, so every variable-length pattern in Lockstep binds one, and clearance counts bound paths (`OPTIONAL MATCH p = ... WITH count(p) AS reach WHERE reach = 0`) instead of using a pattern predicate.
- **4.22.0: an exact length of 2 or more toward a labelled node returns nothing.** For example `MATCH (:N {name: 'd'})<-[:R*2]-(t:N)` returns no rows on the chain `a->b->c->d`. No Lockstep query uses an exact length: every range starts at 0 or 1.

[test/traversal.test.ts](../test/traversal.test.ts) reproduces the GraphRAG-SDK shape and fails if any query reintroduces an unbound variable-length pattern or a range that does not start at 0 or 1. Follow the same two rules in your own Cypher.

Other version-dependent behaviour:

- `rank_sections` calls `algo.pageRank`; on any error it falls back to counting inbound links per page and reports `method: "in-degree"`.
- Between example runs the scratch server is cleared with `FLUSHALL` and `GRAPH.UDF FLUSH`; servers without UDF support reject the second command, and that error is ignored.
- `GET /api/health` reads the version with `MODULE LIST` and shows `unknown` when the server does not allow it.
- [docker-compose.yml](../docker-compose.yml) uses `falkordb/falkordb:latest` unless `FALKORDB_IMAGE` is set, so the version you get there has not been tested; pin `FALKORDB_IMAGE` for reproducible runs.

## Limits

Stated plainly; most are "not yet" rather than "never".

**What is analysed**

- **Python code only.** Code repositories are parsed as Python. Docs can be any Markdown or MDX. JavaScript and other non-Python examples are indexed but not linked to code and not run; notebooks and `.rst` files are not indexed.
- **Static call resolution.** Calls are resolved through imports, re-exports, attribute types, return annotations and base classes. Where the types do not say, a method call falls back to a by-name edge when 1 to 4 functions of that name exist in repositories the module imports; such edges are labelled `by-name` everywhere. Generic names (`get`, `run`, `close`, ...) are never matched by name.
- **Cross-repository resolution needs the repositories indexed together.** Edges between repositories are resolved only within one `index` command. Indexing a repository alone (including the Action's `reindex`) drops its cross-repository edges until the organisation is indexed together again.
- **Re-index semantics.** A re-index re-resolves calls and doc links and marks vanished symbols and sections `gone`. It also removes the late links that pull request ingestion created for removed symbols, and already-ingested pull requests are not ingested again. The Action's `reindex` uses the remote default branch head, not the base branch.
- **Change detection.** `export-removed` is reported for any module that stops importing a name from its own package, not only `__init__.py`, so it can flag internal refactors. A moved or renamed file is reported as every definition removed and added, because renames are paired only within the same parent.
- **Public repositories only.** Nothing private or login-protected is indexed.

**Runs**

- **The sandbox is a guard, not a security boundary.** The example refuses network connections and DNS at the Python socket level, runs with no inherited environment and a temporary HOME, and its process group is killed on timeout. The install step before it runs the repositories' build code with network access and an allow-listed environment (paths, locale, proxies, certificates, `UV_*`, `PIP_*`; [details](configuration.md#example-runner)), without `FALKORDB_URL`, model keys or `GITHUB_TOKEN`. Run it inside a container for untrusted code.
- **Runs use today's third-party dependencies.** The repositories are installed from source at the exact commits; their dependencies resolve at install time, so an old commit can fail for reasons unrelated to the pull request. A recorded run is reused for the same program and commits even if the dependencies have moved since; `lockstep-docs run --fresh` re-runs it.
- **Without uv, Python is not pinned.** The fallback uses whatever `python3` is installed.
- **Graph mode samples.** It ranks the first impact page (up to 40 sections) and runs at most 3 exactly-linked examples on it. It writes no verdicts.

**Checks and patches**

- **Proposed edits are tested on fixtures, not shown on the live graph.** The agent proposing a docs fix with its evidence path is tested on the project's fixture organisation. On FalkorDB's own repositories, every verdict on falkordb-py #262, #267 and #276 is `ok`: those pull requests fixed code, and no edit was proposed.
- **Model paths.** The agent was written for Claude; the Claude API path is tested against a local fake API only. It has run on `deepseek-v4-pro` through DeepSeek's Anthropic-compatible API. The GitHub Action and the Docker image are written but have not been exercised on a live repository or built.
- **An agent may edit an already-broken example only when it proved it.** Besides what a pull request falsified, the agent may fix an example that it ran and that fails both before and after the pull request, saying so in the reason and citing both runs. The path guard still applies: no edit without a path from the pull request's changes to the section.
- **Sections over 8,000 characters always conflict in the patch**, because their stored text is truncated.
- **`check --no-agent --format markdown`** renders the comment only: it stores no `Check` node and runs no examples. The Action uses it when it has no model key.
- **Pull requests are ingested once.** A later check reuses the stored diff; nothing in the CLI forces re-ingestion (the library's `ingestPullRequest` does).
- **Verdicts written over MCP** have no check id, so no check counts them.
- **Verdict ids are not printed** in the CLI's text output or in the pull request comment; they are in the trace (`check --json`, `GET /api/checks/<id>`).
- **The HTTP API has no authentication**, and its rate limit is in memory, per process.

## FAQ

### Which languages does it support?

Code repositories in Python; docs in Markdown and MDX from any repository; Python examples are linked to code and run. Other languages are on the roadmap ([VISION.md](../VISION.md) names TypeScript next), not in the code.

### Do I need an LLM API key?

No. Indexing, graph-mode checks (`check --no-agent`), example runs, the patch, the MCP server and the HTTP API's graph mode need no key. Over MCP, your own client's model (Claude Code, for example) drives the tools. Only agent mode, where Lockstep's loop calls a model, needs credentials.

### Which models can run the agent?

The agent was written for Claude: the default model is `claude-sonnet-5-5`, with adaptive thinking and the server-side refusal fallback. It runs on any Anthropic-compatible API through `ANTHROPIC_BASE_URL`, sending only the portable request fields; the live demo runs `deepseek-v4-pro` through DeepSeek's Anthropic-compatible endpoint. The Claude path is tested against a local fake API only. Any model works through the library by implementing `ModelClient` ([library](library.md#agent-and-checks)).

### What does a check cost?

There is no published figure. Every agent check records the tokens it used: the CLI prints the total at the end, the `check_finished` event has `usage` (input, output, cache reads), and the `Check` node stores `input_tokens` and `output_tokens`. Multiply by your provider's prices. Spending is bounded by the turn limit (40 by default), the output limit per turn (32,000 tokens) and the size of each tool result handed back (24,000 characters). Graph mode uses no model and costs nothing beyond your FalkorDB and GitHub usage.

### What is sent to the model provider?

In agent mode: the system prompt, the tool definitions, the pull request URL, a one-sentence summary of what changed in the graph since the previous check (pull request URLs, counts, and the text of new decisions), and every tool result the model asks for. Tool results contain the text of doc sections and their code examples, symbol names and signatures, evidence paths, example run results (status, the last line of the error, the end of the traceback and of the output), and decisions with their text, author and source. All of it comes from the public repositories you indexed, plus what maintainers wrote into decisions. Your `GITHUB_TOKEN`, model key and other environment variables are never part of a tool result; example processes inherit no environment, and the install step that builds the repositories gets only an allow-list without those secrets. Graph mode sends nothing to a model.

### Does it open pull requests on its own?

No. A check writes verdicts and proposed edits to the graph only. `lockstep-docs patch` prints the diff and the description; `patch --open-pr` opens the pull request, and only when you pass that flag: in your fork by default, against the original repository only with `--upstream`. The GitHub Action posts or updates one comment and never opens a pull request.

### How long does a check take?

The impact query itself takes about 1 to 2 ms server-side on FalkorDB 4.22 ([FACTS](FACTS.md#impact-query-timing-server-side-falkordb)). The rest depends on the model and on example runs. A 43-section agent check takes about 6 minutes; the server on Vercel stops agent checks at 240 s, and the CLI has no time limit. Each example run is limited to 30 s by default, and the first run against a new set of commits also builds a virtualenv.

### Can I use private repositories?

Not yet. Clones are unauthenticated HTTPS, and the GitHub client reports a 404 as `private repositories are not supported`. Private repositories are part of the hosted plan in [VISION.md](../VISION.md).

### Can one server hold several organisations?

Yes. Each organisation is its own graph on the same FalkorDB server, selected with `--org` or `LOCKSTEP_ORG`; a second graph built from encode/httpx sits next to `falkordb` on the same server. Graphs never share edges, verdicts or decisions. One `lockstep-docs serve` or `mcp` process serves one organisation; run one per organisation.

### How do I measure precision?

Review verdicts: `lockstep-docs verdict accept <verdict-id>` or `verdict reject <verdict-id>` (with `--by <name>`), or `POST /api/verdicts/<id>/review`. Each review sets the verdict's `status`, `reviewed_by` and `reviewed_at`, and a rejected edit is left out of the patch. Verdict ids are in the check's trace: `check --json` or `GET /api/checks/<check-id>`, in the `tool_result` of `propose_edit` (`data.id`) and `record_verdict` (`data.ids`). Count reviews by verdict with Cypher:

```cypher
MATCH (v:Verdict) WHERE v.status IN ['accepted', 'rejected']
RETURN v.verdict AS verdict, v.status AS status, count(v) AS n ORDER BY verdict, status
```

The [library](library.md#run-your-own-cypher) shows how to run it from Node.js.

### Why FalkorDB?

Because the question is a graph traversal. Impact is a variable-length path from a changed symbol through callers in any repository to a doc section; clearance is the same pattern counted to zero, a proof that no doc is reachable; decisions govern symbols transitively through `CALLS*0..2` and resolve through `SUPERSEDES` chains; ranking runs PageRank over the docs' links. FalkorDB runs the impact query in about 1 to 2 ms server-side, and its multiple graphs per server give one graph per organisation. Every statement is in [Graph model and Cypher](GRAPH-MODEL.md).

### Why did a re-check not notice new commits on the pull request?

A pull request is ingested on its first check and reused afterwards, so later commits are not diffed again. The CLI has no option to force it; call `ingestPullRequest` from the [library](library.md#pull-requests), which always re-ingests. Example runs are likewise answered from recorded runs of the same program and commits; `lockstep-docs run --fresh` re-runs one.

## Related

- [Configuration](configuration.md): every variable and its default
- [Deploy](DEPLOY.md): hosts and the production checklist
- [Example runner](example-runner.md): the sandbox, skip rules and run outcomes
- [The agent](agent.md): the loop, its stop condition and model providers
- [HTTP API](http-api.md)
