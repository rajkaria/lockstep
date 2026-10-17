# Configuration

`staleproof` is configured by environment variables and a few command-line flags; it has no configuration file of its own and does not load `.env` files. Nothing has to be set: with no variables, the CLI starts a local FalkorDB and names each graph after the repository's owner. A repository being indexed can carry a small file of its own, `.staleproof.toml`, to leave paths out or mark examples not to run. This page lists every variable the code reads, with its default, its meaning and the commands that use it, then the global CLI options and their precedence, the files kept under `STALEPROOF_HOME`, the repository configuration and example directives, and complete configurations for local development, FalkorDB Cloud with DeepSeek, CI and Vercel. It is for anyone setting up the CLI, the server, the GitHub Action or a deployment.

## The variables you usually set

```bash
export FALKORDB_URL='falkor://localhost:6379'    # the FalkorDB holding the org graph (this is the default)
export STALEPROOF_ORG=acme                          # graph name, one per organisation (default: the repository's owner)
export GITHUB_TOKEN=<token>                       # private repositories; raises the GitHub API limit of 60 requests/hour
export ANTHROPIC_API_KEY=<key>                    # agent mode; without it, use graph mode (--no-agent)
```

Everything else has a working default. Agent mode on an Anthropic-compatible provider such as DeepSeek also needs `ANTHROPIC_BASE_URL` and `STALEPROOF_MODEL` ([below](#model-agent-mode)).

## Environment variables

`loadConfig` ([src/config.ts](../src/config.ts)) reads most of them once, when a command starts. Every command except `db` loads it, so an invalid value (for example in `STALEPROOF_EFFORT`) stops every command, not only the ones that use it.

Staleproof was first published as Lockstep (npm `lockstep-docs`). Every `STALEPROOF_*` variable is also read under its former name, `LOCKSTEP_*`, when the new one is unset, and an existing `~/.lockstep` is used as the home when `~/.staleproof` does not exist, so deployments and caches made under the old name keep working.

| Variable | Default | Meaning | Used by |
|---|---|---|---|
| `FALKORDB_URL` | `falkor://localhost:6379` | The FalkorDB server holding the org graph. Unset (and no `--db`), the CLI starts a local server on that address when nothing answers there | every command except `db`; Vercel function; `npm run snapshot` |
| `STALEPROOF_ORG` | the owner of the repository a command is about, else `falkordb` | Organisation, which names the graph. In a hosted server: the curated graph | same |
| `STALEPROOF_HOME` | `~/.staleproof`; `/tmp/staleproof` when `VERCEL` is set | Clones, downloaded tarballs, GitHub cache, virtualenvs, local FalkorDB | `index`, `check`, `run`, `patch`, `mcp`, `serve`, `db` |
| `GITHUB_TOKEN` | — | GitHub token for the API, git clones, tarball downloads and file reads, so private repositories work | indexing, pull request ingestion (`check`, `run --pr`, `serve`, `mcp`), the docs patch, hosted pull request reads (hosted downloads never send it, so a hosted server indexes public repositories only); required by `patch --open-pr` |
| `GH_TOKEN` | — | Used when `GITHUB_TOKEN` is unset | same |
| `STALEPROOF_INGEST` | — | `github`: work as if git were missing even when it is installed: download repositories as tarballs and ingest pull requests through the GitHub API | indexing, pull request ingestion |
| `STALEPROOF_HOSTED` | Vercel function: on; `serve`: off | Hosted mode: any public repository is indexed on demand into a workspace graph of its own. The Vercel function turns it off only for `off`; `serve` turns it on only for `on` (or `--hosted`) | Vercel function, `serve` |
| `STALEPROOF_AGENT_CHECKS_PER_DAY` | `50` | Agent checks a hosted server starts per day (UTC), across all callers; over it, `POST /api/check` with `mode: "agent"` answers 429 | Vercel function and `serve --hosted` |
| `ANTHROPIC_API_KEY` | — | Model API key (Claude API or an Anthropic-compatible provider) | `check` (agent mode), `serve`, Vercel function |
| `ANTHROPIC_BASE_URL` | Claude API | Model endpoint; a host other than `api.anthropic.com` switches to compatible mode | same |
| `STALEPROOF_MODEL` | `claude-sonnet-5-5` | Agent model | same; `check --model` overrides |
| `STALEPROOF_EFFORT` | `medium` | `low`, `medium`, `high`, `xhigh` or `max` | same; `check --effort` overrides |
| `STALEPROOF_FALLBACKS` | on | `off` disables the server-side refusal fallback (Claude API only) | same |
| `STALEPROOF_SCRATCH_URL` | — | A separate FalkorDB that docs examples run against (host and port only) | example runs: `run`, `check`, `serve`, `mcp` |
| `STALEPROOF_SCRATCH_PORT` | `6390` | Port of the scratch server Staleproof starts itself, when `STALEPROOF_SCRATCH_URL` is unset | same |
| `STALEPROOF_RUN_TIMEOUT_MS` | `30000` | Time limit of one example run, in milliseconds | same |
| `STALEPROOF_CHECK_BUDGET_MS` | `240000` when `VERCEL` is set, else none | Wall-clock budget of one agent check in the server | `serve`, Vercel function (not `check`) |
| `STALEPROOF_PRELOADED` | falkordb-py #262, #267, #276 | Comma-separated pull request URLs listed on the home page | `serve` (`--preload` overrides), Vercel function, `npm run snapshot`, `scripts/seed.sh` |
| `STALEPROOF_HOOK` | — | `off`, `warn` or `block`: what the coding-agent hooks do, over `[hooks] stop` in the repository ([Hooks](#hooks)); `off` silences the edit hook too | `hook` |
| `STALEPROOF_CACHE` | on | `off`: parse every file on every run instead of reading the local parse cache (`.staleproof/cache/`) | `lint`, `hook` |
| `STALEPROOF_CACHE_DIR` | — | Keep the parse cache in this folder instead of the checkout's `.staleproof/cache/`; indexing uses the cache only when it is set (the GitHub Action sets it, and keeps the folder between runs) | `lint`, `hook`, `index`, `check`, `audit` |
| `PORT` | `8080` | Port `serve` listens on | `serve` (`--port` overrides) |
| `HOST` | `127.0.0.1` | Interface `serve` binds | `serve` (`--host` overrides) |
| `VERCEL` | — | Set by Vercel; changes the defaults of `STALEPROOF_HOME` and `STALEPROOF_CHECK_BUDGET_MS` | all |
| `USER` | — | Default reviewer name for `verdict --by` (else `maintainer`) | `verdict` |
| `FALKORDBLITE_VERSION` | `0.10.0` | The `falkordblite` wheel that provides the local FalkorDB binaries | `db`, the managed scratch server |
| `FACTS_OUT` | `docs/FACTS.md` | Where `scripts/seed.sh` writes FACTS.md | `scripts/seed.sh` |

Credential detection also reads `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, `ANTHROPIC_CONFIG_DIR` and `XDG_CONFIG_HOME` ([details](#model-agent-mode)). The sandbox shim reads `STALEPROOF_SCRATCH_HOST`, `STALEPROOF_SCRATCH_PORT` and `STALEPROOF_DB_PORTS` inside the example process ([details](#example-runner)).

Empty values: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `STALEPROOF_SCRATCH_URL`, `STALEPROOF_CHECK_BUDGET_MS` and `VERCEL` treat an empty string as unset. The others take it literally: an empty `GITHUB_TOKEN` hides `GH_TOKEN`, an empty `STALEPROOF_PRELOADED` lists no pull requests, an empty `STALEPROOF_ORG` fails with `invalid org name: ""`, an empty `STALEPROOF_EFFORT` fails validation, and an empty number becomes 0. Unset a variable instead of setting it to an empty string; note that Docker Compose's `${VAR:-}` passes an empty string.

### Graph and organisation

**`FALKORDB_URL`** is passed to the `falkordb` client, which turns a leading `falkor` into `redis` and hands the URL to node-redis:

| Form | Meaning |
|---|---|
| `falkor://host:port` | Plain TCP (the FalkorDB Cloud free tier endpoint is plain TCP) |
| `falkors://host:port` | TLS |
| `falkor://user:password@host:port` | With credentials; FalkorDB Cloud's user is `falkordb` |
| `redis://...`, `rediss://...` | Accepted as is |

The user name and password are URL-decoded, so percent-encode any reserved character in them (`@` is `%40`, `:` is `%3A`, `/` is `%2F`, `#` is `%23`, `%` is `%25`). Error messages show the URL with the password replaced by `***`. The connection times out after 5 seconds; after a dropped connection the client retries 4 times, waiting 200 ms and doubling up to 2 s, then gives up with `FalkorDB unreachable`. One server can hold any number of org graphs.

**`STALEPROOF_ORG`** names the graph. It is slugged: trimmed, lowercased, every run of characters other than `a-z`, `0-9`, `_` and `-` replaced by `-`, leading and trailing `-` removed. `Acme Inc` becomes `acme-inc`. A name with nothing left fails with `invalid org name: "<name>"`. Each organisation is a separate graph on the same server; indexing, checks and memory never cross between graphs.

**The default graph.** With neither `--org` nor `STALEPROOF_ORG`, a CLI command uses the graph of the owner of the repository it is about, slugged: the first repository of `index`, the pull request of `check` and `patch`, the example id of `run`, the first `--governs` id of `decide`. `check https://github.com/encode/httpx/pull/<n>` reads `encode`; FalkorDB's repositories still land in `falkordb`. Commands that name no repository (`mcp`, `serve`, `verdict`, `facts`) use `falkordb`. Set `STALEPROOF_ORG` when one graph holds repositories of several owners, so every command and the MCP server use the same one.

**Without `FALKORDB_URL`**, a command that cannot reach `localhost:6379` starts a local FalkorDB there (the falkordblite server of `staleproof db start`, installed on first use) instead of failing. With `FALKORDB_URL` or `--db` set, an unreachable server is an error.

**`STALEPROOF_HOME`** is where files are kept ([layout](#files-under-staleproof_home)). On Vercel the default is `/tmp/staleproof`, because a function's file system is read-only except `/tmp`. The Docker image sets it to `/data`.

### GitHub

**`GITHUB_TOKEN`**, else **`GH_TOKEN`**, is the one GitHub credential. With it set, private repositories the token can read work everywhere a public one does:

| Where | How the token is sent |
|---|---|
| `api.github.com` (pull request metadata and diffs, opening docs pull requests) | `Authorization: Bearer <token>` |
| git clones and fetches (indexing, example installs) | Through git's environment configuration (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0`), as an `http.https://github.com/.extraheader`, so only to `https://github.com/`, and never in the remote URL or on a command line. Not added when the environment already sets `GIT_CONFIG_COUNT` |
| Tarball downloads (no git) | From the API's `repos/<owner>/<name>/tarball/<ref>` endpoint instead of `codeload.github.com` |
| `raw.githubusercontent.com` (file contents without a clone) | `Authorization: token <token>` |

Without a token, GitHub allows 60 API requests per hour per IP address, and the error is `GitHub API rate limit reached (60 requests/hour without a token; set GITHUB_TOKEN to raise it). It resets in <n> min.`; a 404 adds `(a private repository needs GITHUB_TOKEN with read access)`.

- **What uses the API**: ingesting a pull request (once per pull request; later checks reuse the graph). With git, that is one request for the metadata, cached on disk for merged pull requests. Without git, or with `STALEPROOF_INGEST=github`, it is up to five (metadata, the commit range, the changed files and the file list at both commits); file contents come from `raw.githubusercontent.com`, which the code treats as outside the API limit. Indexing uses no API request with git (it clones over HTTPS) or without a token (the tarball comes from `codeload.github.com`); a tarball download with a token is one API request.
- **`patch --open-pr`** refuses to run without a token (`opening a pull request needs GITHUB_TOKEN`). The token must be able to fork the docs repository, push a branch to the fork and open a pull request; for a classic token that is the `public_repo` scope. With `--in-repo` there is no fork: the token needs `contents: write` and `pull-requests: write` on the docs repository itself, which is what a GitHub Actions job token can be given for its own repository.
- **A hosted server** downloads with its token, so it can index any repository that token reads, for whoever asks. Give it a fine-grained token limited to public repositories, read-only ([Deploy](DEPLOY.md#hosted-mode)).

**`STALEPROOF_INGEST=github`** makes Staleproof work as it does where git is missing: `index` and indexing on first use download tarballs, and pull request ingestion reads commits through the GitHub API, the paths serverless hosts take automatically. Example runs still need git.

### Model (agent mode)

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Passed to the Anthropic SDK as the API key. Its presence turns on agent mode in `serve` |
| `ANTHROPIC_BASE_URL` | Unset or empty: the Claude API. A URL whose host is not `api.anthropic.com` (or that does not parse) switches on compatible mode |
| `STALEPROOF_MODEL` | Model name; default `claude-sonnet-5-5`. `check --model` overrides it |
| `STALEPROOF_EFFORT` | `low`, `medium` (default), `high`, `xhigh` or `max`. Any other value fails every command except `db` with `STALEPROOF_EFFORT must be one of low, medium, high, xhigh, max`, even when `--effort` is also given. `check --effort` itself is not checked locally; an unknown value is sent to the model API as is |
| `STALEPROOF_FALLBACKS` | Exactly `off` disables the server-side refusal fallback. It only matters on the Claude API: compatible mode never sends it, so there is no need to set it for DeepSeek |

**Compatible mode** sends only the portable fields of the Messages API: `model`, `max_tokens`, `system` (as a plain string), `tools`, `messages`, `thinking` (`{type: "enabled", budget_tokens: min(16000, max_tokens - 1000)}`) and `output_config.effort`. It sends no beta flags, no refusal fallback, no prompt caching and no eager input streaming. It refuses a model name starting with `claude-` (any case), because a compatible provider would answer with its own model under that name and every trace would be mislabelled:

```text
"claude-sonnet-5-5" is a Claude model name, but the model endpoint is an Anthropic-compatible provider, which would answer with its own model under that name; set STALEPROOF_MODEL to the provider's model (e.g. deepseek-v4-pro)
```

Setting `ANTHROPIC_BASE_URL` without `STALEPROOF_MODEL` therefore always hits this error.

**Credentials** are found when any of these holds; otherwise agent mode fails with `the agent needs model API credentials: ...` and `serve` runs graph mode only:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_PROFILE` is set;
- `ANTHROPIC_FEDERATION_RULE_ID` is set with `ANTHROPIC_IDENTITY_TOKEN` or `ANTHROPIC_IDENTITY_TOKEN_FILE`;
- the Anthropic config directory exists: `ANTHROPIC_CONFIG_DIR`, else `$XDG_CONFIG_HOME/anthropic`, else `~/.config/anthropic` (created by `ant auth login`).

Each model turn may produce up to 32,000 tokens. There is no variable for it; the library's `AnthropicModel` takes `maxTokens`.

### Example runner

The runner installs the repositories at the commits before and after a pull request and runs a docs example against a scratch FalkorDB ([Example runner](example-runner.md)).

| Variable | Effect |
|---|---|
| `STALEPROOF_SCRATCH_URL` | Use this server as the scratch database. Only the host and port are read (`[scheme://]host[:port]`, default port 6379); the scheme is ignored and TLS is not used. A URL with credentials is refused: `STALEPROOF_SCRATCH_URL must not carry credentials: docs examples connect to the scratch server without a password`. Staleproof does not start or stop this server |
| `STALEPROOF_SCRATCH_PORT` | Without `STALEPROOF_SCRATCH_URL`, Staleproof starts its own scratch server on `127.0.0.1:<port>` (default 6390) with `scripts/falkordb-local.sh`, the same falkordblite binaries as `staleproof db start` |
| `STALEPROOF_RUN_TIMEOUT_MS` | Each run (before and after are separate runs) is killed after this many milliseconds and recorded as `timeout` with the reason `no exit after <s>s`. Default 30000. Creating a virtualenv (300 s) and installing into it (600 s), and each step that builds a JavaScript/TypeScript package (600 s), have fixed limits |

The scratch server is flushed before every run (`FLUSHALL`, then `GRAPH.UDF FLUSH`). Staleproof refuses to flush the server that holds the org graph: when the scratch host and port equal those of `FALKORDB_URL` (`localhost` and `127.0.0.1` count as the same host), each run ends with status `error` and the reason `refusing to flush <host>:<port>: it is the server holding the org graph (FALKORDB_URL). Point STALEPROOF_SCRATCH_URL / STALEPROOF_SCRATCH_PORT at a separate server.`

Inside the sandbox, the example process inherits no environment. The runner sets `STALEPROOF_SCRATCH_HOST` and `STALEPROOF_SCRATCH_PORT` for the network shim, which sends connections to a local host on the ports in `STALEPROOF_DB_PORTS` (default `6379`) to the scratch server. Staleproof never sets `STALEPROOF_DB_PORTS`, and because nothing is inherited you cannot set it either: the remapped port is always 6379.

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

JavaScript and TypeScript examples build their packages with npm, pnpm or yarn under the same allow-list ([Example runner](example-runner.md#building-the-packages-from-source)), plus every `npm_config_*` variable (either case, so `npm_config_registry` points at a mirror, as `UV_*` and `PIP_*` do for Python), with `npm_config_update_notifier`, `npm_config_fund` and `npm_config_audit` set to `false`. `HOME` is passed, so `~/.npmrc` applies too.

### Server

| Variable | Effect |
|---|---|
| `PORT`, `HOST` | Address of `staleproof serve`; `--port` and `--host` override them. The Docker image sets `HOST=0.0.0.0` and `PORT=8080`. Not used on Vercel |
| `STALEPROOF_PRELOADED` | Comma-separated pull request URLs listed on the home page and by `GET /api/prs`; spaces around entries are trimmed and empty entries dropped. `serve --preload <url...>` overrides it. Unset: falkordb-py #262, #267 and #276. Every entry must be a pull request URL, or `GET /api/prs` answers 500 |
| `STALEPROOF_CHECK_BUDGET_MS` | After this many milliseconds, an agent check in the server starts no new model turn and ends `incomplete`, listing the sections still open. Default 240000 on Vercel (whose function limit is 300 s in [vercel.json](../vercel.json)), none elsewhere. `staleproof check` ignores it. When a hosted server indexes first, indexing counts against it, but the agent always gets at least 45 seconds. `0` ends every agent check before its first turn |
| `STALEPROOF_HOSTED` | Hosted mode ([Deploy](DEPLOY.md#hosted-mode)). In the Vercel function it is on unless the value is `off`; for `staleproof serve` it is off unless the value is `on` or `--hosted` is given |
| `STALEPROOF_AGENT_CHECKS_PER_DAY` | In hosted mode (the Vercel function and `serve --hosted`): how many agent checks start per day (UTC) across the service, default 50 |
| `VERCEL` | Any non-empty value. Vercel sets it, which moves `STALEPROOF_HOME` to `/tmp/staleproof` and sets the 240 s check budget |

The HTTP rate limit (30 POST requests per client per hour) has no variable; see [HTTP API](http-api.md#rate-limits). The hosted workspace limits have none either; they are `DEFAULT_HOSTED_LIMITS` in [src/hosted/workspaces.ts](../src/hosted/workspaces.ts).

### Scripts and helpers

- **`FALKORDBLITE_VERSION`** (default `0.10.0`) is the version of the `falkordblite` Python wheel that `scripts/falkordb-local.sh` installs into `$STALEPROOF_HOME/falkordb/venv` (with uv, else `python3 -m venv` and pip). It provides `redis-server` and the FalkorDB module for `staleproof db start` and for the managed scratch server. That build is FalkorDB 4.18.3 ([version notes](troubleshooting.md#falkordb-version-notes)).
- **`FACTS_OUT`** is where `scripts/seed.sh` writes FACTS.md (default `docs/FACTS.md`, relative to the working directory).
- **`USER`** is the default for `verdict --by`.

## Global CLI options and precedence

| Option | Overrides | Default |
|---|---|---|
| `--org <org>` | `STALEPROOF_ORG` | the owner of the repository the command is about, else `falkordb` |
| `--db <url>` | `FALKORDB_URL` | `falkor://localhost:6379`, started locally when nothing answers |

Both may come before or after the command (`staleproof --org acme index ...` and `staleproof index ... --org acme` are the same). The general rule is flag, then environment variable, then default:

| Setting | Flag | Variable | Default |
|---|---|---|---|
| Graph name | `--org` | `STALEPROOF_ORG` | the repository's owner, else `falkordb` |
| FalkorDB URL | `--db` | `FALKORDB_URL` | `falkor://localhost:6379` |
| Agent model | `check --model` | `STALEPROOF_MODEL` | `claude-sonnet-5-5` |
| Effort | `check --effort` | `STALEPROOF_EFFORT` | `medium` |
| Server port | `serve --port` | `PORT` | `8080` |
| Server interface | `serve --host` | `HOST` | `127.0.0.1` |
| Preloaded pull requests | `serve --preload` | `STALEPROOF_PRELOADED` | falkordb-py #262, #267, #276 |
| Hosted mode | `serve --hosted` | `STALEPROOF_HOSTED` | off for `serve`, on in the Vercel function |
| Reviewer | `verdict --by` | `USER` | `maintainer` |
| Local FalkorDB port | `db --port` | — | `6379` |

The other limits are flags only: `check --max-steps` (40), `check --no-agent --max-hops` (3) and `--runs` (3). `check --with` and `--no-index` control indexing on first use. Every command and option is in [CLI](cli.md).

## Files under STALEPROOF_HOME

```text
~/.staleproof/                                  STALEPROOF_HOME
  repos/<owner>/<name>/                       blob-less git clones: indexing, PR ingestion, example installs,
                                              the docs patch, clearance's text-match counts
  tarballs/<owner>/<name>/<sha>/              files extracted from a downloaded tarball (no git); hosted mode
                                              deletes them once the repository is indexed
  cache/github/<owner>/<repo>/pulls/<n>.json  pull request metadata (read back only for merged PRs)
  venvs/<key>/                                one virtualenv per set of repo@sha, marked done by .staleproof-ok
  node-envs/<key>/                            one Node project per set of repo@sha and imported packages (JS/TS runs)
  src/<key>/<owner>__<name>/                  sources extracted while a virtualenv builds; removed after a successful build
  src/node-<key>/<owner>__<name>/             sources JS/TS packages are built and packed from; removed afterwards
  falkordb/venv/                              falkordblite, installed on first `db start` or scratch start
  falkordb/data-<port>/                       data (RDB snapshots), redis.log and redis.pid of each local server
```

- **`falkordb/data-6379`** holds the org graph when you run `staleproof db start`, including every verdict, decision and run. Deleting it deletes the graph. `data-6390` is the scratch server, which is flushed before every run anyway.
- **`venvs/`, `node-envs/` and `src/`** can be deleted at any time; virtualenvs and Node projects are rebuilt on the next run that needs them.
- **`repos/`** can be deleted; clones come back on the next index or check. Until then, `clearance` reports 0 raw text matches and the docs patch reads files from GitHub instead.
- **`tarballs/`** can be deleted; it is only read while indexing.
- **`cache/`** can be deleted; metadata is fetched again.
- Each example run also uses a temporary directory, `$TMPDIR/staleproof-run-*`, removed when the run ends.

## Repository configuration

A repository can tell the indexer what to leave out, in `.staleproof.toml` at its root:

```toml
ignore = ["docs/legacy/**", "CHANGELOG.md"]   # never indexed
skip-examples = ["docs/v1/**"]                # indexed and linked, never run or checked
```

or in the `[tool.staleproof]` table of its root `pyproject.toml`:

```toml
[tool.staleproof]
ignore = ["docs/legacy/**"]
skip-examples = ["docs/v1/**"]
```

| Key | Type | Effect |
|---|---|---|
| `ignore` | list of globs | Matching files are not indexed at all: no symbols, sections or examples. |
| `skip-examples` | list of globs | Examples on matching pages, and matching example scripts, are indexed and linked to the code as usual, so a pull request check still lists them, but they are never run, statically checked, predicted to break or counted as mismatched by the audit (as if each had a `skip` directive). Versioned copies of older docs kept next to the current ones (`docs-v3/` beside `docs/`, `versioned_docs/`) and translated READMEs (`README_KO.md`) are treated this way without being listed ([Indexing](indexing.md#static-checks-of-examples)). |

`staleproof lint` reads two more tables (in `pyproject.toml`, `[tool.staleproof.lint]` and `[tool.staleproof.rules]`):

```toml
[lint]
include = ["guides/**/*.txt"]      # extra files to check
exclude = ["docs/archive/**"]      # never checked (on top of `ignore`)
agent-files = ["prompts/*.md"]     # extra AI agent instruction files

[rules]
"anchor-missing" = "error"         # off | info | warning | error
```

| Key | Type | Effect |
|---|---|---|
| `lint.include` | list of globs | Files checked by `staleproof lint` besides the docs, READMEs and agent files |
| `lint.exclude` | list of globs | Files `staleproof lint` never checks |
| `lint.agent-files` | list of globs | Files reported under "AI agent instructions" (listed first, and checked strictly: see [Lint](lint.md#precision-first)) |
| `rules.<rule-id>` | `off`, `info`, `warning` or `error` | Turn a [rule](rules.md) off or change its severity |

- **Which file**: `.staleproof.toml` when it exists, even if empty; otherwise `[tool.staleproof]` when it is present. Unknown keys and values of the wrong type are reported as warnings (`staleproof lint` prints them) and ignored.
- **Globs** are matched against repository-relative paths, gitignore style: `**` matches any number of directories, `*` anything within one path segment, `?` one character; a leading `./` or `/` is dropped; a pattern also matches everything under it, so `docs/v1` covers `docs/v1/guide.md` (but not `docs/v10/`).
- **When**: read at index time. After editing it, index the repository again.
- **Errors** stop the index: a key that is not a list of strings fails with `<file>: ignore must be a list of glob strings` (or `skip-examples`), and a file that is not valid TOML with the parser's message.
- **On hosts without git** (tarball downloads: the hosted service, Vercel, `STALEPROOF_INGEST=github`), hidden paths are not extracted except a root `.staleproof.toml`, so both files are read there too.

### Hooks

The coding-agent hooks (the [Claude Code plugin](claude-code.md), and the hooks `staleproof init --claude` or `--cursor` writes) read one more table, `[hooks]` (in `pyproject.toml`, `[tool.staleproof.hooks]`):

```toml
[hooks]
stop = "block"   # block | warn | off
```

| Key | Values | Effect |
|---|---|---|
| `hooks.stop` | `block` (default), `warn` or `off` | What the hook before an agent stops does with the docs references the session made wrong: ask the agent to fix them (once), only show them to you, or nothing. `STALEPROOF_HOOK` overrides it |

The hooks keep a parse cache and their state in `.staleproof/cache/` at the top of the checkout ([Claude Code plugin: how it works](claude-code.md#how-it-works)); the folder ignores itself in git and is safe to delete.

### Example directives

One example at a time is marked in the docs themselves, with a comment on the line before it (blank lines in between are fine) or a word in its fence's info string:

| Directive | Means |
|---|---|
| `<!-- staleproof: skip -->`, `{/* staleproof: skip */}` (MDX), fence word `skip` or `no-run` | Not runnable here (a long-running server, a cloud account): never run or statically checked |
| `<!-- staleproof: expect-error -->`, fence word `expect-error` | Fails on purpose (it shows an error): never run or statically checked, because a failure proves nothing |
| `<!-- pytest-codeblocks:skip -->`, `<!-- skip: next -->` (Sybil) | Read as `skip`, so docs already marked for those tools need no second marker |
| `<!-- pytest-codeblocks:expect-exception -->` | Read as `expect-error` |
| `.. staleproof: skip`, `.. staleproof: expect-error`, `.. skip: next` (reStructuredText) | The same, as a comment before the block |

A marked example stays linked to the code it calls: a pull request check still lists its section, and its definitions still serve the examples after it on the page. `run_example` answers `Not run: the docs or the repository config mark this example skip.` (or `… failing on purpose (expect-error), so a run proves nothing.`) without running anything. [Indexing](indexing.md#example-directives) has every accepted spelling.

## Configurations that work together

### Local development

```bash
npx -y staleproof db start                 # FalkorDB on 127.0.0.1:6379, data in ~/.staleproof/falkordb/data-6379
export GITHUB_TOKEN=<token>                   # optional: more than 60 GitHub requests per hour
export ANTHROPIC_API_KEY=<key>                # optional: agent mode
npx -y staleproof index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/262 --no-agent
npx -y staleproof serve
```

No other variable is needed: the `FALKORDB_URL` default matches `db start` (and without `db start`, the first command starts the same server), the graph is named after the repositories' owner (`falkordb`), and the scratch server for example runs starts by itself on port 6390. The host needs `git`, plus `uv` or `python3` (uv is recommended: it pins Python 3.12 for the sandbox; with `python3` the version is whatever the host has).

### FalkorDB Cloud and DeepSeek

```bash
export FALKORDB_URL='falkor://falkordb:<url-encoded password>@<host>:<port>'   # falkors:// if the endpoint has TLS
export STALEPROOF_ORG=falkordb
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_API_KEY=<DeepSeek API key>
export STALEPROOF_MODEL=deepseek-v4-pro
export GITHUB_TOKEN=<token>
npx -y staleproof check https://github.com/FalkorDB/falkordb-py/pull/267
```

The live demo's agent mode uses this provider and model. Leave `STALEPROOF_SCRATCH_URL` unset so example runs use the local scratch server on 127.0.0.1:6390, never the cloud database. `STALEPROOF_FALLBACKS` needs no setting: compatible mode never sends the fallback.

### CI (GitHub Action)

The [GitHub Action](github-action.md) needs no variables: it starts FalkorDB in the job and sets `FALKORDB_URL=falkor://localhost:6379` and `STALEPROOF_SCRATCH_URL=falkor://localhost:6390` for its own containers (or lets the CLI start falkordblite when the runner has no Docker). Its inputs set the rest: `github-token` (default: the workflow's token) becomes `GITHUB_TOKEN`, `anthropic-api-key` becomes `ANTHROPIC_API_KEY`, `base-url` becomes `ANTHROPIC_BASE_URL`, `model` becomes `STALEPROOF_MODEL`, and with `falkordb-url` set, `falkordb-url` becomes `FALKORDB_URL` and `org` becomes `STALEPROOF_ORG`. With an empty key the action runs `check --no-agent --format markdown`:

```yaml
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/staleproof@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          base-url: https://api.deepseek.com/anthropic   # only for an Anthropic-compatible provider
          model: deepseek-v4-pro
```

The workflow also needs `permissions: pull-requests: write` to post the comment ([examples/staleproof.yml](../examples/staleproof.yml)). On the runner, `STALEPROOF_HOME` is the default `~/.staleproof`, which starts empty on every job.

### Vercel

```bash
vercel env add FALKORDB_URL production          # required
vercel env add GITHUB_TOKEN production          # recommended: a fine-grained token, public repositories, read-only
vercel env add ANTHROPIC_API_KEY production     # optional: agent mode
vercel env add ANTHROPIC_BASE_URL production    # with STALEPROOF_MODEL, for an Anthropic-compatible provider
vercel env add STALEPROOF_MODEL production
vercel env add STALEPROOF_PRELOADED production    # optional
vercel env add STALEPROOF_AGENT_CHECKS_PER_DAY production   # optional, default 50
vercel env add STALEPROOF_HOSTED production       # optional: `off` serves the curated graph only
```

Vercel sets `VERCEL`, so `STALEPROOF_HOME` is `/tmp/staleproof` and agent checks stop at 240 s. Hosted mode is on unless `STALEPROOF_HOSTED=off`. `PORT`, `HOST` and the scratch variables are not used: the function serves no static files and executes no examples. [Deploy](DEPLOY.md#vercel) has the full procedure.

## Related

- [CLI](cli.md): every command and flag
- [Deploy](DEPLOY.md): Vercel, Docker Compose, FalkorDB Cloud and a production checklist
- [Example runner](example-runner.md): the sandbox and the scratch server
- [The agent](agent.md): model providers, budgets and graph mode
- [Troubleshooting and FAQ](troubleshooting.md)
