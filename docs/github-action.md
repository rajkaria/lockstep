# GitHub Action

The composite action in [action.yml](../action.yml), `uses: rajkaria/staleproof@v1`, comments on every pull request with the docs it can make false, the evidence path for each, and the result of running the affected docs examples before and after the change. It needs no inputs, no secrets and no database: it starts a FalkorDB inside the job and indexes the repository itself. This page is for maintainers adding it to a repository: installing it, what a run does, the inputs and outputs, permissions, agent mode, keeping a graph between runs, and the comment format. Status: it has run end to end on a private test repository, from the one-click workflow with no inputs: the comment named a README example the pull request broke, and updated in place when the same pull request fixed the README.

## Install it

### One click from the install page

1. Open [staleproof.dev/#/install](https://staleproof.dev/#/install) and type the repository (`owner/name`, or paste a repository or pull request URL).
2. Optionally, under Options: a docs repository to index with it, agent mode, and failing the check when an example breaks.
3. Click **Add to owner/repo**. GitHub opens its "new file" page with `.github/workflows/staleproof.yml` filled in. Click **Commit changes**, to the default branch or as a pull request.

The next pull request gets the comment. Agent mode also needs your model key as the repository secret `ANTHROPIC_API_KEY`; the page links to the repository's secrets page when you tick it.

### Or copy the workflow

Add [examples/staleproof.yml](../examples/staleproof.yml) as `.github/workflows/staleproof.yml`; without its header comment, it reads:

```yaml
name: Staleproof
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/staleproof@v1
        # with:
        #   also-index: your-org/docs                              # docs in another repository
        #   anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}   # the agent judges each section and proposes edits
        #   fail-on: breaks                                       # fail when an example passes before and fails after
```

`pull_request` with no `types` runs on GitHub's default types: `opened`, `synchronize` and `reopened`. The workflow needs no checkout step: Staleproof fetches the repository itself, with the job's token.

## What a run does

The steps of [action.yml](../action.yml), in order:

1. **Set up Node.js and uv**: `actions/setup-node@v7` with Node 22, and `astral-sh/setup-uv@v10.3.0` (the example runner builds its virtualenvs with uv).
2. **Start FalkorDB**, unless `falkordb-url` is set. With Docker on the runner (GitHub's Ubuntu runners have it), two containers from `falkordb/falkordb:latest`: `staleproof-graph` on port 6379 holds the graph, and `staleproof-scratch` on port 6390 is the disposable server the docs examples run against. The step waits up to 90 seconds for both ports, then sets `FALKORDB_URL=falkor://localhost:6379` and `STALEPROOF_SCRATCH_URL=falkor://localhost:6390` for the next steps. Without Docker it starts nothing, and the CLI starts both servers itself from falkordblite.
3. **Install staleproof**: `npm install -g staleproof@<version>` (default `0.2.0`). With `version: source`, the CLI is built from the action's own checkout instead (`npm ci`, then `tsup`). When the version cannot be installed from npm, the step warns `staleproof@<version> is not on npm; building it from this action's source instead.` and builds it the same way.
4. **Re-index**, only with `reindex: 'true'` and `falkordb-url` set: `staleproof index <this repository> <also-index...>`. See [Keep the graph between runs](#keep-the-graph-between-runs).
5. **Check the pull request**:

   ```bash
   staleproof check "$PR_URL" --no-agent --runs "$RUNS" --format markdown --out "$RUNNER_TEMP/staleproof-report.md" [--with <also-index...>]
   ```

   `--no-agent` is left out when `anthropic-api-key` is set. When the graph does not have the pull request's repository yet, the CLI first indexes it together with the `also-index` repositories, at their default branch heads; with the default throwaway FalkorDB that happens on every run. Then it runs the check (graph mode: impact, clearance, ranking, then up to `runs` examples before and after the pull request), writes the report, and the step appends the report to the job summary and counts the examples that break.
6. **Post or update the comment**, when `comment` is `'true'`: the GitHub CLI lists the pull request's comments (all pages), takes the first whose body starts with `<!-- staleproof -->` (or `<!-- lockstep-docs -->`, the marker from before the rename) and replaces its body with the report. If there is none, it posts a new comment. This step runs even when an earlier step failed, as long as a report was written.
7. **Fail on broken examples**, only with `fail-on: breaks`: the step fails with `This pull request breaks <n> docs example(s): they pass before it and fail after. See the report in the job summary.` when the report has any.

Because the comment is found by its first-line marker, each run edits the same comment instead of adding a new one.

When the check command fails without writing a report (for example a pull request URL it cannot read), the check step fails with `staleproof check failed (exit <status>); see the log above.` When it fails after writing one (an agent check that ends `error` or `refused`), the step warns `staleproof check ended with exit <status>; the report may be incomplete.`, passes, and the comment is posted. Run outside a pull request event without `pr-url`, the step fails with `No pull request to check: run this on pull_request events, or set pr-url.`

## Inputs

Every input is optional.

| Input | Default | Meaning |
|---|---|---|
| `also-index` | `''` | Other repositories to index together with this one, space- or comma-separated, for example your docs site `acme/docs`, so calls and doc links across them resolve. Passed to `check --with` (and to `index` with `reindex`). |
| `anthropic-api-key` | `''` | Selects the mode. Empty: graph mode (`--no-agent`). Set: agent mode, passed as `ANTHROPIC_API_KEY`. |
| `model` | `''` | Agent mode's model, passed as `STALEPROOF_MODEL`. Empty: `claude-sonnet-5-5`. Set it whenever you set `base-url`. |
| `base-url` | `''` | An Anthropic-compatible API for agent mode, passed as `ANTHROPIC_BASE_URL`, for example `https://api.deepseek.com/anthropic`. |
| `runs` | `'3'` | Graph mode runs up to this many affected examples before and after the pull request; `'0'` runs none. Passed as `--runs`. |
| `fail-on` | `never` | `breaks`: fail the job when an example passes before the pull request and fails after it. |
| `comment` | `'true'` | Post one pull request comment and keep updating it. Any other value: the report goes to the job summary only. |
| `pr-url` | `''` | The pull request to check. Empty: the one that triggered the workflow (`github.event.pull_request.html_url`). |
| `falkordb-url` | `''` | A FalkorDB that keeps the graph between runs (decisions, verdicts, run history). Empty: the throwaway FalkorDB the job starts. |
| `org` | `''` | The graph name on `falkordb-url`; ignored without it. Empty: the CLI's default, the owner of the repository lowercased (the input's description in `action.yml` says `falkordb`, which is what that rule gives for FalkorDB's repositories). |
| `reindex` | `'false'` | With `falkordb-url`: `'true'` re-indexes this repository and `also-index` at their default branch heads before the check. |
| `github-token` | `${{ github.token }}` | Reads the repository (clones, the GitHub API, file contents) and posts the comment. Passed as `GITHUB_TOKEN` to Staleproof and as `GH_TOKEN` to the GitHub CLI. |
| `version` | `'0.2.0'` | The `staleproof` npm version to run, or `source` to build the CLI from the action's checkout. |

## Outputs

| Output | Meaning |
|---|---|
| `report` | Path of the Markdown report, the comment's body: `$RUNNER_TEMP/staleproof-report.md` |
| `breaks` | How many docs examples pass before the pull request and fail after it: the report's example rows marked `**breaks**` |

```yaml
      - uses: rajkaria/staleproof@v1
        id: staleproof
      - if: steps.staleproof.outputs.breaks != '0'
        run: echo "${{ steps.staleproof.outputs.breaks }} docs example(s) break" >> "$GITHUB_STEP_SUMMARY"
```

## Permissions

| Need | Why |
|---|---|
| `contents: read` | Read the repository. |
| `pull-requests: write` | Create and update the comment. |

**Private repositories** work with the default token. Staleproof sends it to `https://github.com/` for clones (through git's environment config, never in the remote URL or on the command line), to the GitHub API and to `raw.githubusercontent.com`. The default token reads only the repository the workflow runs in: a private `also-index` repository elsewhere needs a token that can read it, passed as `github-token` (the comment is then posted as that token's account).

**Pull requests from forks** get a read-only token and no repository secrets. The check still runs, in graph mode (an `anthropic-api-key` from a secret is empty there), and the report goes to the job summary; the comment step ends with the warning `Could not comment on the pull request (pull requests from forks get a read-only token). The report is in the job summary.`

## Agent mode and graph mode

| | Graph mode (no key, the default) | Agent mode (`anthropic-api-key` set) |
|---|---|---|
| Command | `check <pr> --no-agent --runs <runs> --format markdown` | `check <pr> --runs <runs> --format markdown` (`--runs` applies to graph mode only; the agent chooses its own runs) |
| What runs | Impact, clearance and PageRank ranking, then up to `runs` examples (default 3) from exactly linked sections, before and after the pull request. No model. | The full agent check: the model reads sections, runs examples on the runner, checks decisions and records a verdict or an edit for every impacted section. |
| What is stored | A Check node (model `graph-only (no model)`) with the trace and the runs | A Check node with the trace, verdicts and runs |
| Comment | The examples run before and after, the impacted sections, cleared symbols, and any verdicts recorded earlier | The same, with this check's verdicts and the agent's summary |
| Cost | Runner minutes only | Model tokens; minutes per pull request (a 43-section check takes about 6 minutes) |

What is stored lives in the job's throwaway FalkorDB and disappears with it, unless you set `falkordb-url`.

Agent mode with an Anthropic-compatible provider such as DeepSeek:

```yaml
      - uses: rajkaria/staleproof@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}   # the provider's key
          base-url: https://api.deepseek.com/anthropic
          model: deepseek-v4-pro
```

Set `model` whenever you set `base-url`: a compatible provider refuses the default `claude-*` name, and the check then fails before it writes a report.

## Keep the graph between runs

By default every job starts with an empty FalkorDB, indexes the repository and forgets everything at the end: decisions, verdicts, their review and recorded runs do not carry over. To keep them, point `falkordb-url` at a FalkorDB the runner can reach (FalkorDB Cloud works; see [Deploy](DEPLOY.md)), stored as a secret:

```yaml
      - uses: rajkaria/staleproof@v1
        with:
          falkordb-url: ${{ secrets.STALEPROOF_FALKORDB_URL }}
          org: acme
          also-index: acme/acme-docs
```

With `falkordb-url`:

- The Start FalkorDB step does nothing. Examples run against a scratch server the CLI starts on the runner itself (falkordblite on `127.0.0.1:6390`), never against your graph's server.
- The repository is indexed on the first check only; later runs reuse the graph.
- A pull request is diffed once, on its first check. On `synchronize` (new commits pushed) the check reuses that first diff, so the comment does not reflect the new commits.
- `reindex: 'true'` re-indexes this repository and `also-index` before each check, at their default branch heads (no `--ref` is passed, so not at the pull request's base branch). They are indexed together, but without the graph's other repositories: calls and doc links into repositories not listed are re-resolved away until you index everything together again. Set `org` whenever you set `reindex`: that step passes `org` as `STALEPROOF_ORG`, and an empty value fails with `invalid org name: ""`.

For a graph of several repositories, leave `reindex` off and re-index every repository together on a schedule instead, from any one repository, for example as `.github/workflows/staleproof-index.yml`:

```yaml
name: Staleproof index
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  index:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Re-index every repository in one command
        env:
          FALKORDB_URL: ${{ secrets.STALEPROOF_FALKORDB_URL }}
          STALEPROOF_ORG: falkordb
        run: npx -y staleproof@0.2.0 index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
```

This workflow uses only the documented `index` command; unlike the action itself, it has not been run on GitHub. Re-indexing never deletes: what disappeared is marked `gone`, and verdicts and decisions keep pointing at it.

## Pin the version

`@v1` follows the action's `v1` tag, and the `version` input pins the CLI it installs (default `0.2.0`). For runs that cannot change under you, pin the action to a commit and the CLI to a version:

```yaml
- uses: rajkaria/staleproof@<commit-sha>
  with:
    version: 0.2.0
```

## The comment

The comment is the report that `check --format markdown` renders ([src/format/report.ts](../src/format/report.ts) and [src/format/markdown.ts](../src/format/markdown.ts)); it leads with what broke. The MCP tool `check_pull_request` returns the same report. Its shape, with placeholders in angle brackets:

```markdown
<!-- staleproof -->
### Staleproof: <title>

<n> changed symbols (and <m> added) reach <total> doc sections (<b> breaking, <a> signature, <c> behavior; <x> in other repositories).

| Example | Before (`<before>`) | After (`<after>`) | Result |
|---|---|---|---|
| [<path>:<index>](<url>) | passes | `<error>` | **breaks**: passes before this PR, fails after |

| Change | Doc section | Repository | Evidence path (changed symbol ← … ← doc) | Hops |
|---|---|---|---|---|
| **breaking** | [<heading>](<url>) (page edited in this PR) | <owner>/<repo> | `<changed symbol>` ← `<caller>` ← `<doc>` | <hops> (<exact|by-name|late>) |

_<k> more sections not shown._

<details><summary>Cleared: <n> changed symbol(s) reach no doc within 3 call hops</summary>

- `<qualname>` (<change>) — <t> raw text matches in the docs; check with `git grep -nw <name> -- '*.md' '*.mdx'`

</details>

#### Verdicts

| Verdict | Section | Reason |
|---|---|---|
| <ok|stale|governed|skipped> | [<heading>](<url>) | <reason> |

Proposed edits: `npx staleproof patch <pr-url>`

This pull request also edits `<path>`, …: examples on those pages are run after the change as the pull request leaves them; the sections above are linked as they are on the default branch.

<the agent's summary, in agent mode>

<sub>[Staleproof](https://github.com/rajkaria/staleproof) · FalkorDB graph `<org>` · <before>..<after></sub>
```

| Part | Content |
|---|---|
| Marker | `<!-- staleproof -->` on the first line, invisible on GitHub. The post step finds the comment by it. |
| Title | `this pull request breaks <n> docs example(s)` when any example breaks; otherwise, when every impacted section is on a page the pull request edits itself, `the <n> doc sections this pull request reaches are on pages it edits`; otherwise `<total> doc section(s) this pull request can make false`; or `no docs reach the code this pull request changed`. |
| Summary | The impact summary: changed symbols, sections reached, the count per severity, and how many sections are in other repositories. When the pull request changed no Python symbol, it says so and the sections table is omitted. |
| Examples table | One row per example with a run recorded against this pull request, by this check or an earlier one, using the latest attempt on each side. **Before** and **After** are `passes`, the error's last line, `skipped (<reason>)`, `not installed (<reason>)`, or `—` when that side did not run. **Result** is `**breaks**: passes before this PR, fails after`, `fixed by this PR`, `passes before and after`, `already broken (fails before and after)`, `fails before and after, with a different error`, `fails`, `not run` (skipped) or `could not be installed`, followed by `(after: the page as this PR edits it)` for an example on a page the pull request edits. Omitted when no example ran. |
| Sections table | One row per impacted section; a section on a page the pull request edits is marked `(page edited in this PR)`. **Change** is `**breaking**` (removed, renamed, or a removed export), `**signature**` or `behavior` (body changed). **Evidence path** lists the nodes from the changed symbol to the doc. **Hops** is the path length and its confidence: `exact` when every edge was resolved through imports and types, `by-name` or `late` otherwise. Rows are in PageRank order of their page. Only the first 40 sections are rendered; the rest are counted below the table. |
| Cleared | Collapsed. The changed symbols with no path to any doc within 3 call hops, each with its raw text-match count and the `git grep` command to check it. Omitted when nothing is cleared. |
| Verdicts | The latest verdict per section for this pull request, from any source. Followed by the `patch` command when any verdict is `stale`. Omitted when there are none. |
| Edited pages | When the pull request edits Markdown pages of its own repository, a line naming them: their examples are run after the change as the pull request leaves them ([Example runner](example-runner.md#pull-requests-that-edit-the-page)), and the section links point at the default branch. |
| Agent summary | The model's closing summary, in agent mode only. |
| Footer | A link to Staleproof, the graph name and the two commits compared. |

## Known limits

- Not yet run on a live repository. The tests in the repository check that the action's commands and flags exist in the CLI, that no input is required, that the default `version` is the package's own, and that the comment marker matches.
- Code repositories are parsed as Python only; docs can be any Markdown or MDX.
- With the default FalkorDB, every run indexes the repository again and starts without decisions, verdict history or recorded runs.
- Graph mode samples: it runs at most `runs` examples, from exactly linked sections on the first impact page, and writes no verdicts.
- The sections table shows the first 40 impacted sections; the rest are counted, not listed.
- The raw text-match counts in the cleared list cover the docs repositories cloned on the runner: the ones the check indexed there.
- A FalkorDB at `falkordb-url` must be reachable from the runner: a public endpoint for GitHub-hosted runners, or a self-hosted runner on your network.

## Security notes

- **Both modes run code from the pull request.** Up to `runs` examples are installed from source at the pull request's commits and executed on the runner. The install step, which runs the pull request's build code, gets an allow-listed environment without `GITHUB_TOKEN`, the model key or the FalkorDB URL; the example itself inherits no environment and has no network other than the scratch FalkorDB. That is a guard, not a security boundary ([Example runner](example-runner.md#the-sandbox)). Set `runs: '0'` to run none: graph mode then only reads the diff.
- **Stay on `pull_request`.** GitHub gives `pull_request` runs for forks a read-only token and no secrets. Do not switch to `pull_request_target` to get a writable token for forks: it runs with your secrets and a write token, and the job would still install and run the fork's code.
- The action writes nothing to GitHub other than the one comment. Opening a docs pull request is a separate, manual `patch --open-pr`.

## Related

- [Install](install.md)
- [CLI](cli.md)
- [Use cases](use-cases.md)
- [Indexing](indexing.md)
- [Deploy](DEPLOY.md)
- [Troubleshooting and FAQ](troubleshooting.md)
