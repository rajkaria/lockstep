# HTTP API

`staleproof serve` runs one HTTP server with a JSON API, Server-Sent Events (SSE) streams for live checks and indexing, MCP over Streamable HTTP, and the web app. This page lists every route with its parameters, response fields, status codes, error bodies and rate limits, shows how to read the check stream from code, and covers hosted mode, where any public repository is indexed on demand. It is for developers who build a client, a dashboard or an integration against a running server. The same `/api` routes answer on a Vercel deployment such as staleproof.dev, through the function in [api/[...route].js](../api/[...route].js).

## Start the server and call it

```bash
npx -y staleproof serve
curl -s http://127.0.0.1:8080/api/health
```

The server binds `127.0.0.1:8080` by default (`--host`, `--port`, or `HOST` and `PORT`; see [Configuration](configuration.md#server)). On startup it prints one line to stderr, either `staleproof serve: http://127.0.0.1:8080 (graph "falkordb", agent on, <model>; MCP at /api/mcp)` or `... agent off: no model credentials, graph mode only; MCP at /api/mcp)`; in hosted mode `, hosted: any public repository on demand` follows the graph name. It connects to FalkorDB before it listens. With neither `FALKORDB_URL` nor `--db` set and nothing on `localhost:6379`, it starts a local FalkorDB first; with either set, an unreachable server stops it with `cannot reach FalkorDB at ...`.

Run a graph-mode check and watch the trace arrive:

```bash
curl -N -X POST http://127.0.0.1:8080/api/check \
  -H 'content-type: application/json' \
  -d '{"pr_url": "https://github.com/FalkorDB/falkordb-py/pull/262", "mode": "graph"}'
```

The API has no authentication. Anyone who can reach the port can start checks (which spend your model budget in agent mode), record decisions and review verdicts, and, in hosted mode, index repositories. Keep the default `127.0.0.1` bind, or put an authenticating proxy in front of it.

## Hosted mode

Without hosted mode, the server answers from one graph: `STALEPROOF_ORG`, else `falkordb`. In hosted mode (`serve --hosted` or `STALEPROOF_HOSTED=on`; on by default in the Vercel function), that graph is the curated one, and any other public repository is downloaded as a tarball and indexed on demand into the workspace graph of its owner, `gh-<owner>`, together with the repositories named alongside it. The routes then find the right graph themselves: by the repository a pull request URL or an id names, and by searching every graph for a check or verdict id. [Deploy](DEPLOY.md#hosted-mode) has the limits and how workspaces are evicted.

## Routes at a glance

| Method and path | Purpose | Rate limited |
|---|---|---|
| `GET /api/health` | Version, graph, FalkorDB version, whether agent mode is available, whether a check is running, hosted mode | no |
| `GET /api/stats` | Every number FACTS.md quotes, computed from the graph | no |
| `GET /api/prs` | The preloaded pull requests with their latest check and example runs | no |
| `GET /api/checks` | Recent checks, newest first | no |
| `GET /api/checks/:id` | The stored trace of one check | no |
| `POST /api/check` | Run a check and stream its trace (SSE); hosted, index the repository first | yes, `check` bucket |
| `POST /api/index` | Hosted mode: index repositories into one workspace and stream the progress (SSE) | yes, `index` bucket |
| `GET /api/repos` | Which graph holds a repository, and whether it is indexed | no |
| `GET /api/workspaces` | Hosted mode: every workspace and its repositories | no |
| `POST /api/mcp` | MCP over Streamable HTTP | no |
| `GET /api/sections` | The text and examples of one doc section | no |
| `GET /api/patch` | The docs patch for a checked pull request | no |
| `POST /api/decisions` | Record a maintainer decision | yes, `write` bucket |
| `POST /api/verdicts/:id/review` | Accept or reject a verdict | yes, `write` bucket |
| `GET /api/model` | Every named Cypher query and every tool | no |
| `GET /`, `/llms.txt`, `/llms-full.txt`, `/docs/<slug>.md`, `/robots.txt`, `/sitemap.xml`, `/favicon.svg`, `/assets/*`, anything else | The web app and its static files | no |

## Conventions

- Responses are JSON. Errors have the body `{"error": "<message>"}` and a 4xx or 5xx status. An error a route does not handle itself becomes `400 {"error": "<message>"}` when it is a hosted limit, a repository too large to index from an archive or a repository that is not indexed, and `500 {"error": "<message>"}` otherwise.
- Request bodies are JSON. Send `content-type: application/json`. A body that is not valid JSON is read as `{}`, so it fails validation with the message for a missing field.
- Pull request URLs may be `https://github.com/<owner>/<repo>/pull/<n>` (a trailing `/files`, query or fragment is allowed) or `<owner>/<repo>#<n>`. They are normalised to `https://github.com/<owner>/<repo>/pull/<n>`, which is how the graph stores them.
- Ids follow the formats in [Core concepts](concepts.md#ids): a section is `owner/repo:path#anchor` (for example `FalkorDB/falkordb-py:README.md#asynchronous-example`), an example is `owner/repo:path:index`, a check is `chk-<12 hex>`, a verdict `ver-<12 hex>`, a decision `dec-<10 hex>`. URL-encode ids in query strings: they contain `/`, `:` and `#`.
- Timestamps (`at`, `startedAt`, `finishedAt`, `createdAt`) are milliseconds since the Unix epoch.
- No CORS headers are set, so a browser page on another origin cannot call the API directly. Call it from a server, or proxy it under your own origin.
- Repository names may be `owner/name` or a GitHub URL (`https://github.com/owner/name`, with or without `.git`). They are case-insensitive, as on GitHub: a pull request URL in any spelling is read with the repository's indexed spelling, and hosted workspaces store names in lower case.

## Rate limits

`POST` routes other than `/api/mcp` are limited to 30 requests per client per hour. GET routes are not limited.

| Bucket | Routes | Limit |
|---|---|---|
| `check:<client>` | `POST /api/check` | 30 per sliding hour |
| `index:<client>` | `POST /api/index` | 30 per sliding hour |
| `write:<client>` | `POST /api/decisions` and `POST /api/verdicts/:id/review`, together | 30 per sliding hour |

- **The client key** is the `X-Real-IP` header if present (Vercel sets it), else `Fly-Client-IP`, else the last entry of `X-Forwarded-For` (the one the nearest proxy appended), else the constant `local`. Behind no proxy, every caller shares the `local` bucket.
- **Counting**: a request counts before it is validated, so a request rejected with 400 still uses one slot.
- **Over the limit**: `429 {"error": "rate limited: try again later"}`. No `Retry-After` header is sent; the oldest request in the window drops out an hour after it was made.
- **Scope**: counts live in memory, per process. A restart resets them; on Vercel each function instance counts on its own.
- **Changing it**: `createApp({ rateLimit })` in the [library](library.md#mount-the-http-api-in-your-own-server). `staleproof serve` and the Vercel function use the default of 30; there is no flag or environment variable.
- **Hosted agent checks** also have a daily budget across the service; see [POST /api/check](#post-apicheck).

## One check at a time

A server runs one check at a time, agent or graph mode, and in hosted mode one indexing run at a time with them. Further `POST /api/check` and `POST /api/index` requests wait in arrival order; a check that has to wait first receives a `queued` event. `GET /api/health` reports `busy: true` while one runs. Example runs are also serialised, process-wide, because they share the scratch database. Calls to `POST /api/mcp` do not wait in this queue.

Closing the connection does not cancel a check. It runs to the end and is stored on its `Check` node; read it later with `GET /api/checks/:id`.

## GET /api/health

What the server is connected to and whether agent mode is available.

```bash
curl -s http://127.0.0.1:8080/api/health
```

A server without model credentials and without hosted mode answers:

```json
{"ok": true, "version": "0.2.0", "org": "falkordb", "falkordb": "4.22.0", "agent": {"available": false, "reason": "the server has no model API credentials (ANTHROPIC_API_KEY)"}, "busy": false, "hosted": {"enabled": false}}
```

| Field | Type | Meaning |
|---|---|---|
| `ok` | `true` | Always `true` when the route answers |
| `version` | string | The `staleproof` package version |
| `org` | string | The graph name (the org slug) |
| `falkordb` | string | The FalkorDB module version from `MODULE LIST`, or `unknown` if the server does not report it |
| `agent` | object | `{available: true, model, effort, provider}` or `{available: false, reason}` |
| `agent.provider` | string | The host of `ANTHROPIC_BASE_URL` for an Anthropic-compatible provider (for example `api.deepseek.com`), else `api.anthropic.com` |
| `busy` | boolean | A check (or, hosted, an indexing run) is running |
| `hosted` | object | `{enabled: false}`, or in hosted mode `{enabled: true, limits: {maxRepos, maxFiles, maxGraphMb}, memory: {used, max}, githubToken}`: the workspace limits, the FalkorDB server's memory in MB (`max` is 0 when uncapped; `memory` is left out when the server does not report it), and whether the server has a GitHub token |

`available: true` means credentials were found, not that they work. A `claude-*` model name with a compatible provider still reports `available: true`, and every agent check then fails with an `error` event (see [Troubleshooting](troubleshooting.md#common-errors)).

## GET /api/stats

The facts behind [FACTS.md](FACTS.md), as JSON: the same object `staleproof facts --json` prints. It is computed from the graph and cached for 60 seconds per process.

```bash
curl -s http://127.0.0.1:8080/api/stats
```

| Field | Shape |
|---|---|
| `org`, `generatedAt`, `falkordb` | graph name, ISO time, FalkorDB version |
| `nodes` | `{<label>: count}`; `Symbol`, `DocSection` and `CodeExample` count live nodes only |
| `edges` | `{<relationship type>: count}` |
| `repos[]` | `{name, sha, packages, symbols, sections, examples, pythonExamples}` |
| `calls`, `uses` | `{exact, byName, crossRepo}`, `{exact, byName}` |
| `dependsOn[]` | `{from, to, spec}` |
| `crossRepoDocPaths` | number of symbol-to-doc paths that cross a repository boundary |
| `samplePaths[]` | `{symbol, doc, hops, path}` |
| `impactQueryMs[]` | `{symbol, ms, rows}`: server-side time of the impact query for sample symbols |
| `pullRequests[]` | `{url, title, changed, sections, otherRepos}` |
| `runs[]` | `{example, url, side, status, error, reason, installed, pr}`, the latest attempt of each run |
| `grepBaseline[]` | `{url, names, reached, grepFound, grepOutside}` |

## GET /api/prs

The pull requests the home page lists: `serve --preload`, else `STALEPROOF_PRELOADED`, else falkordb-py #262, #267 and #276.

```bash
curl -s http://127.0.0.1:8080/api/prs
```

```text
{ "prs": [ { url, ref, title, state, latestCheck, runs } ] }
```

| Field | Shape |
|---|---|
| `url` | canonical PR URL |
| `ref` | `{owner, repo, fullName, number, url}` |
| `title`, `state` | from the graph; `null` until the PR has been checked once; `state` is `merged`, `open` or `closed` |
| `latestCheck` | `{id, model, status, summary, startedAt}` of the newest check in either mode, or `null` |
| `runs[]` | `{example, side, status, error}` for every example run linked to the PR, ordered by example and side |

A preloaded entry that is not a pull request URL makes this route answer 500.

## GET /api/checks

Recent checks, newest first, in both modes.

| Query parameter | Default | Meaning |
|---|---|---|
| `limit` | `20` | Number of checks; values above 100 are capped at 100, fractions are rounded down, and anything that is not a positive number falls back to 20 |

```bash
curl -s 'http://127.0.0.1:8080/api/checks?limit=5'
```

Each entry: `{id, pr, title, status, model, startedAt, finishedAt, steps, toolCalls, verdicts, summary, toolOrder, org}`. `org` is the graph that holds the check. In hosted mode the list merges the newest checks of the curated graph and the 7 most recently used workspaces.

- `model` is the model name in agent mode (for example `deepseek-v4-pro`) and `graph-only (no model)` in graph mode.
- `status` is `running` while a check is in progress (`finishedAt` is then `null`), then `done`, `incomplete`, `refused` or `error` (see [Check statuses](#check-statuses)). A check whose process died stays `running`.
- `summary` is the agent's final text in agent mode, which can be several paragraphs of Markdown.

## GET /api/checks/:id

The stored trace of one check, for replaying it.

```bash
curl -s http://127.0.0.1:8080/api/checks/<check-id>
```

`200 {"id": "<check-id>", "org": "<graph>", "events": [TraceEvent, ...]}`, or `404 {"error": "no such check"}`. In hosted mode the check is looked up in the curated graph first, then in every workspace.

The stored trace is the live stream with two differences: `delta` events are dropped, and a `tool_result` whose `data` serialises to more than 60,000 characters has it replaced by `{"__trimmed": true, "preview": "<first 60,000 characters>…"}`. The trace is written when the check ends, so a running check returns `events: []`.

## POST /api/check

Run a check of one pull request and stream its trace as Server-Sent Events.

| Body field | Type | Required | Meaning |
|---|---|---|---|
| `pr_url` | string | yes | The pull request (any accepted form, see [Conventions](#conventions)) |
| `mode` | `"agent"` \| `"graph"` | no | Default: `agent` when the server has model credentials, else `graph`. Any value other than `"agent"` runs graph mode |
| `with` | string[] | no | Hosted mode: repositories to index together with the pull request's, for example its docs site (`["acme/docs"]`). Validated everywhere, used only in hosted mode |

What each mode does (definitions in [Agent mode and graph mode](concepts.md#agent-mode-and-graph-mode)):

- **Agent mode**: the model chooses every tool call and records a verdict or an edit for each impacted section. The server gives it at most 40 model turns and, if `STALEPROOF_CHECK_BUDGET_MS` is set, a wall-clock budget (240 s by default on Vercel, none elsewhere). Neither can be changed per request.
- **Graph mode**: no model. The tools run in a fixed order: `impact` (3 hops), `clearance`, `rank_sections` on the first impact page, then `run_example` before and after the PR for at most 3 exactly-linked examples on that page. In a hosted workspace it runs no examples (the summary says `Example runs not requested.`). It writes no verdicts.

The first check of a pull request ingests it (GitHub metadata and the symbol-level diff); later checks reuse what the graph stored. In hosted mode, a repository that no graph holds (or whose workspace is more than 7 days old, or that lacks a `with` repository) is indexed first, inside the same stream: `index_started`, `index_progress` and `index_finished` events come before `check_started`. Without hosted mode nothing is indexed, and a repository missing from the graph ends the stream with an `error` event. Indexing comes out of the server's time budget (`STALEPROOF_CHECK_BUDGET_MS`, when set): the agent gets what remains, but at least 45 seconds.

Responses before the stream starts:

| Status | Body | When |
|---|---|---|
| 400 | `{"error": "not a GitHub pull request URL: \"<input>\" (expected https://github.com/<owner>/<repo>/pull/<n>)"}` | `pr_url` missing or malformed |
| 400 | `{"error": "not a GitHub repository: \"<input>\" (expected owner/name or a github.com URL)"}` | an entry of `with` is not a repository name |
| 409 | `{"error": "agent mode needs model API credentials on the server (ANTHROPIC_API_KEY); graph mode works without them", "agentUnavailable": true}` | `mode: "agent"` on a server without model credentials (an Anthropic-compatible provider's key in `ANTHROPIC_API_KEY` counts) |
| 429 | `{"error": "rate limited: try again later"}` | over the `check` limit |
| 429 | `{"error": "today's hosted agent checks are used up; graph mode still works, and the agent runs anywhere with your own key (npx -y staleproof check <pr-url>)", "agentUnavailable": true}` | hosted mode, `mode: "agent"`, once the service's agent checks for the day (UTC) are used up: `STALEPROOF_AGENT_CHECKS_PER_DAY` on Vercel, default 50. Every agent request counts, including ones that fail later |
| 503 | `{"error": "the Staleproof API is not connected to FalkorDB (<message>); set FALKORDB_URL", "offline": true}` | Vercel only, when the function cannot reach FalkorDB |
| 200 | `text/event-stream` | the check runs |

Once the stream has started the status is 200, so failures after that point (the repository is not indexed, a hosted limit, a GitHub error, a model that cannot be constructed) arrive as an `error` event.

### Stream format

Every message has the event name `trace` and one line of JSON data:

```text
event: trace
data: {"type":"check_started","checkId":"chk-f4062e42d5c6","pr":"https://github.com/FalkorDB/falkordb-py/pull/262","model":"graph-only (no model)","at":1792138484707}

event: trace
data: {"type":"tool_call","id":"graph_1","name":"impact","input":{"pr_url":"https://github.com/FalkorDB/falkordb-py/pull/262"},"step":1}

```

(The two events are from the graph-mode check of falkordb-py#262 stored in the bundled snapshot.) The response headers are `Content-Type: text/event-stream` and `Cache-Control: no-cache`. Messages carry no `id:` or `retry:` field and there is no heartbeat. The stream closes after `check_finished`, or after an `error` event.

### Trace events

The `data` of every message is one of these objects, discriminated by `type`: the eight `TraceEvent` types of [src/agent/trace.ts](../src/agent/trace.ts), plus `queued` and `error`, which only the HTTP stream sends, and in hosted mode the three indexing events of [src/hosted/workspaces.ts](../src/hosted/workspaces.ts).

| `type` | Sent | Fields |
|---|---|---|
| `queued` | once, first, when another check is running | — |
| `check_started` | when the `Check` node is created | `checkId`, `pr`, `model`, `at`, `since?` (agent mode: what changed in the graph since the previous check, as one sentence) |
| `delta` | agent mode, while the model streams; live only, never stored | `kind` (`text` \| `thinking`), `text` (a fragment), `step` |
| `thinking` | agent mode, after each model turn, per thinking block | `text`, `step` |
| `text` | agent mode, after each model turn, per text block | `text`, `step` |
| `tool_call` | before a tool runs | `id` (the model's tool-use id; `graph_<n>` in graph mode), `name`, `input`, `step` |
| `tool_result` | after it returns | `id`, `name`, `summary` (or the error message), `isError`, `queries[]` (`{name, cypher, params, ms, rows}`; `ms` is FalkorDB's server-side time, `name` is `adhoc` for unnamed statements), `data?` (absent on errors), `ms` (wall time of the call), `step` |
| `nudge` | agent mode, when the model stops with impacted sections still open (at most twice) | `missing` (section ids), `step` |
| `check_finished` | last event of every check | `checkId`, `status`, `summary`, `steps`, `toolCalls`, `toolOrder` (tool names in call order), `verdicts`, `missing`, `usage` (`{input, output, cacheRead}` tokens), `at` |
| `error` | when the check could not start or crashed outside the tool loop | `message` |
| `index_started` | hosted mode, when a workspace starts indexing | `repos` (every repository of the workspace, indexed together), `graph`, `reason` (`new`, `stale`, `added` or `refresh`), `at` |
| `index_progress` | hosted mode, during indexing | `repo?`, `phase` (`download`, `evict`, or an index phase: `checkout`, `parse`, `write`, `resolve`, `docs`, `done`), `message`, `at` |
| `index_finished` | hosted mode, when the workspace is written | `graph`, `repos[]` (`{repo, sha, files, symbols, sections, examples}`), `mb?` (the workspace's graph size), `ms`, `at` |

- `step` is the model turn in agent mode and the tool call number in graph mode.
- `data` on a `tool_result` is the tool's full result (the shapes are in [Tools reference](tools.md)); only the stored trace trims it.
- In graph mode `usage` is all zeros, `verdicts` is `0` and `missing` is empty.
- In agent mode, `missing` lists the impacted sections with no verdict or edit from this check. After any `impact` call the loop collects the section ids of every impact page, including pages the model has not requested, so `done` means every impacted section was closed.
- Typical `error` messages: `<owner/repo> is not indexed in the "<graph>" graph. Run: staleproof index <owner/repo> (plus the repositories that document it).`, the GitHub errors (rate limit, not found), and `"<model>" is a Claude model name, but the model endpoint is an Anthropic-compatible provider ...`. Failures inside the loop, such as the model API rejecting the key, end the check instead: `check_finished` with `status: "error"` and a summary starting `The check failed:`. Each message is explained in [Troubleshooting](troubleshooting.md#common-errors).

### Check statuses

| `status` | Meaning |
|---|---|
| `done` | Agent mode: every impacted section has a verdict or an edit from this check. Graph mode: the fixed steps ran (a failing `clearance`, `rank_sections` or `run_example` is recorded with `isError` and the rest continue; a failing `impact` ends the check with `error`) |
| `incomplete` | Agent mode: the model stopped, ran out of turns (40) or ran out of the server's time budget with sections still open; they are listed in `missing` and in the summary |
| `refused` | Agent mode: the model declined to continue; the summary gives the category |
| `error` | The check failed; the summary starts with `The check failed:` |

## POST /api/index

Hosted mode only: index public repositories into one workspace and stream the progress. The web app calls it before a check; `POST /api/check` indexes on its own, so a client rarely needs it.

| Body field | Type | Required | Meaning |
|---|---|---|---|
| `repos` | string[] or string | yes | The repository first, then the repositories to index together with it (for example `["acme/acme-client", "acme/acme-docs"]`) |
| `refresh` | boolean | no | `true` re-indexes the workspace at its default branch heads even when it is current |

```bash
curl -N -X POST https://staleproof.dev/api/index \
  -H 'content-type: application/json' \
  -d '{"repos": ["encode/httpx"]}'
```

Responses before the stream starts:

| Status | Body | When |
|---|---|---|
| 404 | `{"error": "this server indexes from the CLI only: staleproof index <owner/repo>..."}` | the server is not in hosted mode |
| 429 | `{"error": "rate limited: try again later"}` | over the `index` limit |
| 400 | `{"error": "repos required: [\"owner/name\", ...]"}`, or `not a GitHub repository: ...` | `repos` missing, empty, or not repository names |
| 200 | `text/event-stream` | the request runs, in the one-at-a-time queue |

Every message has the event name `trace`. The stream sends `index_started`, `index_progress` and `index_finished` ([Trace events](#trace-events)) when something is indexed, then `{"type": "indexed", "graph": "<graph>", "curated": <boolean>}`, or `{"type": "error", "message": "<message>"}`. A workspace that is already current sends `indexed` alone. When another request (possibly on another server instance) is indexing the same workspace, the stream sends `index_progress` with `waiting for another request indexing <graph>` every 3 seconds, for up to 150 seconds. The hosted limits arrive as `error` events; [Troubleshooting](troubleshooting.md#hosted-service) lists them.

## GET /api/repos

Which graph holds a repository.

| Query parameter | Required | Meaning |
|---|---|---|
| `name` | yes | `owner/name` or a GitHub URL |

```bash
curl -s 'https://staleproof.dev/api/repos?name=FalkorDB/falkordb-py'
```

`200 {name, indexed, graph, curated, sha, indexedAt}`, plus `workspace` (the names of every repository in that graph) when a hosted server has it indexed. Without hosted mode, `graph` is the server's graph and `curated` is `true`. In hosted mode, a repository no graph holds answers `indexed: false` with the graph it would be indexed into (`gh-<owner>`). `sha` and `indexedAt` are `null` when it is not indexed. A malformed name answers `400 {"error": "not a GitHub repository: ..."}`.

## GET /api/workspaces

Hosted mode: every graph that answers for repositories, the curated one first, then the hosted workspaces, most recently used first.

```bash
curl -s https://staleproof.dev/api/workspaces
```

`200 {workspaces: [{graph, curated, repos: [{name, sha, indexedAt, lastUsed}]}]}`. Without hosted mode it answers `{"workspaces": []}`. For the curated graph `lastUsed` is the time it was indexed.

## POST /api/mcp

The MCP tools over Streamable HTTP, for any MCP client that takes a URL ([MCP server](mcp.md)). The endpoint is stateless: every request gets a fresh MCP server, no session id is issued, and responses are JSON rather than SSE. `GET` and `DELETE` answer `405` with `Allow: POST` and a JSON-RPC error, `Method not allowed: POST JSON-RPC messages to this endpoint`.

```bash
curl -s -X POST http://127.0.0.1:8080/api/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

- **Without hosted mode** every tool runs on the server's one graph, and nothing is indexed on first use: index the repository with the CLI first.
- **In hosted mode** each call goes to the graph of the repository it names (`pr_url`, or the `owner/repo:` prefix of an id), and `check_pull_request`, `impact` and `clearance` index that repository first when no graph has it. `run_example` is not offered, and the server's instructions say that examples are not executed there.
- It is not rate limited, needs no authentication, and does not wait in the one-check-at-a-time queue.

## GET /api/sections

The current text of one doc section and its code examples, as stored at the last index.

| Query parameter | Required | Meaning |
|---|---|---|
| `id` | yes | Section id, URL-encoded. In hosted mode it is looked up in the graph of the repository its id names |

```bash
curl -sG http://127.0.0.1:8080/api/sections --data-urlencode 'id=FalkorDB/falkordb-py:README.md#asynchronous-example'
```

`200 {id, repo, path, heading, body, url, lineno, endLineno, examples: [{id, lang, code, lineno}]}`. `heading` is the heading path (`Parent > Child`), `body` is the section's Markdown including its heading line (stored up to 8,000 characters), and `url` points at the line on GitHub at the indexed commit. Errors: `400 {"error": "id required"}`, `404 {"error": "no such section"}` (also, in hosted mode, when no graph holds the repository).

## GET /api/patch

The docs fix for a checked pull request: a unified diff of every stale section's proposed text, and a pull request description with the evidence path behind each edit (see [The docs patch](concepts.md#the-docs-patch)).

| Query parameter | Required | Meaning |
|---|---|---|
| `pr` | yes | The pull request, URL-encoded. In hosted mode the patch comes from the graph that holds its repository |

```bash
curl -sG http://127.0.0.1:8080/api/patch --data-urlencode 'pr=https://github.com/FalkorDB/falkordb-py/pull/267'
```

`200 {title, body, diff, files, verdicts, conflicts}`:

| Field | Shape |
|---|---|
| `title` | `docs: update for <repo>#<number> (<PR title>)` |
| `body` | Markdown description: one entry per edited section with its path, runs and cited decisions, then the sections left unchanged and the edits not applied |
| `diff` | unified diff of every changed file, `git apply`-able in each docs repository; `""` when nothing is edited |
| `files[]` | `{repo, path, sections}`: the sections edited in each file |
| `verdicts[]` | the latest verdict per section: `{section, repo, path, heading, lineno, endLineno, url, id, verdict, status, reason, newText, oldText, evidence, cites, runs: [{id, status, side, error}]}` |
| `conflicts[]` | `{section, reason}` for edits that could not be placed |

The patch is built from the latest verdict of each section: a `stale` verdict with new text whose review status is not `rejected`. Each file is read at the commit the graph indexed, from the local clone in `STALEPROOF_HOME` when there is one, otherwise from `raw.githubusercontent.com`, so the route also works on hosts without git such as Vercel. An edit whose section text differs from what the verdict was written against becomes a conflict (`<path> changed since it was indexed at <sha7>`), and so does a file that is missing at that commit (`<path> not found in <repo>@<sha7>`).

On the FalkorDB examples the patch is empty: every verdict recorded on falkordb-py #262, #267 and #276 is `ok`.

Errors: a missing or malformed `pr` answers `400 {"error": "not a GitHub pull request URL: ..."}`; in hosted mode, a repository no graph holds answers `404 {"error": "<owner/repo> is not indexed"}`. A pull request the graph has never seen (`<url> has not been checked`) and a failed GitHub read (`GitHub raw <path>@<sha7> failed: <status>`) answer 500.

## POST /api/decisions

Record a maintainer decision. Later checks find it with `decisions_for` and cite it instead of flagging the section again (see [Decisions and memory](memory.md)).

| Body field | Type | Required | Meaning |
|---|---|---|---|
| `text` | string, 5 to 500 characters | yes | The decision, in one sentence |
| `governs` | string[], at least 1 | yes | DocSection and/or Symbol ids it governs |
| `source_url` | string | no | Where it was decided (issue, PR comment, ADR) |
| `author` | string | no | Who decided; default `unknown` (the web app sends `web demo`) |
| `supersedes` | string | no | The decision id this replaces; an unknown id is ignored without an error |

```bash
curl -s -X POST http://127.0.0.1:8080/api/decisions \
  -H 'content-type: application/json' \
  -d '{"text": "The async client keeps positional kwargs until 2.0", "governs": ["FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__"], "author": "maintainer"}'
```

`200 {id, governed, summary}`: the new decision id, how many of the given ids it now governs, and a sentence such as `Recorded decision <id> governing 1 node(s).`

| Status | Body |
|---|---|
| 400 | the validation messages, joined with `; ` |
| 400 | `decision text is limited to 500 characters` (the CLI `decide` has no such limit) |
| 400 | `none of <ids> is a DocSection or Symbol id; decision not recorded` |
| 404 | `<owner/repo> is not indexed`: hosted mode, when no graph holds the repository of the first `governs` id (the decision is written to that repository's graph) |
| 429 | `rate limited: try again later` |

## POST /api/verdicts/:id/review

A maintainer accepts or rejects a verdict. Reviews are how precision is measured, and a rejected `stale` verdict is left out of the docs patch. The CLI equivalent is `staleproof verdict accept|reject <id>`. The web app has no control for it.

| Body field | Type | Required | Meaning |
|---|---|---|---|
| `status` | `"accepted"` \| `"rejected"` | yes | The review |
| `by` | string | no | Reviewer, default `web`, cut to 60 characters |

```bash
curl -s -X POST http://127.0.0.1:8080/api/verdicts/<verdict-id>/review \
  -H 'content-type: application/json' \
  -d '{"status": "accepted", "by": "maintainer"}'
```

`200 {"ok": true}`. Errors: `400 {"error": "status must be accepted or rejected"}`, `404 {"error": "no such verdict"}` (in hosted mode after searching every graph), 429. Verdict ids appear in check traces: the `tool_result` of `propose_edit` carries `data.id` and that of `record_verdict` carries `data.ids`.

## GET /api/model

The query catalogue the web app's model page shows.

```bash
curl -s http://127.0.0.1:8080/api/model
```

`200 {queries: [{name, group, purpose, cypher}], tools: [{name, description, queries}]}`. `queries` is every named Cypher statement (`group` is `schema`, `index`, `tool`, `memory` or `report`); `tools` lists the nine tools of the agent and MCP (`check_pull_request` and `docs_patch`, which only MCP has, are not included), each with the names of the queries it can run. The same statements are in [Graph model and Cypher](GRAPH-MODEL.md).

## Static routes

When the package's built web app (`web/dist`) exists, as it does in the npm package, the server also answers:

| Path | Answer |
|---|---|
| `GET /` and any other GET path not listed here | `index.html`: the web app. Its pages are hash routes such as `#/`, `#/check/<id>`, `#/model` and `#/docs/<slug>` |
| `/assets/*` | the app's JavaScript and CSS |
| `/favicon.svg` | the icon |
| `/llms.txt` | an index of the documentation for LLMs ([llmstxt.org](https://llmstxt.org) format), `text/plain; charset=utf-8` |
| `/llms-full.txt` | every documentation page in one file, `text/plain; charset=utf-8` |
| `/docs/<slug>.md` | one documentation page as Markdown, `text/markdown; charset=utf-8`. `<slug>` is lowercase letters, digits and `-` (for example `/docs/http-api.md`); an unknown page is 404, and any other shape falls through to `index.html` |
| `/robots.txt`, `/sitemap.xml` | crawler files, `text/plain` and `application/xml` |

`/snapshot.json` is served as JSON when the built web app includes one; see [Snapshot mode](#snapshot-mode). Without a built web app, `GET /` answers the text ``Staleproof API is running. The web UI is not built (run `npm run build:web`).`` and other non-API paths are 404.

On Vercel these files are served by Vercel from `web/dist`, not by the function, and `/snapshot.json` is among them.

## Consuming the SSE stream

`EventSource` only sends GET requests, so read the `POST /api/check` response body with `fetch`. This works in Node.js 20 or later and in browsers (same origin):

```ts
/** POST a check and hand each trace event to `onEvent` as it arrives. */
type Event = { type: string; [key: string]: unknown };

async function streamCheck(base: string, prUrl: string, mode: 'agent' | 'graph', onEvent: (e: Event) => void): Promise<void> {
  const res = await fetch(`${base}/api/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pr_url: prUrl, mode }),
  });
  if (!res.ok || !res.body) {
    // 400 malformed URL, 409 agent mode unavailable, 429 rate limited, 503 no FalkorDB (Vercel)
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const message = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = message
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(JSON.parse(data) as Event);
    }
  }
}

await streamCheck('http://127.0.0.1:8080', 'https://github.com/FalkorDB/falkordb-py/pull/262', 'graph', (e) => {
  if (e.type === 'tool_result') console.log(`← ${String(e.summary)}`);
  else if (e.type === 'check_finished') console.log(`${String(e.status)}: ${String(e.summary)}`);
  else if (e.type === 'error') console.error(`error: ${String(e.message)}`);
  else if (e.type === 'queued') console.log('queued behind another check');
});
```

The web app's own client, `streamCheck` in [web/src/api.ts](../web/src/api.ts), parses the stream the same way. From a shell, `curl -N` disables buffering so events print as they arrive; keep only the JSON with `sed`:

```bash
curl -sN -X POST http://127.0.0.1:8080/api/check \
  -H 'content-type: application/json' \
  -d '{"pr_url": "https://github.com/FalkorDB/falkordb-py/pull/267", "mode": "graph"}' \
  | sed -n 's/^data: //p'
```

Each output line is one event. Pipe it to `jq -c 'select(.type == "tool_result") | {name, summary}'` to follow the tools.

## Snapshot mode

A static deployment can show the demo without a database. When an API call fails with no HTTP status (network error), with a status of 500 or above, or with a response that is not JSON, the web app loads `/snapshot.json` once and, if the file has data for that page, switches to snapshot mode for the rest of the page session. A banner shows when the snapshot was taken.

| In snapshot mode | Behaviour |
|---|---|
| Health, stats, preloaded PRs, recent checks, stored traces, the model page | answered from the snapshot; health reports `agent: {available: false, reason: "snapshot mode"}` |
| Section text and the docs patch | fail with `the Staleproof API is unreachable and no snapshot is bundled` |
| Running a check, recording a decision | fail with `Live checks need the Staleproof API connected to FalkorDB; this deployment is showing a snapshot. Run it locally: npx staleproof serve` |

`npm run snapshot` (in a clone of the repository; [scripts/snapshot.ts](../scripts/snapshot.ts)) writes `web/public/snapshot.json` from the graph `FALKORDB_URL` and `STALEPROOF_ORG` point at: health, stats, the preloaded PRs (`STALEPROOF_PRELOADED`), the model page, and stored traces for the latest check of each preloaded PR and for every agent check among the 20 most recent. The snapshot's list of recent checks keeps only the checks whose trace it carries. The next `npm run build` copies it into `web/dist`.

```bash
FALKORDB_URL='falkor://localhost:6379' npm run snapshot
npm run build
```

Snapshot mode serves static hosting, where Vercel serves `web/dist/snapshot.json` as a file and the function answers 503 without FalkorDB. `staleproof serve` cannot be in this state at startup (it refuses to start without FalkorDB), and it does not serve `/snapshot.json`.

## On Vercel

The function in [api/[...route].js](../api/[...route].js) wraps the same app, so every `/api` route above behaves the same, with these differences:

- **Hosted mode is on** unless `STALEPROOF_HOSTED=off`: any public repository is indexed on demand into its own workspace graph, and MCP answers at `/api/mcp`.
- **No database**: it connects to FalkorDB on the first request. If that fails, every `/api` route answers `503 {"error": "the Staleproof API is not connected to FalkorDB (<message>); set FALKORDB_URL", "offline": true}`, and the next request tries again.
- **No git**: repositories are downloaded as tarballs, pull requests are ingested through the GitHub API, examples are not executed (runs recorded on the graph by another host are still answered), and `clearance` reports 0 raw text matches because there are no clones to grep.
- **Methods**: the function answers `GET` and `POST` only.
- **Time**: the function may run 300 s (`maxDuration` in [vercel.json](../vercel.json)); agent checks stop at 240 s by default and end `incomplete`.
- **Per instance**: rate limits, the one-check-at-a-time queue and the stats cache are per function instance. The hosted workspaces' locks and daily budgets are shared, because they are stored in FalkorDB.

[Deploy](DEPLOY.md#vercel) has the setup.

## Known limits

- No authentication and no CORS headers.
- Rate limits are in memory per process and keyed on headers, `X-Real-IP` first. A client that reaches the server without a proxy that sets `X-Real-IP` can choose its own key by sending that header.
- `POST /api/mcp` is limited to ten times the check limit per client (300 requests an hour by default: a client sends a few per question) and runs outside the one-check-at-a-time queue.
- A check cannot be cancelled, and closing the stream does not stop it. A check whose process dies stays `running`.
- Per-request settings are fixed: agent mode uses 40 turns and the server's time budget; graph mode uses 3 hops and at most 3 example runs (none in a hosted workspace). The CLI exposes `--max-steps`, `--max-hops` and `--runs`.

## Related

- [CLI](cli.md): the same operations from a terminal, including `serve`
- [Configuration](configuration.md): `PORT`, `HOST`, `STALEPROOF_PRELOADED`, `STALEPROOF_CHECK_BUDGET_MS` and the model variables
- [Node.js library](library.md): `createApp` to mount this API in your own server
- [Deploy](DEPLOY.md): Vercel, Docker Compose and a production checklist
- [Troubleshooting and FAQ](troubleshooting.md)
