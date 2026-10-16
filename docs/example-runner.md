# Example runner

This page explains how a docs code example is executed before and after a pull request: which repositories are installed and at which commits, how fragments are stitched together, which examples are skipped and why, how runs are cached, the virtualenvs, the scratch FalkorDB and the sandbox, and how to read the result. It is for anyone who wants to trust (or question) a "passes before, fails after".

## Run an example before and after a pull request

```bash
npx -y lockstep-docs run "FalkorDB/falkordb-py:README.md:4" --pr https://github.com/FalkorDB/falkordb-py/pull/262
```

The argument is a [CodeExample id](concepts.md#ids) (`owner/repo:path:index`); `impact` and `read_section` return them. With `--pr`, the pull request is ingested first if needed, then the example runs at the commit before the pull request and at the pull request. The CLI prints each run (status, side, the `repo@sha` list installed, any stitched fragments, the skip reason or the traceback), then a one-line summary. For this example the summary reads:

```text
Fails at 49aa012 and passes at f7c3de7: the PR fixes this example.
```

The README's "Asynchronous Example" failed before falkordb-py#262 with `TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry'` and passes after it ([FACTS](FACTS.md#example-runs-sandbox)).

| Option | Default | Meaning |
|---|---|---|
| `--pr <url>` | none | Run before and after this pull request. Without it the example runs once, at the indexed commits |
| `--fresh` | off | Re-run even if an identical run is recorded, and replace the recorded one |
| `--json` | off | Print the tool result as JSON |

The agent and MCP clients run examples with the [`run_example`](tools.md) tool; graph mode runs up to 3 of them per check.

## How a run works

1. **Load the example**: its code and language, the repositories of the symbols it `USES`, and every earlier example on the same page (for stitching).
2. **Choose what to install**: see [Install set](#install-set).
3. **Prepare the program**: convert a REPL transcript to code, apply the [skip rules](#skip-rules), stitch fragments.
4. **Look up an identical run** in the graph, unless `--fresh` (see [Run key and caching](#run-key-and-caching)).
5. **Execute**, one run at a time: check out each repository, build or reuse the [virtualenv](#virtualenvs), start and flush the [scratch FalkorDB](#scratch-falkordb), run the program in the [sandbox](#the-sandbox).
6. **Record** a `Run` node, linked to the example (`OF`) and to the pull request (`AT`).

With a pull request, steps 3 to 6 happen twice: `before`, then `after`. If the `before` run is skipped, the `after` run is not attempted. The two runs combine into one [outcome](#statuses-and-outcomes).

## Install set

The repositories installed for a run are:

- the repositories that define the symbols the example `USES`, plus the pull request's repository;
- their in-organisation dependencies, following `DEPENDS_ON` up to 3 steps;
- keeping only repositories with Python packages (a docs-only repository is never installed).

Each is installed at its indexed commit, except the pull request's repository, which is installed at the pull request's before or after commit. For #276, the GraphRAG-SDK examples on the docs site install GraphRAG-SDK at its indexed commit and falkordb-py at the pull request's commits. An example with nothing to install is recorded as skipped: `uses no symbol from an indexed repository`.

## Preparing the program

Docs pages often split one program across several blocks: the first creates `db` and `g`, later ones only call `g.query(...)`. The runner runs an example the way a reader would:

- A REPL transcript (`>>> ` lines) becomes plain code: prompts removed, output lines dropped.
- An example with any `import` or `from` line runs as written.
- An example with no import line is a fragment: every earlier Python example on the same page that is not itself skipped is prepended, in order, each marked `# --- stitched from <id>`. The run records their ids in `stitched`.
- If the program then fails with `NameError: name 'x' is not defined` and nothing in it defines `x` (no `def x`, `class x`, `x =`, `import … x` or `as x`), the run is recorded as skipped (`fragment: … (the page never defines it)`), not as a failure.

## Skip rules

An example is recorded as skipped, with the reason, when it cannot be run honestly. The rules are checked in this order on the prepared code:

1. **Not Python**: the block's language is not Python: `not Python (bash)`, or `not Python (no language tag)`.
2. **Empty**: `empty example`.
3. **Needs an LLM provider**: it mentions a provider key variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `AZURE_OPENAI`, `GROQ_API_KEY`, `COHERE_API_KEY`, `MISTRAL_API_KEY`), sets `model = "…"` to an OpenAI, Anthropic, GPT, Claude, Gemini, Azure, Groq, Ollama, Bedrock, Vertex, Mistral or Cohere model, or constructs `LiteLLM(`, `LiteLLMEmbedder(`, `OpenAI(`, `AsyncOpenAI(`, `Anthropic(`, `ChatOpenAI(` or `OpenAIEmbeddings(`. Reason: `needs an LLM provider (<what matched>); Lockstep does not hold provider keys`.
4. **Reads a local file**: a quoted file name ending in `.pdf`, `.csv`, `.txt`, `.json`, `.jsonl`, `.doc`, `.docx`, `.htm`, `.html`, `.xls`, `.xlsx`, `.parquet` or `.md`, unless the code also writes one (`.write`, `.dump`, `.to_csv`, `.to_json`). Reason: `reads a local file the docs do not provide (employees.csv)`.
5. **Placeholders**: a quoted string containing `<your…>` or `<insert…>` (either case), or a quoted `your-…` / `your_…` name ending in `key`, `password`, `token` or `host`. Reason: `contains placeholders to fill in (e.g. "<your-host>")`.
6. **User input**: it calls `input(`. Reason: `waits for user input`.
7. **External services**: `requests`, `httpx`, `urllib.request` or `aiohttp` with `get(` or `post(` on the same line, or any mention of `boto3`, `psycopg`, `psycopg2` or `neo4j`. Reason: `calls an external service`.

