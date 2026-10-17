# GitHub Action

The composite action in [action.yml](../action.yml), `uses: rajkaria/staleproof@v1`, comments on every pull request with the docs it can make false: the references in its docs, READMEs and AI agent files it makes wrong (also as annotations), the doc sections its code changes reach with the evidence path for each, the examples whose calls no longer fit the changed code, and the result of running the affected docs examples before and after the change. On a schedule it audits the whole docs instead and keeps one issue up to date. It needs no inputs, no secrets and no database: it starts a FalkorDB inside the job and indexes the repository itself. This page is for maintainers adding it to a repository: installing it, what a run does, the inputs and outputs, permissions, agent mode and the docs fix pull request, the scheduled audit, keeping a graph between runs, and the comment format. Status: it has run end to end on a private test repository, from the one-click workflow with no inputs: the comment named a README example the pull request broke, and updated in place when the same pull request fixed the README. No workflow file? The [GitHub App](github-app.md) runs the same check (without example runs) on every pull request once installed.

## Install it

### One click from the install page

1. Open [staleproof.dev/#/install](https://staleproof.dev/#/install) and type the repository (`owner/name`, or paste a repository or pull request URL).
2. Optionally, under Options: a docs repository to index with it, agent mode, failing the check when an example breaks, and a weekly audit of the whole docs (adds a `schedule` trigger and `issues: write`).
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

For a weekly audit of the whole docs as well, add [examples/staleproof-audit.yml](../examples/staleproof-audit.yml) as a second workflow ([Audit the docs on a schedule](#audit-the-docs-on-a-schedule)).

## What a run does

The steps of [action.yml](../action.yml), in order, on a pull request (`mode: check`; in [audit mode](#audit-the-docs-on-a-schedule) the audit's steps replace steps 6 to 12, and `mode: fix` and `mode: release` skip FalkorDB and run one step of their own: [Fix the docs every week](#fix-the-docs-every-week), [Release gate](#release-gate)):

1. **Set up Node.js and uv**: `actions/setup-node@v7` with Node 22, and `astral-sh/setup-uv@v10.3.0` (the example runner builds its virtualenvs with uv).
2. **Start FalkorDB**, unless `falkordb-url` is set. With Docker on the runner (GitHub's Ubuntu runners have it), two containers from `falkordb/falkordb:latest`: `staleproof-graph` on port 6379 holds the graph, and `staleproof-scratch` on port 6390 is the disposable server the docs examples run against. The step waits up to 90 seconds for both ports, then sets `FALKORDB_URL=falkor://localhost:6379` and `STALEPROOF_SCRATCH_URL=falkor://localhost:6390` for the next steps. Without Docker it starts nothing, and the CLI starts both servers itself from falkordblite.
3. **Install staleproof**: `npm install -g staleproof@<version>` (default `0.6.0`). With `version: source`, the CLI is built from the action's own checkout instead (`npm ci`, then `tsup`). When the version cannot be installed from npm, the step warns `staleproof@<version> is not on npm; building it from this action's source instead.` and builds it the same way.
4. **Choose the mode**: with `mode: auto` (the default), `check` when there is a pull request (the `pull_request` event, or `pr-url`), else `audit`. Any other value than `auto`, `check`, `audit`, `fix` or `release` fails with `mode must be auto, check, audit, fix or release (got <mode>)`.
5. **Re-index**, only with `reindex: 'true'` and `falkordb-url` set: `staleproof index <this repository> <also-index...>`. See [Keep the graph between runs](#keep-the-graph-between-runs).
6. **Check the pull request**:

   ```bash
   staleproof check "$PR_URL" --no-agent --runs "$RUNS" --format markdown --out "$RUNNER_TEMP/staleproof-report.md" [--with <also-index...>]
   ```

   `--no-agent` is left out when `anthropic-api-key` is set, and `--annotations` is added when the installed CLI has it (0.5 and later). When the graph does not have the pull request's repository yet, the CLI first indexes it together with the `also-index` repositories, at their default branch heads; with the default throwaway FalkorDB that happens on every run. Then it runs the check (graph mode: the docs references the pull request makes wrong, impact, clearance, ranking, then up to `runs` examples before and after the pull request, those predicted to break first), prints one workflow command per new finding (the annotations), writes the report, and the step appends the report to the job summary and reads the examples that break and the examples predicted to break from the report's last line (`<!-- staleproof:counts breaks=<n> predicted=<n> … -->`) and the new findings from the line before it (`<!-- staleproof:findings new=<n> errors=<n> warnings=<n> -->`).
7. **Suggest the fixes**, when `suggestions` is `'true'` (the default) and the pull request makes a docs reference wrong: `staleproof suggest "$PR_URL" --out <file>` posts the [verified fixes](fix.md) on the diff as GitHub suggestions and lists the fixes outside the diff, which the step appends to the report. A CLI older than 0.6 has no `suggest` and the step does nothing; a read-only token (a fork's) gets a warning.
8. **Post or update the comment**, when `comment` is `'true'`: the GitHub CLI lists the pull request's comments (all pages), takes the first whose body starts with `<!-- staleproof -->` (or `<!-- lockstep-docs -->`, the marker from before the rename) and is not the [GitHub App](github-app.md)'s (marked `<!-- staleproof:app -->`), and replaces its body with the report. If there is none, it posts a new comment. This step runs even when an earlier step failed, as long as a report was written.
9. **Open the docs fix as a pull request**, only with `open-docs-pr: 'true'`, an `anthropic-api-key`, and a pull request from this repository (not a fork), when the agent proposed edits: see [Open the docs fix as a pull request](#open-the-docs-fix-as-a-pull-request).
10. **Fail on broken examples**, with `fail-on: breaks` or `predicted`: the step fails with `This pull request breaks <n> docs example(s): they pass before it and fail after. See the report in the job summary.` when the report has any.
11. **Fail on predicted breaks**, with `fail-on: predicted`: the step fails with `A static check predicts this pull request breaks <n> docs example(s): their calls no longer fit the changed code. See the report in the job summary.` when any example is predicted to break.
12. **Fail on docs references the pull request makes wrong**, with `fail-on: findings`: the step fails with `This pull request makes <n> docs reference(s) wrong (paths, links, commands or settings the docs and agent files still name). See the annotations and the report in the job summary.` when the pull request adds any error-level finding.

Because the comment is found by its first-line marker, each run edits the same comment instead of adding a new one.

When the check command fails without writing a report (for example a pull request URL it cannot read), the check step fails with `staleproof check failed (exit <status>); see the log above.` When it fails after writing one (an agent check that ends `error` or `refused`), the step warns `staleproof check ended with exit <status>; the report may be incomplete.`, passes, and the comment is posted. Run outside a pull request event without `pr-url`, the step fails with `No pull request to check: run this on pull_request events, or set pr-url.`

## Docs this pull request makes wrong

A pull request can make a doc wrong without touching it: rename a script in `package.json` and the README's `npm run` of it fails; move a file and `AGENTS.md` sends every coding agent to a path that is gone. Each check lints the repository's docs, READMEs and AI agent instruction files ([Lint docs and agent files](lint.md)) at the two commits the pull request is compared between, from the clone the check already made, and reports the findings only the head has. Fingerprints ignore line numbers, so text added above an old finding never makes it new.

They show up three ways:

- **In the comment**, as the first section after the summary, AI agent instructions first:

  ```markdown
  #### Docs this pull request makes wrong

  References that were true at `1a2b3c4` and are not after this pull request, in the docs, READMEs and AI agent instructions (read from the repository at both commits; no graph needed):

  **AI agent instructions**

  - [`AGENTS.md:5`](https://github.com/acme/app/blob/<head>/AGENTS.md#L5) `lint:docs` is not a script in package.json. <sub>command-missing</sub>
  - [`AGENTS.md:6`](https://github.com/acme/app/blob/<head>/AGENTS.md#L6) `docs/setup.md` does not exist; it moved to `docs/guides/setup.md`. <sub>path-missing</sub>

  **README and contributing guides**

  - [`README.md:10`](https://github.com/acme/app/blob/<head>/README.md#L10) `lint:docs` is not a script in package.json. <sub>command-missing</sub>

  <sub>3 errors in 2 files (12 files checked, 840 ms).</sub>
  ```

  The title says `this pull request makes <n> docs reference(s) wrong` when nothing broke or is predicted to break. A pull request that makes nothing wrong gets no section, only `docs references: none made wrong (<n> files checked)` in the footer.
- **As annotations**: one `::error`/`::warning`/`::notice` workflow command per new finding, with the file, line and column range, titled `Staleproof <rule>`. GitHub lists them on the run's summary, and on the pull request's Files tab next to the lines the pull request changed.
- **As the `findings` output**, and `fail-on: findings` fails the job when any new finding is an error.

Examples are left to the graph part of the check (predicted breaks and runs), so lint's own example rules are not repeated here. The lint needs no graph and does not depend on `runs`.

**Suggested fixes.** When a finding has a verified fix (see [Fix stale docs](fix.md)) and its lines are on the pull request's diff, the Action posts it as a GitHub suggestion that the author can commit with one click; one review per push, and a suggestion already posted is updated instead of repeated. Fixes outside the diff are listed at the end of the comment with `npx staleproof fix`. Turn suggestions off with `suggestions: false`.

## Inputs

Every input is optional.

| Input | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `auto`: check the pull request when there is one (`pull_request` events, or `pr-url`), audit the docs otherwise (`schedule`, `workflow_dispatch`, `push`). `check` or `audit` forces one. `fix`: keep one pull request from `staleproof/fix-docs` with every verified docs fix at the default branch ([Fix the docs every week](#fix-the-docs-every-week)). `release`: the [release gate](release.md) (needs `actions/checkout` with `fetch-depth: 0`). |
| `also-index` | `''` | Other repositories to index together with this one, space- or comma-separated, for example your docs site `acme/docs`, so calls and doc links across them resolve. Passed to `check --with`, audited with this repository in audit mode, and passed to `index` with `reindex`. |
| `anthropic-api-key` | `''` | Selects the mode. Empty: graph mode (`--no-agent`). Set: agent mode, passed as `ANTHROPIC_API_KEY`. |
| `model` | `''` | Agent mode's model, passed as `STALEPROOF_MODEL`. Empty: `claude-sonnet-5-5`. Set it whenever you set `base-url`. |
| `base-url` | `''` | An Anthropic-compatible API for agent mode, passed as `ANTHROPIC_BASE_URL`, for example `https://api.deepseek.com/anthropic`. |
| `runs` | `'3'` | Graph mode runs up to this many affected examples before and after the pull request; `'0'` runs none. Passed as `--runs`. |
| `fail-on` | `never` | Check mode: `breaks` fails the job when an example passes before the pull request and fails after it; `predicted` also fails it when a static check predicts an example's call no longer fits the changed code; `findings` fails it when the pull request makes a docs reference wrong (a new error-level lint finding). Audit mode: `mismatches` fails the job when any example no longer fits the code. |
| `fail-under` | `''` | Audit mode: fail the job when the docs health score is below this (0-100). |
| `audit-runs` | `'20'` | Audit mode: run up to this many Python, JavaScript and TypeScript examples at the default branch before scoring; `'0'` for static checks only. Passed as `audit --run`. |
| `issue` | `'true'` | Audit mode: keep one issue up to date with the audit (opened when something needs fixing, updated on each run, closed when all clear). Needs `issues: write`. |
| `open-docs-pr` | `'false'` | Agent mode, on a pull request from this repository: `'true'` opens the proposed docs edits as a pull request into the checked pull request's branch. Needs `contents: write` and `pull-requests: write`. |
| `suggestions` | `'true'` | Check mode: post the verified fix for each docs reference the pull request makes wrong as a suggestion on its diff, one review per push (earlier suggestions updated, never repeated); the fixes outside the diff are listed in the comment with `npx staleproof fix`. Needs `pull-requests: write`. |
| `comment` | `'true'` | Post one pull request comment and keep updating it. Any other value: the report goes to the job summary only. |
| `pr-url` | `''` | The pull request to check. Empty: the one that triggered the workflow (`github.event.pull_request.html_url`). |
| `falkordb-url` | `''` | A FalkorDB that keeps the graph between runs (decisions, verdicts, run history). Empty: the throwaway FalkorDB the job starts. |
| `org` | `''` | The graph name on `falkordb-url`; ignored without it. Empty: the CLI's default, the owner of the repository lowercased (the input's description in `action.yml` says `falkordb`, which is what that rule gives for FalkorDB's repositories). |
| `reindex` | `'false'` | With `falkordb-url`: `'true'` re-indexes this repository and `also-index` at their default branch heads before the check. |
| `cache` | `'true'` | Keep the job's graph (a FalkorDB dump) and the parse cache between runs with actions/cache, keyed by the Staleproof version, the repository, `also-index` and the base commit: a later run on the same base skips indexing, and an older dump is re-indexed with only the changed files parsed. Ignored with `falkordb-url`. |
| `github-token` | `${{ github.token }}` | Reads the repository (clones, the GitHub API, file contents) and posts the comment. Passed as `GITHUB_TOKEN` to Staleproof and as `GH_TOKEN` to the GitHub CLI. |
| `version` | `'0.6.0'` | The `staleproof` npm version to run, or `source` to build the CLI from the action's checkout. When that version is not on npm, the CLI is built from the action's source. |
| `digest-webhook` | `''` | Audit mode: a Slack, Discord or other webhook (use a secret) to post the [docs digest](audit.md#weekly-digest-to-slack-or-discord) to after each audit. The digest's state is kept in the audit issue. |
| `release-from` | `''` | Release mode: the previous release to compare with. Empty: the latest tag before the release. |
| `release-to` | `''` | Release mode: the release. Empty: the checkout's `HEAD` (the tag on `release: published`). |
| `release-fail-on` | `undocumented-breaking,stale-docs` | Release mode: which gates fail the job, or `never`. |
| `changelog` | `''` | Release mode: the changelog file. Empty: `CHANGELOG.md`, `CHANGES.md`, `HISTORY.md`, ... |

## Outputs

| Output | Meaning |
|---|---|
| `report` | Check mode: path of the Markdown report, the comment's body: `$RUNNER_TEMP/staleproof-report.md` |
| `breaks` | Check mode: how many docs examples pass before the pull request and fail after it |
| `predicted` | Check mode: how many docs examples a static check predicts the pull request breaks (their call no longer fits the changed code) |
| `findings` | Check mode: how many docs references the pull request makes wrong (new lint findings of every severity; `0` when they were not checked) |
| `fix-pr` | Fix mode: the URL of the docs fix pull request (empty when nothing is left to fix) |
| `score` | Audit mode: the docs health score, 0-100 |
| `mismatched` | Audit mode: how many examples no longer fit the code |
| `breaking` | Release mode: how many breaking public API changes the release makes |
| `undocumented` | Release mode: how many of them the changelog does not name |
| `stale-docs` | Release mode: how many docs references still rely on what the release changed |

`breaks` and `predicted` are read from the report's counts line (`<!-- staleproof:counts breaks=<n> predicted=<n> sections=<n> mismatched=<n> -->`); a report from a CLI older than 0.3.0 has none, and `breaks` then counts the rows marked `**breaks**`. `findings` is read from `<!-- staleproof:findings new=<n> errors=<n> warnings=<n> -->`, which a report has when the docs references were checked (CLI 0.5 and later). `score` and `mismatched` come from the audit report's last line (`<!-- staleproof:audit score=<n> mismatched=<n> failing=<n> coverage=<n> -->`).

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
| `issues: write` | Audit mode with `issue: 'true'`: open, update and close the audit issue. |
| `contents: write` | `open-docs-pr: 'true'`: push the docs fix branch (with `pull-requests: write` to open its pull request). `mode: fix`: push the `staleproof/fix-docs` branch (with `pull-requests: write` to open, update and close its pull request). |

**Private repositories** work with the default token. Staleproof sends it to `https://github.com/` for clones (through git's environment config, never in the remote URL or on the command line), to the GitHub API and to `raw.githubusercontent.com`. The default token reads only the repository the workflow runs in: a private `also-index` repository elsewhere needs a token that can read it, passed as `github-token` (the comment is then posted as that token's account).

**Pull requests from forks** get a read-only token and no repository secrets. The check still runs, in graph mode (an `anthropic-api-key` from a secret is empty there), and the report goes to the job summary; the comment step ends with the warning `Could not comment on the pull request (pull requests from forks get a read-only token). The report is in the job summary.`

## Agent mode and graph mode

| | Graph mode (no key, the default) | Agent mode (`anthropic-api-key` set) |
|---|---|---|
| Command | `check <pr> --no-agent --runs <runs> --format markdown` | `check <pr> --runs <runs> --format markdown` (`--runs` applies to graph mode only; the agent chooses its own runs) |
| What runs | Impact (with the examples predicted to break), clearance and PageRank ranking, then up to `runs` examples (default 3) before and after the pull request: those predicted to break first, then examples from exactly linked sections. No model. | The full agent check: the model reads sections, runs examples on the runner, checks decisions and records a verdict or an edit for every impacted section. |
| What is stored | A Check node (model `graph-only (no model)`) with the trace and the runs | A Check node with the trace, verdicts and runs |
| Comment | The examples predicted to break, the examples run before and after, the impacted sections, cleared symbols, and any verdicts recorded earlier | The same, with this check's verdicts and the agent's summary; with `open-docs-pr`, the fix as a pull request |
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

## Open the docs fix as a pull request

In agent mode the model proposes replacement text for the sections a pull request makes false. With `open-docs-pr: 'true'`, the action turns those edits into a second pull request into the checked pull request's own branch, so the docs fix lands with the code change:

```yaml
permissions:
  contents: write
  pull-requests: write

jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/staleproof@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          open-docs-pr: 'true'
```

The step runs only when the check proposed edits (the comment then ends its verdicts with `Proposed edits: …`), the pull request comes from this repository (a fork's head branch cannot be written to), and agent mode is on. It runs

```bash
staleproof patch "$PR_URL" --open-pr --in-repo --base "<the pull request's head branch>" --only "<this repository>"
```

which creates or resets the branch `staleproof/docs-<owner>-<repo>-<number>` at the head of the pull request's branch, commits each edited file in this repository, and opens a pull request from it into the pull request's branch (or reuses the open one). Edits in other repositories (an `also-index` docs site) are left to `staleproof patch` by hand, since the job's token can write only to its own repository. When the step cannot open it, it warns `Could not open the docs fix pull request (the job needs contents: write and pull-requests: write).` and the job continues.

GitHub does not start workflows for pull requests a workflow's own `GITHUB_TOKEN` opens, so the docs fix pull request gets no checks of its own unless you pass another token as `github-token`.

## Audit the docs on a schedule

With no pull request (a `schedule`, `workflow_dispatch` or `push` event, or `mode: audit`), the action audits the docs instead: every example's calls checked against the code, examples run at the default branch, and API coverage, scored 0 to 100 ([Docs audit](audit.md)). [examples/staleproof-audit.yml](../examples/staleproof-audit.yml), without its header comment:

```yaml
name: Staleproof docs audit
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/staleproof@v1
        # with:
        #   also-index: your-org/docs   # docs in another repository
        #   audit-runs: 20              # examples to run (0: static checks only)
        #   fail-on: mismatches         # fail the job when an example no longer fits the code
```

The steps after **Choose the mode**:

1. **Audit the docs**: `staleproof audit <this repository> <also-index...> --run <audit-runs> --format markdown --out "$RUNNER_TEMP/staleproof-audit.md"`. With the default throwaway FalkorDB this indexes the repositories at their default branch heads first. The report goes to the job summary, and the step reads `score`, `mismatched` and the number of failing runs from its last line. When the command writes no report, the step fails with `staleproof audit failed (exit <status>); see the log above.`
2. **Post the docs digest**, when `digest-webhook` is set: `staleproof digest` posts what changed since the last digest to the webhook (Slack, Discord or JSON by its host) and appends its hidden state line to the report, so the issue keeps it for the next run ([Docs audit](audit.md#weekly-digest-to-slack-or-discord)). A failed post is a warning, never a failed job.
3. **Keep the audit issue up to date**, when `issue` is `'true'`: the GitHub CLI looks for an open issue whose body starts with `<!-- staleproof-audit -->`.
   - Found: its title becomes `Docs health <score>/100: <n> example(s) no longer fit the code` and its body the new report. When nothing needs fixing any more (no mismatched example and no failing run), it adds the comment `All clear: every docs example fits the code again. Closing.` and closes the issue.
   - Not found, and something needs fixing: it opens one with that title and body. Without `issues: write` it warns `Could not open the audit issue (the job needs issues: write). The report is in the job summary.`
   - Not found, and nothing to fix: `Nothing to fix: no issue opened.`
4. **Fail on the audit**, with `fail-on: mismatches` when an example no longer fits the code, or with `fail-under` when the score is below it: `Docs health <score>/100; <n> example(s) no longer fit the code. See the report in the job summary.`

A low API coverage lowers the score but never opens the issue on its own: the issue tracks examples that a reader would copy and see fail. The issue is matched by its body's first line, so editing its title by hand is fine; after you close it by hand, the next run that finds something opens a new one.

## Fix the docs every week

`mode: fix` is Renovate for docs: on a schedule it lints the default branch, applies every fix that passes re-checking on the branch `staleproof/fix-docs`, and keeps one pull request, `Staleproof: fix N stale docs references`, with a table of the fixes and the evidence for each. Each run rebuilds the branch from the default branch and updates the same pull request; when nothing is left it closes it. A pull request you close without merging is not reopened until the fixes change. It needs no FalkorDB and no model key.

```yaml
# .github/workflows/staleproof-fix.yml
name: Staleproof fix docs
on:
  schedule:
    - cron: '17 6 * * 1'
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/staleproof@v1
        with:
          mode: fix
```

The same file is [examples/staleproof-fix.yml](../examples/staleproof-fix.yml). Staleproof writes only the branch `staleproof/fix-docs`; it never pushes to another branch. Pull requests opened with the default `GITHUB_TOKEN` do not start other workflows; use a token of your own (`github-token`) if the fix pull request should run your CI.

## Release gate

`mode: release` runs [`staleproof release`](release.md) on the checked-out repository when a release is published: breaking public API changes since the previous tag, whether the changelog names them, and docs still relying on what changed. Copy [examples/staleproof-release.yml](../examples/staleproof-release.yml); it checks out the repository with `fetch-depth: 0` (the gate reads both commits from the clone). The report goes to the job summary; `release-fail-on` decides what fails the job.

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
- A pull request is diffed on its first check, and again whenever its head has moved since (on `synchronize`, after new commits are pushed), so the comment follows the pull request. A merged pull request is never re-diffed.
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
        run: npx -y staleproof@0.6.0 index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
```

This workflow uses only the documented `index` command; unlike the action itself, it has not been run on GitHub. Re-indexing never deletes: what disappeared is marked `gone`, and verdicts and decisions keep pointing at it.

## Pin the version

`@v1` follows the action's `v1` tag, and the `version` input pins the CLI it installs (default `0.6.0`). For runs that cannot change under you, pin the action to a commit and the CLI to a version:

```yaml
- uses: rajkaria/staleproof@<commit-sha>
  with:
    version: 0.6.0
```

## The comment

The comment is the report that `check --format markdown` renders ([src/format/report.ts](../src/format/report.ts) and [src/format/markdown.ts](../src/format/markdown.ts)); it leads with what broke. The MCP tool `check_pull_request` returns the same report. Its shape, with placeholders in angle brackets:

```markdown
<!-- staleproof -->
### Staleproof: <title>

<n> changed symbols (and <m> added) reach <total> doc sections (<b> breaking, <a> signature, <c> behavior; <x> in other repositories). <p> examples are predicted to break, the call no longer fitting the changed code (<path>:<index>, …).

#### Docs this pull request makes wrong

References that were true at `<before>` and are not after this pull request, in the docs, READMEs and AI agent instructions (read from the repository at both commits; no graph needed):

**AI agent instructions**

- [`<path>:<line>`](<url of the line>) <message> <sub><rule></sub>

<sub><e> errors, <w> warnings in <f> files (<checked> files checked, <ms> ms).</sub>

**Predicted to break** — the call as written no longer fits the code after this pull request (a static check, before anything runs):

| Example | Call | Why |
|---|---|---|
| [<path>:<index>](<url of the line>) | `<call>` | `<Class.method>` requires `<param>`, which the example does not pass |

| Example | Before (`<before>`) | After (`<after>`) | Result |
|---|---|---|---|
| [<path>:<index>](<url>) | passes | `<error>` | **breaks**: passes before this PR, fails after |

| Change | Doc section | Repository | Evidence path (changed symbol ← … ← doc) | Hops |
|---|---|---|---|---|
| **breaking** | [<heading>](<url>) (page edited in this PR) | <owner>/<repo> | `<changed symbol>` ← `<caller>` ← `<doc>` | <hops> (<exact|by-name|late>) |

_<k> more sections not shown._

<details><summary><n> impacted example line(s) already did not fit the code before this pull request</summary>

- [<path>:<index> line <line>](<url>): <what does not fit>

</details>

<details><summary>Cleared: <n> changed symbol(s) reach no doc within 3 call hops</summary>

- `<qualname>` (<change>) — <t> raw text matches in the docs; check with `git grep -nw <name> -- '*.md' '*.mdx' '*.rst'`

</details>

#### Verdicts

| Verdict | Section | Reason |
|---|---|---|
| <ok|stale|governed|skipped> | [<heading>](<url>) | <reason> |

Proposed edits: `npx staleproof patch <pr-url>`

This pull request also edits `<path>`, …: examples on those pages are run after the change as the pull request leaves them; the sections above are linked as they are on the default branch.

<the agent's summary, in agent mode>

<sub>[Staleproof](https://github.com/rajkaria/staleproof) · FalkorDB graph `<org>` · <before>..<after></sub>
<!-- staleproof:findings new=<n> errors=<n> warnings=<n> -->
<!-- staleproof:counts breaks=<n> predicted=<n> sections=<n> mismatched=<n> -->
```

| Part | Content |
|---|---|
| Marker | `<!-- staleproof -->` on the first line, invisible on GitHub. The post step finds the comment by it. |
| Title | `this pull request breaks <n> docs example(s)` when any example breaks; otherwise `this pull request is predicted to break <n> docs example(s)` when a static check predicts any; otherwise `this pull request makes <n> docs reference(s) wrong` (followed by `and can make <k> doc section(s) false` when its code reaches any) when it makes any; otherwise, when every impacted section is on a page the pull request edits itself, `the <n> doc sections this pull request reaches are on pages it edits`; otherwise `<total> doc section(s) this pull request can make false`; or `no docs reach the code this pull request changed`. |
| Summary | The impact summary: changed symbols, sections reached, the count per severity, how many sections are in other repositories, how many examples are predicted to break and how many impacted examples already did not fit the code. When the pull request changed no symbol of the indexed code, it says so and the sections table is omitted. |
| Docs this pull request makes wrong | The new lint findings, grouped AI agent instructions first, then READMEs and contributing guides, then docs; each links to its line at the pull request's head, with the rule and, when Staleproof has a verified fix, `Fix: <what to change>`. Followed by `It also fixes <n> reference(s) that were wrong before.` when the pull request removes findings. Omitted when there are none, or when the docs references could not be checked (the footer then says `docs references not checked: <why>`). See [Docs this pull request makes wrong](#docs-this-pull-request-makes-wrong). |
| Predicted to break | One row per example line whose call no longer fits the code after the pull request, linked to the line: a call to a removed or renamed symbol, an import of a name the package stops exporting, or a call the new signature rejects that the old one accepted (an unknown keyword, too many positional arguments, a new required argument). `(matched by name)` marks a removed symbol linked by name only. Found without running anything, so it works with `runs: '0'` and on the hosted service. Omitted when there are none. [Predicted breaks](concepts.md#predicted-breaks) has the rules. |
| Examples table | One row per example with a run recorded against this pull request, by this check or an earlier one, using the latest attempt on each side. **Before** and **After** are `passes`, the error's last line, `skipped (<reason>)`, `not installed (<reason>)`, or `—` when that side did not run. **Result** is `**breaks**: passes before this PR, fails after`, `fixed by this PR`, `passes before and after`, `already broken (fails before and after)`, `fails before and after, with a different error`, `fails`, `not run` (skipped) or `could not be installed`, followed by `(after: the page as this PR edits it)` for an example on a page the pull request edits. Omitted when no example ran. |
| Sections table | One row per impacted section; a section on a page the pull request edits is marked `(page edited in this PR)`. **Change** is `**breaking**` (removed, renamed, or a removed export), `**signature**` or `behavior` (body changed). **Evidence path** lists the nodes from the changed symbol to the doc. **Hops** is the path length and its confidence: `exact` when every edge was resolved through imports and types, `by-name` or `late` otherwise. Rows are in PageRank order of their page. Only the first 40 sections are rendered; the rest are counted below the table. |
| Already out of date | Collapsed. Impacted example lines that did not fit the code before the pull request either: drift the pull request did not cause, worth fixing anyway. Omitted when there are none. |
| Cleared | Collapsed. The changed symbols with no path to any doc within 3 call hops, each with its raw text-match count and the `git grep` command to check it. Omitted when nothing is cleared. |
| Verdicts | The latest verdict per section for this pull request, from any source. Followed by the `patch` command when any verdict is `stale`. Omitted when there are none. |
| Edited pages | When the pull request edits Markdown pages of its own repository, a line naming them: their examples are run after the change as the pull request leaves them ([Example runner](example-runner.md#pull-requests-that-edit-the-page)), and the section links point at the default branch. |
| Agent summary | The model's closing summary, in agent mode only. |
| Footer | A link to Staleproof, the graph name and the two commits compared (and, when the docs references were checked and none is new, `docs references: none made wrong (<n> files checked)`), then the findings line and the counts line the action's outputs are read from (invisible on GitHub; `mismatched` counts lines). |

## Known limits

- The pull request check has run end to end on a private test repository (top of this page), and audit mode has run on GitHub too. For the rest, the tests in the repository check that the action's commands and flags exist in the CLI, that no input is required, that the default `version` is the package's own, that the comment marker matches, that the counts and audit lines parse into the outputs, and that the audit workflow in `examples/` runs on a schedule with `issues: write` and no secrets.
- Code is read as Python, or TypeScript and JavaScript in published npm packages; docs as Markdown, MDX or reStructuredText. Go is read too. Python, JavaScript and TypeScript examples are run; Python, TypeScript/JavaScript and Go calls get argument checks.
- Predicted breaks are static: they follow calls resolved through imports and types, and stay silent where the source cannot settle the call (a decorator that may change the signature, a splat, a dynamic class). A pull request with no predicted break can still break an example; the runs are the proof.
- The audit issue is looked up among the first 100 open issues.
- "Docs this pull request makes wrong" lints the pull request's own repository only, at the two commits the check compares; a doc in an `also-index` repository that names a path of this one is covered by the graph part, not by lint. Annotations for lines the pull request did not change (an untouched README) are listed on the run's summary rather than inline on the Files tab. It is skipped (with a footer note) when linting both commits takes longer than 120 seconds.
- With the default FalkorDB, every run indexes the repository again and starts without decisions, verdict history or recorded runs.
- Graph mode samples: it runs at most `runs` examples (predicted breaks first, then exactly linked sections on the first impact page) and writes no verdicts.
- The sections table shows the first 40 impacted sections; the rest are counted, not listed.
- The raw text-match counts in the cleared list cover the docs repositories cloned on the runner: the ones the check indexed there.
- A FalkorDB at `falkordb-url` must be reachable from the runner: a public endpoint for GitHub-hosted runners, or a self-hosted runner on your network.

## Security notes

- **Both modes run code from the pull request.** Up to `runs` examples are installed from source at the pull request's commits and executed on the runner. The install step, which runs the pull request's build code, gets an allow-listed environment without `GITHUB_TOKEN`, the model key or the FalkorDB URL; the example itself inherits no environment and has no network other than the scratch FalkorDB. That is a guard, not a security boundary ([Example runner](example-runner.md#the-sandbox)). Set `runs: '0'` to run none: graph mode then only reads the diff.
- **Stay on `pull_request`.** GitHub gives `pull_request` runs for forks a read-only token and no secrets. Do not switch to `pull_request_target` to get a writable token for forks: it runs with your secrets and a write token, and the job would still install and run the fork's code.
- The action writes to GitHub only: the one pull request comment; in audit mode, the one audit issue (with `issue: 'true'`); and with `open-docs-pr: 'true'`, one branch and one pull request into the checked pull request's branch. Without `open-docs-pr`, opening a docs pull request is a manual `patch --open-pr`.
- **`open-docs-pr` writes to your repository.** It needs `contents: write`, so the job's token has it while the job installs and runs the pull request's examples. The install step and the examples never receive the token, but the sandbox is a guard, not a security boundary. The step is skipped for pull requests from forks, which get a read-only token anyway.

## Related

- [Install](install.md)
- [CLI](cli.md)
- [Use cases](use-cases.md)
- [Indexing](indexing.md)
- [Deploy](DEPLOY.md)
- [Troubleshooting and FAQ](troubleshooting.md)
- [GitHub App](github-app.md)
- [Fix stale docs](fix.md)
- [Release gate](release.md)
