# Quickstart

From nothing to a checked pull request: start FalkorDB, index FalkorDB's three public repositories, check a real pull request with and without a model, run one docs example before and after it, build the patch, open the web UI and connect Claude Code. Then index your own repositories. Every command here is copy-pasteable; you need no account other than an optional model API key.

## Prerequisites

| You need | For | Notes |
|---|---|---|
| Node.js 20 or newer | everything | The package declares `node >= 20`. |
| `git` | `index`, checking a pull request, example runs, `patch` | Repositories are cloned over unauthenticated HTTPS, blob-less, into `~/.lockstep/repos/<owner>/<name>`. Indexing has no fallback without git. |
| `bash` | `db start\|stop\|status` and the scratch FalkorDB examples run against | Both use the bundled `scripts/falkordb-local.sh`. |
| [uv](https://docs.astral.sh/uv/) (recommended), or `python3` 3.12 or newer with `pip` | `db start`, the scratch FalkorDB, example runs | `db start` installs the `falkordblite` wheel (redis-server plus the FalkorDB module), which needs Python 3.12 or newer; with uv, a Python 3.12 is fetched for you. Example runs build one virtualenv per set of commits: with uv they use Python 3.12; with only `python3` they use whatever version `python3` is. |
| `tar` | example runs | Sources are extracted with `git archive \| tar -x`. |
| Docker (optional) | running FalkorDB in a container instead of `db start` | |
| `ANTHROPIC_API_KEY` (optional) | agent mode | Or an Anthropic-compatible provider; see [step 4](#4-check-it-with-the-agent). |
| `GITHUB_TOKEN` (optional) | pull request metadata, `patch --open-pr` | Without a token, GitHub allows 60 API requests an hour. `GH_TOKEN` is read too. |

You can run every command with `npx -y lockstep-docs <command>`, or install it once with `npm install -g lockstep-docs` and drop the `npx -y`. See [CLI](cli.md#install-or-run-with-npx).

## 1. Start FalkorDB

Lockstep keeps everything in a FalkorDB graph. The CLI connects to `FALKORDB_URL`, which defaults to `falkor://localhost:6379`. Pick one of the three options below.

### Without Docker

```bash
npx -y lockstep-docs db start
```

The first start installs `falkordblite` into `~/.lockstep/falkordb/venv`, then runs a FalkorDB server on `127.0.0.1:6379`. Data persists as RDB snapshots in `~/.lockstep/falkordb/data-6379`, so the graph, including verdicts and decisions, survives restarts. Stop it with `npx -y lockstep-docs db stop`; check it with `npx -y lockstep-docs db status`.

### With Docker

```bash
docker run -d --name falkordb -p 6379:6379 falkordb/falkordb:latest
```

Examples run against a second, disposable FalkorDB that is flushed before every run. By default Lockstep starts that scratch server itself on port 6390 with the same script as `db start`, so it still needs uv or `python3`. To keep FalkorDB entirely in Docker, start the scratch server as a container too and point Lockstep at it:

```bash
docker run -d --name lockstep-scratch -p 6390:6379 falkordb/falkordb:latest
export LOCKSTEP_SCRATCH_URL=falkor://localhost:6390
```

Never point `LOCKSTEP_SCRATCH_URL` at a server that holds data you need. Lockstep refuses to flush the server named in `FALKORDB_URL`, but any other server is wiped before each example run. The scratch server cannot require a password: docs examples connect to it without one, so a `LOCKSTEP_SCRATCH_URL` with credentials is refused.

### FalkorDB Cloud

Create an instance, then set its endpoint and password (user `falkordb`). URL-encode the password, and use `falkors://` if the endpoint has TLS:

```bash
export FALKORDB_URL='falkor://falkordb:<password>@<host>:<port>'
```

Leave the scratch server local (the default) or point `LOCKSTEP_SCRATCH_URL` at a different disposable server. [Deploy](DEPLOY.md) covers FalkorDB Cloud in more detail.

## 2. Index FalkorDB's three repositories

```bash
npx -y lockstep-docs index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
```

This clones the three repositories (the client library, the SDK built on it, and the docs site), parses their Python code and Markdown/MDX docs, resolves calls across all three, and writes the graph `falkordb` (the default organisation). Progress goes to stderr; at the end it prints one line per repository with its commit, symbol and call counts, one line per docs repository with sections, examples and links, and the dependencies it found between the repositories (for example `FalkorDB/GraphRAG-SDK → FalkorDB/falkordb-py (declares falkordb)`).

Index related repositories in one command: calls and doc links resolve across repositories only within a single `index` run. Re-running the same command later is safe; it updates the graph in place and marks what disappeared as gone instead of deleting it.

## 3. Check a pull request in graph mode

Graph mode needs no model. It runs the tools in a fixed order and samples rather than judges: impact, clearance, a PageRank ranking of the first impact page (up to 40 sections), then at most 3 example runs before and after the pull request. It writes no verdicts.

```bash
npx -y lockstep-docs check https://github.com/FalkorDB/falkordb-py/pull/262 --no-agent
```

The first check of a pull request reads its metadata from GitHub and diffs its two commits into symbol-level changes. The first example run also builds virtualenvs and starts the scratch FalkorDB, so it takes longer than later ones.

### What the output shows

From top to bottom:

1. **The pull request**: its title, URL, state, and the two commits compared (`before..after`). For a merged pull request, `before` is the first parent of the merge commit and `after` is the merge commit.
2. **Changed symbols**: each changed function, method or class with the kind of change (`removed`, `renamed`, `signature`, `modified`, `added`, `export-removed`). #262 changed one function, `Is_Cluster`.
3. **Impacted doc sections**: each section with a severity label (`BREAKING` for removed or renamed symbols and removed exports, `SIGNATURE` for signature changes, `BEHAVIOR` for body changes), its repository, the evidence path (`path: Is_Cluster ← FalkorDB.__init__ ← …`), the number of hops, the confidence (`exact` when every edge was resolved through imports and types, `by-name` or `late` otherwise), how many examples it has, and a link to the section on GitHub at the indexed commit. Sections are ordered by the PageRank of their page in the docs' own link graph, most central first. Only the first 40 sections are listed; a line such as `… 3 more` says how many were left out. For #262 there is one: the README's "Asynchronous Example".
4. **Cleared**: changed symbols that reach no doc within 3 hops, each with its raw text-match count in the docs and the `git grep` command to check it. `Is_Cluster` reaches a doc, so nothing is cleared for #262.
5. **Example runs**: for at most 3 examples on first-page sections whose path is `exact` (a sample, not every example), a `PASS`, `FAIL`, `TIMEOUT`, `SKIPPED` or `ERROR` line for each side with the commits installed, and the traceback of a failure. On the graph behind [Facts from the graph](FACTS.md), the README's Asynchronous Example failed before #262 with `TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry'` and passed after it: the pull request fixed a broken example. Your run installs today's third-party dependencies, so it can differ.
6. **The summary and the check id**: one paragraph, then `Stored as chk-…`. The check, its full trace and every run are stored in the graph.

A whole-word grep for `Is_Cluster` finds no doc section: the README example calls the constructor, which calls the changed function. That is the case the graph exists for.

## 4. Check it with the agent

In agent mode a model chooses which tools to call, reads each impacted section, runs examples, checks maintainer decisions, and records a verdict or proposes an edit for every impacted section, on every impact page.

### Claude

```bash
export ANTHROPIC_API_KEY='<your key>'
npx -y lockstep-docs check https://github.com/FalkorDB/falkordb-py/pull/262
```

The default model is `claude-sonnet-5-5` with effort `medium`; change them with `--model` and `--effort` (or `LOCKSTEP_MODEL` and `LOCKSTEP_EFFORT`). An `ant auth login` profile works instead of the key. The Claude path is tested against a local fake API only.

### DeepSeek or another Anthropic-compatible provider

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_API_KEY='<your DeepSeek key>'
export LOCKSTEP_MODEL=deepseek-v4-pro
npx -y lockstep-docs check https://github.com/FalkorDB/falkordb-py/pull/262
```

Any `ANTHROPIC_BASE_URL` whose host is not `api.anthropic.com` switches to compatible mode, which sends only the portable request fields. `LOCKSTEP_MODEL` is required there: a `claude-*` model name is refused, because the provider would answer with its own model under that name. This is the path the live demo and the published agent runs use.

The output is the trace: one line per tool call (`→ impact(pr_url=…)`), one per result (`← <summary>` with the Cypher queries it ran and their time), the model's summarised reasoning, and a final line with the status (`Done`, `Incomplete`, `refused` or `error`), turns, tool calls, verdicts and tokens, followed by the model's summary. The last line names the patch command and the stored check id. The check is `Done` only when every impacted section (all 43 for #276, not only the first page of 40) has a verdict or an edit; if the model stops early it is reminded of the open sections up to twice, then the check is recorded as `Incomplete` with those sections listed. The tool order differs from one pull request to the next; for #262 the published run called `impact → read_section → decisions_for → run_example → record_verdict`. A large pull request takes longer: a 43-section check takes about 6 minutes.

Without credentials, agent mode stops with an error that names the variables to set. Graph mode always works.

## 5. Run one example before and after

Every code example has an id, `owner/repo:path:index`, where `index` is the block's position among all fenced blocks in the file (0-based). Impact output and `--json` list them.

```bash
npx -y lockstep-docs run "FalkorDB/falkordb-py:README.md:4" --pr https://github.com/FalkorDB/falkordb-py/pull/262
```

It prints the example id and URL, one line per side (`FAIL before …`, `PASS after …`) with the commits installed, any traceback, and a one-line verdict such as `Fails at <before> and passes at <after>: the PR fixes this example.` If the graph already holds an identical run (same program, same commits), it is answered from the graph and marked as recorded. To execute it again and replace the stored run:

```bash
npx -y lockstep-docs run "FalkorDB/falkordb-py:README.md:4" --pr https://github.com/FalkorDB/falkordb-py/pull/262 --fresh
```

## 6. Get the patch

```bash
npx -y lockstep-docs patch https://github.com/FalkorDB/falkordb-py/pull/262
```

The patch is built from the edits the agent proposed (`stale` verdicts not rejected by a maintainer). It prints a unified diff that `git apply` accepts in each docs repository, then a pull request title and description with the evidence path, the example runs and the cited decisions for every edited section, and a list of the sections checked and left unchanged. Graph mode writes no verdicts, so after a graph-mode check alone the diff is empty and the command prints `(no proposed edits)`. The same is true when the agent concludes that nothing needs editing, which is what has happened on FalkorDB's repositories so far: the pull requests checked there are fixes, and every verdict recorded on #262, #267 and #276 is `ok`. A re-run on #267 considered fixing the GRAPH.EXPLAIN example, which fails before and after the pull request, and declined, because the page assumes a demo graph that already exists; it recommended a separate fix. Proposed edits and the patch built from them are exercised by the test suite on a fixture organisation, not yet on these repositories.

The file is read at the commit the graph indexed: from the local clone in `~/.lockstep/repos` when there is one, otherwise from `raw.githubusercontent.com`. A section whose text changed since indexing, or whose file is gone, is listed as not applied instead of being patched.

After an agent check that proposed edits, write the diff and the description to files, or open the fix as a pull request in your fork (needs `GITHUB_TOKEN`):

```bash
npx -y lockstep-docs patch <pr-url> --out docs-fix.diff
npx -y lockstep-docs patch <pr-url> --open-pr
```

## 7. Open the web UI

```bash
npx -y lockstep-docs serve
```

Open `http://127.0.0.1:8080`. Paste a pull request URL, pick agent mode (when the server has model credentials) or graph mode, and watch the trace stream in. The startup line on stderr says which graph is served and whether agent mode is on. Use `--port` and `--host` to change the address. The same process serves the [HTTP API](http-api.md).

## 8. Add it to Claude Code

```bash
claude mcp add lockstep -e FALKORDB_URL=falkor://localhost:6379 -- npx -y lockstep-docs mcp
```

Claude Code now has the ten tools. Ask it, for example: "What docs can https://github.com/FalkorDB/falkordb-py/pull/267 falsify? Show the evidence path for each." [MCP server](mcp.md) covers other clients and a full session.

## Index your own repositories

### What works

- **Code repositories in Python.** Every `.py` file is parsed, except tests (`test/`, `tests/`, `testing/`, `test_*.py`, `*_test.py`, `conftest.py`), `setup.py`, and files under `scripts/`, `benchmarks/` or `docs/`. Python files under `example/`, `examples/`, `sample/`, `samples/`, `tutorial/`, `tutorials/`, `notebook/` or `notebooks/` become runnable example scripts.
- **Docs in Markdown or MDX.** Every `.md` and `.mdx` file in any indexed repository, except housekeeping files (`CHANGELOG`, `CONTRIBUTING`, `LICENSE` and similar). A docs site can be its own repository with no code at all. Notebooks and `.rst` files are not read.
- **Public GitHub repositories only.** Private repositories cannot be cloned or read through the GitHub API.

[Indexing](indexing.md) has the full rules.

### Index everything in one command

Give each organisation its own graph with `--org` (or `LOCKSTEP_ORG`), and pass all its repositories to one `index` command:

```bash
npx -y lockstep-docs --org acme index acme/acme-client acme/acme-sdk acme/acme-docs
```

Calls and doc links resolve across repositories only among the repositories of one `index` run. If you index a repository on its own, or re-index it alone later, its calls into the other repositories and its docs' links into their code are re-resolved against that repository only, and those cross-repository edges disappear. Re-index with the same full command.

To index a specific branch, tag or commit of one repository, use `--ref` (repeatable). Use `origin/<branch>`, a tag or a SHA rather than a bare branch name:

```bash
npx -y lockstep-docs --org acme index acme/acme-client acme/acme-docs --ref acme/acme-docs=origin/next
```

### Check your pull requests

Use the same `--org` for every command. The pull request's repository must be indexed in that graph; otherwise the check stops with `<owner/repo> is not indexed in the "<org>" graph`.

```bash
npx -y lockstep-docs --org acme check https://github.com/acme/acme-client/pull/123 --no-agent
```

## Next steps

- Comment on every pull request automatically: [GitHub Action](github-action.md).
- Learn every command and option: [CLI](cli.md).
- Find the scenario closest to yours: [Use cases](use-cases.md).
- Record decisions so intentional docs stop being re-flagged: [Decisions and memory](memory.md).
- Run it for a team: [Deploy](DEPLOY.md).

## Related

- [CLI](cli.md)
- [Use cases](use-cases.md)
- [MCP server](mcp.md)
- [Configuration](configuration.md)
- [Troubleshooting and FAQ](troubleshooting.md)
