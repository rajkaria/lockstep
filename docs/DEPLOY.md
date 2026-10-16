# Deploy

A deployment is one Node.js process (`staleproof serve`: the web app and the HTTP API) plus FalkorDB. This page covers four ways to run it (Vercel with FalkorDB Cloud, Docker Compose on any VM, a plain host without Docker, and FalkorDB Cloud as the database for any of them), connecting Claude Code over MCP, the GitHub Action, and a checklist for running it for a team. It is for whoever operates the service; every variable is described in [Configuration](configuration.md).

## Choose a host

| | Vercel | Docker Compose, a VM or your machine |
|---|---|---|
| Web app and API | yes | yes |
| Agent mode and graph mode | yes; agent checks stop at 240 s by default | yes; no time limit unless you set one |
| Pull request ingestion | through the GitHub API (no git) | git |
| Example runs | not executed; runs recorded on the graph by another host are answered | yes, in the sandbox |
| Docs patch | yes, files read from GitHub at the indexed commit | yes, from the local clones |
| Raw text-match counts in `clearance` | 0 (no clones to search) | yes |

The usual split: index and seed from a machine that can run examples, and serve the demo from Vercel against the same FalkorDB.

## The minimum you need

| Variable | Why |
|---|---|
| `FALKORDB_URL` | The FalkorDB holding the org graph. Default `falkor://localhost:6379` |
| `STALEPROOF_ORG` | The graph name, if it is not `falkordb` |
| `GITHUB_TOKEN` (or `GH_TOKEN`) | Without it GitHub allows 60 API requests per hour; required for `patch --open-pr` |
| `ANTHROPIC_API_KEY` | Agent mode. For an Anthropic-compatible provider such as DeepSeek, also `ANTHROPIC_BASE_URL` and `STALEPROOF_MODEL` (for example `deepseek-v4-pro`). Without a key the server runs graph mode and says so |

