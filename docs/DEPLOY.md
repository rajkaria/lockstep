# Deploying Lockstep

Lockstep is one Node.js process (`lockstep-docs serve`: web demo + API) plus FalkorDB. The example
runner needs `git`, `tar` and [uv](https://docs.astral.sh/uv/) on the host (it builds a virtualenv per
repository commit and runs each docs example in it).

| Variable | Default | Meaning |
|---|---|---|
| `FALKORDB_URL` | `falkor://localhost:6379` | The FalkorDB holding the org graph (`falkors://user:pass@host:port` for TLS / FalkorDB Cloud) |
| `LOCKSTEP_ORG` | `falkordb` | Graph name: one graph per organisation |
| `LOCKSTEP_SCRATCH_URL` | — | A **separate** FalkorDB the docs examples run against. It is flushed before every run; Lockstep refuses to flush the server named in `FALKORDB_URL` |
| `LOCKSTEP_SCRATCH_PORT` | `6390` | Without `LOCKSTEP_SCRATCH_URL`, Lockstep starts its own scratch server on this local port (falkordblite binaries, no Docker) |
| `ANTHROPIC_API_KEY` | — | Turns on agent mode (the model chooses the tools and writes verdicts). Without it the server runs graph mode and says so |
| `ANTHROPIC_BASE_URL` | Claude API | Point the agent at an Anthropic-compatible provider instead, e.g. `https://api.deepseek.com/anthropic` with a DeepSeek key in `ANTHROPIC_API_KEY`. Lockstep then sends only the portable request fields (thinking, effort, tools; no betas or refusal fallback) and requires `LOCKSTEP_MODEL` to name the provider's model |
| `LOCKSTEP_MODEL` / `LOCKSTEP_EFFORT` | `claude-sonnet-5-5` / `medium` | Agent model and effort (`deepseek-v4-pro` on DeepSeek) |
| `LOCKSTEP_FALLBACKS` | on | `off` disables server-side refusal fallback (needed off Anthropic's first-party API) |
| `GITHUB_TOKEN` | — | Raises the GitHub API limit (60/hour without); needed for `patch --open-pr` |
| `LOCKSTEP_PRELOADED` | three FalkorDB PRs | Comma-separated PR URLs shown on the home page |
| `LOCKSTEP_HOME` | `~/.lockstep` | Clones, response cache, virtualenvs |
| `LOCKSTEP_RUN_TIMEOUT_MS` | `30000` | Per-example timeout |
| `PORT` / `HOST` | `8080` / `127.0.0.1` | Bind address for `serve` (`0.0.0.0` in the Docker image) |

## Vercel

The repository deploys to Vercel as is (`vercel.json`): the web UI is static (`web/dist`) and the API runs as a Vercel
Function (`api/[...route].js`). On Vercel, pull requests are read through the GitHub API (no `git`), and examples are
not executed (no sandbox runtime) — runs recorded by a local or container host are answered from the graph.

1. Create a FalkorDB the function can reach (FalkorDB Cloud's free tier works) and index into it from your machine:
   ```bash
   export FALKORDB_URL='falkor://falkordb:<password>@<host>:<port>'   # falkors:// if the endpoint has TLS
   npx -y lockstep-docs index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
   bash scripts/seed.sh          # re-index, then graph-mode checks of the preloaded PRs with example runs, stored on the graph
   ```
2. `vercel env add FALKORDB_URL production` (and optionally `ANTHROPIC_API_KEY` — plus `ANTHROPIC_BASE_URL` and
   `LOCKSTEP_MODEL` for an Anthropic-compatible provider — and `GITHUB_TOKEN`), then redeploy.

Without `FALKORDB_URL` the function answers 503 and the UI shows the snapshot bundled at build time
(`npm run snapshot` regenerates `web/public/snapshot.json` from a local graph), labelled with the time it was taken.
Function duration is capped at 300 s, and the function runs in `bom1` (Mumbai), next to the FalkorDB Cloud instance in
AWS `ap-south-1`: a check makes dozens of graph round trips, so set `regions` in `vercel.json` to the Vercel region
closest to your FalkorDB.

## Docker Compose (any VM)

```bash
docker compose up -d --build
docker compose exec lockstep node dist/cli.js index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
docker compose exec lockstep bash scripts/seed.sh   # optional: index + graph-mode checks of the preloaded PRs
```

The compose file runs two FalkorDB containers: `falkordb` (the graph, persisted in a volume) and
`scratch` (examples only). Put a TLS-terminating proxy in front of port 8080 for a public demo.

> The Dockerfile and compose file are written but were not built on the machine Lockstep was developed
> on (no Docker there). Everything else in this document was run.

## Without Docker

```bash
npx -y lockstep-docs db start                 # FalkorDB on :6379 from the falkordblite wheel (uv fetches Python 3.12)
npx -y lockstep-docs index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
npx -y lockstep-docs serve --host 0.0.0.0 --port 8080
```

## FalkorDB Cloud

Create a free instance; its Connectivity tab gives the public endpoint and Instance Details the password for user
`falkordb`. The free tier's endpoint is plain TCP: `FALKORDB_URL=falkor://falkordb:<password>@<host>:<port>`
(URL-encode the password; use `falkors://` for an endpoint with TLS). Keep
`LOCKSTEP_SCRATCH_URL` pointing at a different, disposable server (or leave it unset to use the local one).

## Claude Code (MCP)

```bash
claude mcp add lockstep -e FALKORDB_URL=falkor://localhost:6379 -e LOCKSTEP_ORG=falkordb -- npx -y lockstep-docs mcp
```

## GitHub Action

See [`examples/lockstep.yml`](../examples/lockstep.yml). Store the FalkorDB URL as the
`LOCKSTEP_FALKORDB_URL` secret; add `ANTHROPIC_API_KEY` for agent verdicts.