Two more cases come later:

- **Nothing to install** (checked after the next one): `uses no symbol from an indexed repository`.
- **No sandbox on this host**: a host without `git`, or without both `uv` and `python3` (a serverless function), cannot execute examples. Such a run comes back skipped with `this deployment cannot execute examples (no git/uv sandbox runtime); runs recorded by other Lockstep hosts are answered from the graph`, and is not recorded, so a host that can run it still will.

Skipped runs prove nothing about the docs either way. Of #276's examples, one was skipped for a placeholder and one for not being Python.

## Run key and caching

Every run has a key: the first 20 hex characters of the SHA-1 of the prepared program, the sorted list of `repo@sha` installed, and the skip reason. Before running, the runner looks for the most recent `Run` with that key. If it finds one whose status is not `error`, it answers from it instead of running: the result is marked `cached`, the summary ends with `(recorded earlier; not re-run)`, and the run gets an `AT` edge to the pull request being checked.

- The key does not include the example id, so two examples with the same program and commits share one `Run`.
- `error` runs are never reused: the next request tries again.
- `run --fresh` skips the lookup, re-runs, and replaces the recorded run (same id). It exists only on the CLI `run` command; checks, MCP and the HTTP API always reuse recorded runs.
- A serverless host with no sandbox still answers every run recorded by another host, as long as the program and commits are identical.

## Virtualenvs

Each distinct set of `repo@sha` gets its own virtualenv, built once and reused.

