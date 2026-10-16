# Configuration

`lockstep-docs` is configured by environment variables and a few command-line flags; there is no configuration file, and it does not load `.env` files. This page lists every variable the code reads, with its default, its meaning and the commands that use it, then the global CLI options and their precedence, the files kept under `LOCKSTEP_HOME`, and complete configurations for local development, FalkorDB Cloud with DeepSeek, CI and Vercel. It is for anyone setting up the CLI, the server, the GitHub Action or a deployment.

## The variables you usually set

```bash
export FALKORDB_URL='falkor://localhost:6379'    # the FalkorDB holding the org graph (this is the default)
export LOCKSTEP_ORG=falkordb                      # graph name, one per organisation (this is the default)
export GITHUB_TOKEN=<token>                       # raises the GitHub API limit of 60 requests/hour
export ANTHROPIC_API_KEY=<key>                    # agent mode; without it, use graph mode (--no-agent)
```

Everything else has a working default. Agent mode on an Anthropic-compatible provider such as DeepSeek also needs `ANTHROPIC_BASE_URL` and `LOCKSTEP_MODEL` ([below](#model-agent-mode)).

## Environment variables

`loadConfig` ([src/config.ts](../src/config.ts)) reads most of them once, when a command starts. Every command except `db` loads it, so an invalid value (for example in `LOCKSTEP_EFFORT`) stops every command, not only the ones that use it.

| Variable | Default | Meaning | Used by |
|---|---|---|---|
| `FALKORDB_URL` | `falkor://localhost:6379` | The FalkorDB server holding the org graph | every command except `db`; Vercel function; `npm run snapshot` |
| `LOCKSTEP_ORG` | `falkordb` | Organisation, which names the graph | same |
| `LOCKSTEP_HOME` | `~/.lockstep`; `/tmp/lockstep` when `VERCEL` is set | Clones, GitHub cache, virtualenvs, local FalkorDB | `index`, `check`, `run`, `patch`, `mcp`, `serve`, `db` |
| `GITHUB_TOKEN` | — | GitHub API token | pull request ingestion (`check`, `run --pr`, `serve`, `mcp`); required by `patch --open-pr` |
| `GH_TOKEN` | — | Used when `GITHUB_TOKEN` is unset | same |
| `LOCKSTEP_INGEST` | — | `github`: ingest pull requests through the GitHub API even when git is installed | pull request ingestion |
| `ANTHROPIC_API_KEY` | — | Model API key (Claude API or an Anthropic-compatible provider) | `check` (agent mode), `serve`, Vercel function |
| `ANTHROPIC_BASE_URL` | Claude API | Model endpoint; a host other than `api.anthropic.com` switches to compatible mode | same |
| `LOCKSTEP_MODEL` | `claude-sonnet-5-5` | Agent model | same; `check --model` overrides |
| `LOCKSTEP_EFFORT` | `medium` | `low`, `medium`, `high`, `xhigh` or `max` | same; `check --effort` overrides |
| `LOCKSTEP_FALLBACKS` | on | `off` disables the server-side refusal fallback (Claude API only) | same |
| `LOCKSTEP_SCRATCH_URL` | — | A separate FalkorDB that docs examples run against (host and port only) | example runs: `run`, `check`, `serve`, `mcp` |
| `LOCKSTEP_SCRATCH_PORT` | `6390` | Port of the scratch server Lockstep starts itself, when `LOCKSTEP_SCRATCH_URL` is unset | same |
| `LOCKSTEP_RUN_TIMEOUT_MS` | `30000` | Time limit of one example run, in milliseconds | same |
| `LOCKSTEP_CHECK_BUDGET_MS` | `240000` when `VERCEL` is set, else none | Wall-clock budget of one agent check in the server | `serve`, Vercel function (not `check`) |
| `LOCKSTEP_PRELOADED` | falkordb-py #262, #267, #276 | Comma-separated pull request URLs listed on the home page | `serve` (`--preload` overrides), Vercel function, `npm run snapshot`, `scripts/seed.sh` |
| `PORT` | `8080` | Port `serve` listens on | `serve` (`--port` overrides) |
| `HOST` | `127.0.0.1` | Interface `serve` binds | `serve` (`--host` overrides) |
| `VERCEL` | — | Set by Vercel; changes the defaults of `LOCKSTEP_HOME` and `LOCKSTEP_CHECK_BUDGET_MS` | all |
| `USER` | — | Default reviewer name for `verdict --by` (else `maintainer`) | `verdict` |
| `FALKORDBLITE_VERSION` | `0.10.0` | The `falkordblite` wheel that provides the local FalkorDB binaries | `db`, the managed scratch server |
| `FACTS_OUT` | `docs/FACTS.md` | Where `scripts/seed.sh` writes FACTS.md | `scripts/seed.sh` |

Credential detection also reads `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, `ANTHROPIC_CONFIG_DIR` and `XDG_CONFIG_HOME` ([details](#model-agent-mode)). The sandbox shim reads `LOCKSTEP_SCRATCH_HOST`, `LOCKSTEP_SCRATCH_PORT` and `LOCKSTEP_DB_PORTS` inside the example process ([details](#example-runner)).

Empty values: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `LOCKSTEP_SCRATCH_URL`, `LOCKSTEP_CHECK_BUDGET_MS` and `VERCEL` treat an empty string as unset. The others take it literally: an empty `GITHUB_TOKEN` hides `GH_TOKEN`, an empty `LOCKSTEP_PRELOADED` lists no pull requests, an empty `LOCKSTEP_ORG` fails with `invalid org name: ""`, an empty `LOCKSTEP_EFFORT` fails validation, and an empty number becomes 0. Unset a variable instead of setting it to an empty string; note that Docker Compose's `${VAR:-}` passes an empty string.

### Graph and organisation

**`FALKORDB_URL`** is passed to the `falkordb` client, which turns a leading `falkor` into `redis` and hands the URL to node-redis:

| Form | Meaning |
|---|---|
| `falkor://host:port` | Plain TCP (the FalkorDB Cloud free tier endpoint is plain TCP) |
| `falkors://host:port` | TLS |
| `falkor://user:password@host:port` | With credentials; FalkorDB Cloud's user is `falkordb` |
| `redis://...`, `rediss://...` | Accepted as is |

The user name and password are URL-decoded, so percent-encode any reserved character in them (`@` is `%40`, `:` is `%3A`, `/` is `%2F`, `#` is `%23`, `%` is `%25`). Error messages show the URL with the password replaced by `***`. The connection times out after 5 seconds; after a dropped connection the client retries 4 times, waiting 200 ms and doubling up to 2 s, then gives up with `FalkorDB unreachable`. One server can hold any number of org graphs.

**`LOCKSTEP_ORG`** names the graph. It is slugged: trimmed, lowercased, every run of characters other than `a-z`, `0-9`, `_` and `-` replaced by `-`, leading and trailing `-` removed. `Acme Inc` becomes `acme-inc`. A name with nothing left fails with `invalid org name: "<name>"`. Each organisation is a separate graph on the same server; indexing, checks and memory never cross between graphs.

**`LOCKSTEP_HOME`** is where files are kept ([layout](#files-under-lockstep_home)). On Vercel the default is `/tmp/lockstep`, because a function's file system is read-only except `/tmp`. The Docker image sets it to `/data`.

### GitHub

**`GITHUB_TOKEN`**, else **`GH_TOKEN`**, is sent as a bearer token to `api.github.com`. Without one, GitHub allows 60 requests per hour per IP address, and the error is `GitHub API rate limit reached (60/hour without a token). Set GITHUB_TOKEN to raise it.`

- **What uses the API**: ingesting a pull request (once per pull request; later checks reuse the graph). With git, that is one request for the metadata, cached on disk for merged pull requests. Without git, or with `LOCKSTEP_INGEST=github`, it is up to five (metadata, the commit range, the changed files and the file list at both commits); file contents come from `raw.githubusercontent.com`, which the code treats as outside the API limit. Indexing does not use the API: it clones over unauthenticated HTTPS.
- **`patch --open-pr`** refuses to run without a token (`opening a pull request needs GITHUB_TOKEN`). The token must be able to fork the docs repository, push a branch to the fork and open a pull request; for a classic token that is the `public_repo` scope.
- Only public repositories work: a 404 is reported as `GitHub: <path> not found (private repositories are not supported)`.

**`LOCKSTEP_INGEST=github`** makes pull request ingestion read commits through the GitHub API, the path serverless hosts take automatically because they have no git. It changes nothing else: example runs still need git.

### Model (agent mode)

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Passed to the Anthropic SDK as the API key. Its presence turns on agent mode in `serve` |
| `ANTHROPIC_BASE_URL` | Unset or empty: the Claude API. A URL whose host is not `api.anthropic.com` (or that does not parse) switches on compatible mode |
| `LOCKSTEP_MODEL` | Model name; default `claude-sonnet-5-5`. `check --model` overrides it |
| `LOCKSTEP_EFFORT` | `low`, `medium` (default), `high`, `xhigh` or `max`. Any other value fails every command except `db` with `LOCKSTEP_EFFORT must be one of low, medium, high, xhigh, max`, even when `--effort` is also given. `check --effort` itself is not checked locally; an unknown value is sent to the model API as is |
| `LOCKSTEP_FALLBACKS` | Exactly `off` disables the server-side refusal fallback. It only matters on the Claude API: compatible mode never sends it, so there is no need to set it for DeepSeek |

**Compatible mode** sends only the portable fields of the Messages API: `model`, `max_tokens`, `system` (as a plain string), `tools`, `messages`, `thinking` (`{type: "enabled", budget_tokens: min(16000, max_tokens - 1000)}`) and `output_config.effort`. It sends no beta flags, no refusal fallback, no prompt caching and no eager input streaming. It refuses a model name starting with `claude-` (any case), because a compatible provider would answer with its own model under that name and every trace would be mislabelled:

```text
"claude-sonnet-5-5" is a Claude model name, but the model endpoint is an Anthropic-compatible provider, which would answer with its own model under that name; set LOCKSTEP_MODEL to the provider's model (e.g. deepseek-v4-pro)
```

Setting `ANTHROPIC_BASE_URL` without `LOCKSTEP_MODEL` therefore always hits this error.

**Credentials** are found when any of these holds; otherwise agent mode fails with `the agent needs model API credentials: ...` and `serve` runs graph mode only:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_PROFILE` is set;
- `ANTHROPIC_FEDERATION_RULE_ID` is set with `ANTHROPIC_IDENTITY_TOKEN` or `ANTHROPIC_IDENTITY_TOKEN_FILE`;
- the Anthropic config directory exists: `ANTHROPIC_CONFIG_DIR`, else `$XDG_CONFIG_HOME/anthropic`, else `~/.config/anthropic` (created by `ant auth login`).

Each model turn may produce up to 32,000 tokens. There is no variable for it; the library's `AnthropicModel` takes `maxTokens`.

### Example runner

The runner installs the repositories at the commits before and after a pull request and runs a docs example against a scratch FalkorDB ([Example runner](example-runner.md)).

| Variable | Effect |
|---|---|
| `LOCKSTEP_SCRATCH_URL` | Use this server as the scratch database. Only the host and port are read (`[scheme://]host[:port]`, default port 6379); the scheme is ignored and TLS is not used. A URL with credentials is refused: `LOCKSTEP_SCRATCH_URL must not carry credentials: docs examples connect to the scratch server without a password`. Lockstep does not start or stop this server |
| `LOCKSTEP_SCRATCH_PORT` | Without `LOCKSTEP_SCRATCH_URL`, Lockstep starts its own scratch server on `127.0.0.1:<port>` (default 6390) with `scripts/falkordb-local.sh`, the same falkordblite binaries as `lockstep-docs db start` |
| `LOCKSTEP_RUN_TIMEOUT_MS` | Each run (before and after are separate runs) is killed after this many milliseconds and recorded as `timeout` with the reason `no exit after <s>s`. Default 30000. Creating a virtualenv (300 s) and installing into it (600 s) have fixed limits |

The scratch server is flushed before every run (`FLUSHALL`, then `GRAPH.UDF FLUSH`). Lockstep refuses to flush the server that holds the org graph: when the scratch host and port equal those of `FALKORDB_URL` (`localhost` and `127.0.0.1` count as the same host), each run ends with status `error` and the reason `refusing to flush <host>:<port>: it is the server holding the org graph (FALKORDB_URL). Point LOCKSTEP_SCRATCH_URL / LOCKSTEP_SCRATCH_PORT at a separate server.`

Inside the sandbox, the example process inherits no environment. The runner sets `LOCKSTEP_SCRATCH_HOST` and `LOCKSTEP_SCRATCH_PORT` for the network shim, which sends connections to a local host on the ports in `LOCKSTEP_DB_PORTS` (default `6379`) to the scratch server. Lockstep never sets `LOCKSTEP_DB_PORTS`, and because nothing is inherited you cannot set it either: the remapped port is always 6379.

The install step (`uv venv` and `uv pip install`, or `python3 -m venv` and `pip install`) runs the repositories' build code at the pull request's commits, so it gets an allow-listed environment, not the server's: only the variables matching `INSTALL_ENV` in [src/runner/sandbox.ts](../src/runner/sandbox.ts) are passed on.

| Passed to the install step | Variables |
|---|---|
| Paths and user | `PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `USER`, `LOGNAME`, `SHELL`, `XDG_CACHE_HOME`, `XDG_DATA_HOME` |
| Locale and time | `LANG`, `LC_*`, `TZ` |
| Package tools | every `UV_*` and `PIP_*` variable |
| Proxies | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` (and their lowercase forms) |
| Certificates | `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` |
| Windows | `SYSTEMROOT`, `COMSPEC`, `PATHEXT` |

Everything else, including `FALKORDB_URL`, `ANTHROPIC_API_KEY` and `GITHUB_TOKEN`, is withheld. uv and pip settings such as `UV_INDEX_URL` or `PIP_INDEX_URL` (a package mirror) still apply, and the Docker image's `UV_PYTHON_INSTALL_DIR=/data/python` and `UV_CACHE_DIR=/data/uv-cache` reach uv the same way. Any other variable a repository's build reads is not set.

### Server

| Variable | Effect |
|---|---|
| `PORT`, `HOST` | Address of `lockstep-docs serve`; `--port` and `--host` override them. The Docker image sets `HOST=0.0.0.0` and `PORT=8080`. Not used on Vercel |
| `LOCKSTEP_PRELOADED` | Comma-separated pull request URLs listed on the home page and by `GET /api/prs`; spaces around entries are trimmed and empty entries dropped. `serve --preload <url...>` overrides it. Unset: falkordb-py #262, #267 and #276. Every entry must be a pull request URL, or `GET /api/prs` answers 500 |
| `LOCKSTEP_CHECK_BUDGET_MS` | After this many milliseconds, an agent check in the server starts no new model turn and ends `incomplete`, listing the sections still open. Default 240000 on Vercel (whose function limit is 300 s in [vercel.json](../vercel.json)), none elsewhere. `lockstep-docs check` ignores it. `0` ends every agent check before its first turn |
| `VERCEL` | Any non-empty value. Vercel sets it, which moves `LOCKSTEP_HOME` to `/tmp/lockstep` and sets the 240 s check budget |

The HTTP rate limit (30 POST requests per client per hour) has no variable; see [HTTP API](http-api.md#rate-limits).

### Scripts and helpers

- **`FALKORDBLITE_VERSION`** (default `0.10.0`) is the version of the `falkordblite` Python wheel that `scripts/falkordb-local.sh` installs into `$LOCKSTEP_HOME/falkordb/venv` (with uv, else `python3 -m venv` and pip). It provides `redis-server` and the FalkorDB module for `lockstep-docs db start` and for the managed scratch server. That build is FalkorDB 4.18.3 ([version notes](troubleshooting.md#falkordb-version-notes)).
- **`FACTS_OUT`** is where `scripts/seed.sh` writes FACTS.md (default `docs/FACTS.md`, relative to the working directory).
- **`USER`** is the default for `verdict --by`.

## Global CLI options and precedence

| Option | Overrides | Default |
|---|---|---|
| `--org <org>` | `LOCKSTEP_ORG` | `falkordb` |
| `--db <url>` | `FALKORDB_URL` | `falkor://localhost:6379` |

Both may come before or after the command (`lockstep-docs --org acme index ...` and `lockstep-docs index ... --org acme` are the same). The general rule is flag, then environment variable, then default:

| Setting | Flag | Variable | Default |
|---|---|---|---|
| Graph name | `--org` | `LOCKSTEP_ORG` | `falkordb` |
| FalkorDB URL | `--db` | `FALKORDB_URL` | `falkor://localhost:6379` |
| Agent model | `check --model` | `LOCKSTEP_MODEL` | `claude-sonnet-5-5` |
| Effort | `check --effort` | `LOCKSTEP_EFFORT` | `medium` |
| Server port | `serve --port` | `PORT` | `8080` |
| Server interface | `serve --host` | `HOST` | `127.0.0.1` |
| Preloaded pull requests | `serve --preload` | `LOCKSTEP_PRELOADED` | falkordb-py #262, #267, #276 |
| Reviewer | `verdict --by` | `USER` | `maintainer` |
| Local FalkorDB port | `db --port` | — | `6379` |

The other limits are flags only: `check --max-steps` (40), `check --no-agent --max-hops` (3) and `--runs` (3). Every command and option is in [CLI](cli.md).

## Files under LOCKSTEP_HOME

```text
~/.lockstep/                                  LOCKSTEP_HOME
  repos/<owner>/<name>/                       blob-less git clones: indexing, PR ingestion, example installs,
                                              the docs patch, clearance's text-match counts
  cache/github/<owner>/<repo>/pulls/<n>.json  pull request metadata (read back only for merged PRs)
  venvs/<key>/                                one virtualenv per set of repo@sha, marked done by .lockstep-ok
  src/<key>/<owner>__<name>/                  sources extracted while a virtualenv builds; removed after a successful build
  falkordb/venv/                              falkordblite, installed on first `db start` or scratch start
  falkordb/data-<port>/                       data (RDB snapshots), redis.log and redis.pid of each local server
```

- **`falkordb/data-6379`** holds the org graph when you run `lockstep-docs db start`, including every verdict, decision and run. Deleting it deletes the graph. `data-6390` is the scratch server, which is flushed before every run anyway.
- **`venvs/` and `src/`** can be deleted at any time; virtualenvs are rebuilt on the next run that needs them.
- **`repos/`** can be deleted; clones come back on the next index or check. Until then, `clearance` reports 0 raw text matches and the docs patch reads files from GitHub instead.
- **`cache/`** can be deleted; metadata is fetched again.
- Each example run also uses a temporary directory, `$TMPDIR/lockstep-run-*`, removed when the run ends.

## Configurations that work together

### Local development

```bash
npx -y lockstep-docs db start                 # FalkorDB on 127.0.0.1:6379, data in ~/.lockstep/falkordb/data-6379
export GITHUB_TOKEN=<token>                   # optional: more than 60 GitHub requests per hour
export ANTHROPIC_API_KEY=<key>                # optional: agent mode
npx -y lockstep-docs index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
npx -y lockstep-docs check https://github.com/FalkorDB/falkordb-py/pull/262 --no-agent
npx -y lockstep-docs serve
```

No other variable is needed: `FALKORDB_URL` and `LOCKSTEP_ORG` defaults match `db start`, and the scratch server for example runs starts by itself on port 6390. The host needs `git`, plus `uv` or `python3` (uv is recommended: it pins Python 3.12 for the sandbox; with `python3` the version is whatever the host has).

### FalkorDB Cloud and DeepSeek

```bash
export FALKORDB_URL='falkor://falkordb:<url-encoded password>@<host>:<port>'   # falkors:// if the endpoint has TLS
export LOCKSTEP_ORG=falkordb
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_API_KEY=<DeepSeek API key>
export LOCKSTEP_MODEL=deepseek-v4-pro
export GITHUB_TOKEN=<token>
npx -y lockstep-docs check https://github.com/FalkorDB/falkordb-py/pull/267
```

The live demo's agent mode uses this provider and model. Leave `LOCKSTEP_SCRATCH_URL` unset so example runs use the local scratch server on 127.0.0.1:6390, never the cloud database. `LOCKSTEP_FALLBACKS` needs no setting: compatible mode never sends the fallback.

### CI (GitHub Action)

The [GitHub Action](github-action.md) sets the variables from its inputs: `falkordb-url` becomes `FALKORDB_URL`, `org` becomes `LOCKSTEP_ORG`, `github-token` (default: the workflow's token) becomes `GITHUB_TOKEN`, and `anthropic-api-key` becomes `ANTHROPIC_API_KEY`. With an empty key the action runs `check --no-agent --format markdown`. It has no inputs for the model provider; set those as job environment variables, which the action's steps inherit:

```yaml
jobs:
  docs:
    runs-on: ubuntu-latest
    env:
      ANTHROPIC_BASE_URL: https://api.deepseek.com/anthropic   # only for an Anthropic-compatible provider
      LOCKSTEP_MODEL: deepseek-v4-pro
    steps:
      - uses: rajkaria/lockstep/action@main
        with:
          falkordb-url: ${{ secrets.LOCKSTEP_FALKORDB_URL }}
          org: falkordb
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The workflow also needs `permissions: pull-requests: write` to post the comment ([examples/lockstep.yml](../examples/lockstep.yml)). On the runner, `LOCKSTEP_HOME` is the default `~/.lockstep`, which starts empty on every job. The action is written but has not been run on a live repository yet.

### Vercel

```bash
vercel env add FALKORDB_URL production          # required
vercel env add GITHUB_TOKEN production          # recommended: ingestion there goes through the GitHub API
vercel env add ANTHROPIC_API_KEY production     # optional: agent mode
vercel env add ANTHROPIC_BASE_URL production    # with LOCKSTEP_MODEL, for an Anthropic-compatible provider
vercel env add LOCKSTEP_MODEL production
vercel env add LOCKSTEP_PRELOADED production    # optional
```

Vercel sets `VERCEL`, so `LOCKSTEP_HOME` is `/tmp/lockstep` and agent checks stop at 240 s. `PORT`, `HOST` and the scratch variables are not used: the function serves no static files and executes no examples. [Deploy](DEPLOY.md#vercel) has the full procedure.

## Related

- [CLI](cli.md): every command and flag
- [Deploy](DEPLOY.md): Vercel, Docker Compose, FalkorDB Cloud and a production checklist
- [Example runner](example-runner.md): the sandbox and the scratch server
- [The agent](agent.md): model providers, budgets and graph mode
- [Troubleshooting and FAQ](troubleshooting.md)