The full list, with defaults and the commands that read each one, is in [Configuration](configuration.md#environment-variables).

A host that runs examples also needs `git`, `tar`, and `uv` or `python3`. With [uv](https://docs.astral.sh/uv/) each virtualenv is created for Python 3.12; without it the runner falls back to `python3 -m venv` and pip, and the examples run on whatever version `python3` is. uv is recommended. Hosts without git (serverless) skip example runs with a reason and answer recorded runs from the graph.

## Vercel

The repository deploys to Vercel as is ([vercel.json](../vercel.json)): the web app is static (`web/dist`) and the API runs as a Vercel Function ([api/[...route].js](../api/[...route].js)). On Vercel, pull requests are read through the GitHub API (no `git`), `STALEPROOF_HOME` is `/tmp/staleproof`, and examples are not executed (no sandbox runtime): runs recorded by a local or container host are answered from the graph.

1. Create a FalkorDB the function can reach ([FalkorDB Cloud](#falkordb-cloud)'s free tier works) and index into it from your machine:
   ```bash
   export FALKORDB_URL='falkor://falkordb:<url-encoded password>@<host>:<port>'   # falkors:// if the endpoint has TLS
   npx -y staleproof index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
   bash scripts/seed.sh   # from a clone of the repository: re-index, graph-mode checks of the preloaded PRs with example runs, FACTS.md
   ```
   `scripts/seed.sh` is not in the npm package; it uses `staleproof` from your `PATH`, else the clone's `dist/cli.js`. Its example runs execute on your machine and are stored on the graph, which is what lets the Vercel deployment show them.
2. Add the variables and redeploy:
   ```bash
   vercel env add FALKORDB_URL production
   vercel env add GITHUB_TOKEN production         # recommended
   vercel env add ANTHROPIC_API_KEY production    # optional: agent mode
   vercel env add ANTHROPIC_BASE_URL production   # with STALEPROOF_MODEL, only for an Anthropic-compatible provider
   vercel env add STALEPROOF_MODEL production
   ```
   `STALEPROOF_PRELOADED` (the pull requests on the home page) and `STALEPROOF_CHECK_BUDGET_MS` are optional. `PORT`, `HOST` and the scratch variables are not used there.

Without a reachable FalkorDB the function answers `503 {"error": "the Staleproof API is not connected to FalkorDB (<message>); set FALKORDB_URL", "offline": true}` and the web app shows the snapshot bundled at build time, labelled with the time it was taken ([snapshot mode](http-api.md#snapshot-mode); `npm run snapshot` regenerates `web/public/snapshot.json` from a graph).

Function duration is capped at 300 s (`maxDuration`). An agent check in the server starts no model turn after 240 s (`STALEPROOF_CHECK_BUDGET_MS`) and ends `incomplete`, listing the sections still open; a 43-section agent check takes about 6 minutes, so run large checks from the CLI, which has no time limit. The function runs in `bom1` (Mumbai), next to the FalkorDB Cloud instance in AWS `ap-south-1`: a check makes dozens of graph round trips, so set `regions` in `vercel.json` to the Vercel region closest to your FalkorDB.

## Docker Compose (any VM)

```bash
docker compose up -d --build
docker compose exec staleproof node dist/cli.js index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
docker compose exec -e FACTS_OUT=/data/FACTS.md staleproof bash scripts/seed.sh   # optional: index + graph-mode checks of the preloaded PRs
```

The compose file ([docker-compose.yml](../docker-compose.yml)) runs two FalkorDB containers: `falkordb` (the graph, persisted in the `falkordb-data` volume) and `scratch` (examples only, no volume, flushed before every run). The `staleproof` container serves on port 8080 with `FALKORDB_URL=falkor://falkordb:6379` and `STALEPROOF_SCRATCH_URL=falkor://scratch:6379`.

- **Image**: Node 22 on Debian bookworm, with `git`, `python3`, `tar` and uv 0.11.6. `STALEPROOF_HOME` is `/data` (the `staleproof-data` volume, which keeps clones and virtualenvs across restarts), uv keeps Python and its cache under `/data`, and a health check calls `/api/health` every 30 s.
- **Variables passed through** from your shell or `.env`: `STALEPROOF_ORG` (default `falkordb`), `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and `STALEPROOF_PRELOADED`. Compose passes each one as an empty string when it is unset. For `STALEPROOF_PRELOADED` that means the home page lists no pull requests, so set it explicitly if you want the preloaded list. `ANTHROPIC_BASE_URL`, `STALEPROOF_MODEL` and `GH_TOKEN` are not passed through: to use an Anthropic-compatible provider, add them to the service's `environment` in the compose file.
- **`FACTS_OUT`**: `scripts/seed.sh` ends by writing FACTS.md to `docs/FACTS.md` by default, and the image has no `docs/` directory; the command above writes it to the volume instead.
- **Exposure**: the API has no authentication. Put a TLS-terminating proxy in front of port 8080 for a public demo, and see the [production checklist](#production-checklist).

> The Dockerfile and compose file are written but were not built on the machine Staleproof was developed on (no Docker there). Everything else in this document was run.

## Without Docker

```bash
npx -y staleproof db start                 # FalkorDB on :6379 from the falkordblite wheel (uv fetches Python 3.12)
npx -y staleproof index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
npx -y staleproof serve --host 0.0.0.0 --port 8080
```

`db start` installs the `falkordblite` wheel once into `~/.staleproof/falkordb/venv` (with uv, else `python3 -m venv` and pip; the wheel needs Python 3.12 or later) and keeps the data in `~/.staleproof/falkordb/data-6379`. The scratch server for example runs starts by itself on port 6390 the first time an example runs. `--host 0.0.0.0` exposes the unauthenticated API on every interface; keep the default `127.0.0.1` unless a proxy sits in front.

## FalkorDB Cloud

Create a free instance; its Connectivity tab gives the public endpoint and Instance Details the password for user `falkordb`. The free tier's endpoint is plain TCP: `FALKORDB_URL=falkor://falkordb:<password>@<host>:<port>`. URL-encode the password (`@` becomes `%40`, `:` becomes `%3A`, and so on), and use `falkors://` for an endpoint with TLS ([URL forms](configuration.md#graph-and-organisation)).

Keep the scratch server separate and disposable: leave `STALEPROOF_SCRATCH_URL` unset to use the local one, or point it at another server. The scratch server cannot require a password: docs examples connect to it without one, so a `STALEPROOF_SCRATCH_URL` with credentials is refused (`STALEPROOF_SCRATCH_URL must not carry credentials: ...`). Staleproof also refuses to flush the server named in `FALKORDB_URL`.

## Claude Code (MCP)

```bash
claude mcp add staleproof -e FALKORDB_URL=falkor://localhost:6379 -e STALEPROOF_ORG=falkordb -- npx -y staleproof mcp
```

Add `-e GITHUB_TOKEN=...` to raise the GitHub limit for pull requests the graph has not ingested yet. [MCP server](mcp.md) covers other clients and the ten tools.

## GitHub Action

See [examples/staleproof.yml](../examples/staleproof.yml) and [GitHub Action](github-action.md). Store the FalkorDB URL as the `STALEPROOF_FALKORDB_URL` secret; add `ANTHROPIC_API_KEY` for agent verdicts. The workflow needs `pull-requests: write` to post its comment.

- Without a key, the action renders the comment from the graph (impact, clearance, ranking and existing verdicts) without running a check or any example.
- With `reindex: 'true'`, the action re-indexes the pull request's repository before checking, alone and at the remote default branch head (its description says "at the base branch", but no ref is passed). Indexing one repository alone re-resolves its calls and docs links against that repository only, so cross-repository edges from it are dropped until the organisation is indexed together again.
- The action is written but has not been run on a live repository yet.

## Production checklist

- **A separate scratch database.** Examples run against a FalkorDB that is flushed (`FLUSHALL` and `GRAPH.UDF FLUSH`) before every run. Use a dedicated, unauthenticated server on a private network, or the managed local one (127.0.0.1:6390). Never point it at the org graph's server: Staleproof refuses when the host and port match, but a different address for the same server is not detected.
- **Authentication and rate limits.** The API has no authentication, only a limit of 30 POST requests per client per hour, counted in memory per process. Put an authenticating proxy in front of a public deployment. The limit keys on `Fly-Client-IP`, else the first `X-Forwarded-For` entry: make your proxy overwrite `X-Forwarded-For`, or a client can pick its own key; without a proxy, all clients share one bucket.
- **`GITHUB_TOKEN`.** Without it, ingestion shares GitHub's 60 requests per hour per IP address; through the GitHub API (Vercel) one new pull request costs up to five requests.
- **Function region next to FalkorDB.** Set `regions` in `vercel.json` to the region nearest your FalkorDB; a check makes dozens of graph round trips.
- **Snapshot fallback.** Run `npm run snapshot` against the production graph before you build, so the page a visitor sees when the database is unreachable is recent. It is labelled with the time it was taken.
- **Time budget.** On Vercel, keep `STALEPROOF_CHECK_BUDGET_MS` well under the function's 300 s. A function killed mid-check leaves its `Check` node `running`.
- **Model settings.** For an Anthropic-compatible provider, set `STALEPROOF_MODEL` to the provider's model; a `claude-*` name is refused and every agent check fails. `GET /api/health` shows the model and provider the server will use.
- **Persistent storage.** On a VM, keep `STALEPROOF_HOME` on a volume, or virtualenvs and clones are rebuilt after every restart. Back up the FalkorDB data: verdicts, decisions, runs and checks live only in the graph.
- **Re-indexing.** Index all of an organisation's repositories in one `index` command, so cross-repository edges are resolved together. A re-index marks vanished symbols and sections `gone`, and it removes the late links that earlier pull request ingestion created; already-ingested pull requests are not ingested again.
- **Isolation for runs.** The sandbox is a guard, not a security boundary: it blocks network and DNS at the Python socket level, the example process inherits no environment, and the install step, which runs the repositories' build code, gets only an allow-list (paths, locale, proxies, certificates, `UV_*` and `PIP_*`), so neither sees `FALKORDB_URL`, model keys or `GITHUB_TOKEN`. Installs do reach the network to fetch dependencies. Run the server in a container when it executes examples from repositories you do not control.

## Related

- [Configuration](configuration.md): every variable and its default
- [HTTP API](http-api.md): routes, rate limits and snapshot mode
- [GitHub Action](github-action.md)
- [Example runner](example-runner.md): the sandbox and the scratch server
- [Troubleshooting and FAQ](troubleshooting.md)