1. Each repository's source at its commit is extracted from the local clone with `git archive <sha> | tar -x` (missing blobs are fetched from the blob-less clone).
2. The project directory is the shallowest one containing `pyproject.toml` or `setup.py`, outside `test/`, `tests/`, `docs/`, `example/`, `examples/`, `benchmark/` and `benchmarks/`; the repository root otherwise.
3. With [uv](https://docs.astral.sh/uv/) on `PATH`: `uv venv --python 3.12`, then `uv pip install` of every project directory into it (uv fetches Python 3.12 if needed). Without uv: `python3 -m venv`, then `pip install`. Creating the venv may take up to 300 s and installing up to 600 s.
4. A marker file, `.lockstep-ok`, records the finished build; a venv without it is rebuilt.

The repositories are installed from source at exact commits; their third-party dependencies resolve from the package index at install time. The cache key includes Python version `3.12`, but only uv pins it: the `python3` fallback uses whatever `python3` is installed. Install uv.

Everything lives under `LOCKSTEP_HOME` (default `~/.lockstep`, `/tmp/lockstep` on Vercel):

```text
~/.lockstep/
  repos/<owner>/<name>/               blob-less clones, shared with indexing and pull request ingestion
  cache/github/<owner>/<repo>/pulls/  pull request metadata from the GitHub API
  venvs/<key>/                        one virtualenv per (Python 3.12, sorted repo@sha list)
  src/<key>/<owner>__<name>/          sources extracted while a venv builds; removed afterwards
  falkordb/                           falkordblite binaries and data for `db start` and the managed scratch server
```

The venv key is the first 16 hex characters of the SHA-1 of the Python version and the sorted `repo@sha` list. Delete `venvs/` to force rebuilds.

Installing a repository from source runs its build code (setup scripts, build backends) at the pull request's commit. That step gets an allow-listed environment, not the server's: paths and `HOME`, user and shell, locale and time zone, XDG cache and data directories, every `UV_*` and `PIP_*` variable (so a custom index such as `UV_INDEX_URL` still applies), proxy variables and CA certificate locations ([`installEnv`](../src/runner/sandbox.ts)). `FALKORDB_URL`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and anything else outside the list never reach a pull request's build code. The exact list (`INSTALL_ENV`): `PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TZ`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `UV_*`, `PIP_*`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` (either case), `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, and on Windows `SYSTEMROOT`, `COMSPEC`, `PATHEXT`. `VIRTUAL_ENV` is not passed, so an activated virtualenv in your shell does not leak into the build.

## Scratch FalkorDB

Docs examples connect to FalkorDB on `localhost:6379`. Inside the sandbox that address goes to a scratch FalkorDB, never to the server that holds your graph.

- **Managed (default)**: the runner starts a local server on `127.0.0.1:6390` (`LOCKSTEP_SCRATCH_PORT` changes the port) with the same falkordblite binaries as `lockstep-docs db start`. Starting is idempotent.
- **Your own**: set `LOCKSTEP_SCRATCH_URL` to a separate server (for example the `scratch` service in the Docker Compose file). Only the host and port are used (default port 6379); the scheme and TLS are ignored, and the server must not require a password. A URL with credentials is refused when the configuration loads: `LOCKSTEP_SCRATCH_URL must not carry credentials: docs examples connect to the scratch server without a password`.

Before every run the scratch server is wiped with `FLUSHALL`, then `GRAPH.UDF FLUSH`. The second clears user-defined function libraries, which `FLUSHALL` keeps: without it, the docs' UDF example passes once and then fails with "already registered", which would read as a pull request breaking it. Servers without UDF support are fine.

The runner refuses to flush the server that holds the org graph. If the scratch host and port match `FALKORDB_URL` (with `localhost` treated as `127.0.0.1`), the run fails with:

```text
refusing to flush 127.0.0.1:6379: it is the server holding the org graph (FALKORDB_URL). Point LOCKSTEP_SCRATCH_URL / LOCKSTEP_SCRATCH_PORT at a separate server.
```

Every example starts from an empty server. An example that assumes data the page never creates fails, and that is a finding: the docs site's `GRAPH.EXPLAIN` example explains a query on a graph it never creates, and fails with `Invalid graph operation on empty key` before and after falkordb-py#267.

## The sandbox

The program runs as `<venv>/bin/python -s example.py` in a fresh temporary directory (`lockstep-run-*` under the system temp directory, deleted afterwards), with empty standard input, in its own process group.

Two processes touch code from the pull request, and neither gets the server's environment:

| Step | Runs | Environment |
|---|---|---|
| Install | `uv venv`, `uv pip install` (or `python3 -m venv`, `pip install`), which run the repositories' build code | The allow-list described under [Virtualenvs](#virtualenvs): paths, user, locale, `UV_*` and `PIP_*`, proxies, certificates. Network allowed |
| Example | `python -s example.py` | Nothing inherited: only the variables listed below. Network refused except the scratch server |


- **Environment**: nothing is inherited, not even the install step's allow-list, so no secrets reach the example. The environment is exactly `PATH=/usr/bin:/bin`, `HOME` and `TMPDIR` set to the temporary directory, `LANG=C.UTF-8`, `PYTHONPATH` pointing at the shim, `PYTHONDONTWRITEBYTECODE=1`, `PYTHONUNBUFFERED=1`, and `LOCKSTEP_SCRATCH_HOST` / `LOCKSTEP_SCRATCH_PORT`.
- **Network shim**: a `sitecustomize.py` ([python/sitecustomize.py](../python/sitecustomize.py)) loads automatically and patches Python's sockets. A connection to `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `host.docker.internal` or `falkordb` on port 6379 is sent to the scratch server. A connection to the scratch server itself is allowed. Anything else fails with `OSError(ECONNREFUSED)`: `Lockstep sandbox: outbound network is disabled (tried <host>:<port>); only FalkorDB on localhost:6379 is available`.
- **DNS**: local names resolve to `127.0.0.1`; any other lookup fails with `Lockstep sandbox: DNS is disabled (<host>)`.
- **Timeout**: `LOCKSTEP_RUN_TIMEOUT_MS` (default 30000). On timeout the whole process group is killed and the run is recorded as `timeout` (`no exit after 30s`).
- **Output**: up to 64 KiB per stream is captured; the stored stdout and traceback keep the last 4000 characters.

## Statuses and outcomes

Each run gets a status, and a pair of runs gets an outcome. Both are defined in [Core concepts](concepts.md#runs); this is how to read them.

| Outcome | Summary line | What it tells you about the docs |
|---|---|---|
| `breaks` | `Passes at <before> and fails at <after> with <error>: the PR breaks this example.` | The pull request broke a documented example: the section needs an edit |
| `fixes` | `Fails at <before> and passes at <after>: the PR fixes this example.` | The example works now; it did not before (#262) |
| `passes` | `Passes before and after the PR (<before>, <after>): no observable break.` | Good evidence the section still holds |
| `already-broken` | `Fails both before and after the PR with <error>: broken already, not by this PR.` | Not this pull request's doing, and still a broken example worth fixing (#267's `GRAPH.EXPLAIN`) |
| `changed-failure` | `Fails before (<error>) and after with a different error (<error>).` | Broken both times; compare the two errors |
| `fails` | `Fails at the indexed commits: <error>.` | A single run without a pull request failed |
| `skipped` | `Not run: <reason>.` | Proves nothing |
| `error` | `The sandbox could not be prepared: <reason>` | An environment problem (install, clone, scratch server); says nothing about the docs |

Commits are shown as 7-character SHAs. On #276, 21 examples were tried at both commits: 10 pass both times, 6 fail both times (already broken), 3 cannot be installed together at those commits (`error`, see the next section), and 2 were skipped. Across every recorded run in the graph: 51 runs, 24 pass, 16 fail, 6 error, 5 skipped ([FACTS](FACTS.md#example-runs-sandbox)).

## Install conflicts

When the repositories cannot be installed together, the run is `error` and its reason starts with one line naming the problem, followed by the last 2000 characters of the installer's output. If the resolver reports which pin blocks the install, the line names it:

```text
dependency conflict: <package>==<version> requires <requirement>, which the other checkouts don't satisfy (installing <repo@sha, …>)
```

Otherwise it reads `installing <repo@sha, …> failed:`. On #276, three GraphRAG-SDK examples hit `dependency conflict: graphrag-sdk==1.4.0 requires falkordb[hiredis]>=1.8.0,<2, …`: the SDK at its indexed commit pins the client below 2, and the falkordb-py checkout at the pull request's commits does not satisfy that pin. That is version skew between repositories, not a docs finding.

## The Run node

Each execution is stored as a `Run` node:

| Property | Meaning |
|---|---|
| `id` | `run-<key>`; a failed preparation gets `run-<key>-err-<ms>`, unique per attempt |
| `key` | The [run key](#run-key-and-caching) |
| `example` | The CodeExample id |
| `status` | `pass`, `fail`, `timeout`, `skipped` or `error` |
| `reason` | Why it was skipped or could not be prepared |
| `error` | The last line of the traceback (`AttributeError: …`), or of stderr |
| `traceback` | The last `Traceback (most recent call last):` block, or the end of stderr |
| `stdout` | The end of standard output |
| `duration_ms` | Wall time of the program |
| `stitched` | Ids of the earlier examples prepended |
| `installed` | `repo@sha` for every installed repository |
| `side` | `before`, `after` or `current` (no pull request) |
| `created_at` | When it ran |

Edges: `(Run)-[:OF]->(CodeExample)`, and `(Run)-[:AT]->(PullRequest)` for every pull request it was evidence for (a reused run collects more). Verdicts that cite a run link to it with `EVIDENCE`. The tool result (`RunRecord`) has the same fields in camel case, plus `cached`.

## One run at a time

Runs are serialised by a process-wide queue: the scratch server is shared and flushed before each run, so two runs never overlap in one process. The HTTP server also runs one check at a time. Do not point two Lockstep processes at the same scratch server.

## Limits

- **The sandbox is a guard, not a security boundary.** It refuses connections and DNS at the Python socket level, runs with no inherited secrets and a temporary `HOME`, and kills on timeout. Native code that opens its own sockets bypasses the shim, and the program can read the file system. Run it inside a container for untrusted code.
- **Runs use today's third-party dependencies.** The organisation's repositories are installed at exact commits, but their dependencies resolve at install time, so an old run may not reproduce today. A recorded run is reused until you pass `--fresh`.
- **Installs have network access** (they download dependencies); only the example itself runs without it. Their environment is the allow-list above, without the server's credentials, but with any credentials you put in `UV_*` or `PIP_*` variables (an index URL) or a proxy URL.
- **Python is pinned to 3.12 only with uv.** The `python3 -m venv` fallback uses the host's Python.
- **Re-indexing moves commits.** The run key includes the indexed commit of every installed repository, so after a re-index the earlier runs no longer match and examples run again.
- **Stitching prepends every earlier runnable Python block on the page**, related or not; a failing earlier block fails the fragment.
- **Serverless hosts do not execute examples.** On Vercel, run results come only from runs recorded by a host with a sandbox (a local machine or a container).

## Related

- [Core concepts](concepts.md#runs): run statuses and outcomes
- [Indexing](indexing.md): how examples, `USES` edges and `DEPENDS_ON` edges are found
- [Tools reference](tools.md): `run_example` parameters and result
- [Deploy](DEPLOY.md): the scratch server in Docker Compose and on Vercel
- [Troubleshooting and FAQ](troubleshooting.md)
