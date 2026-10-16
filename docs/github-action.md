# GitHub Action

The composite action in [action/action.yml](../action/action.yml) comments on every pull request with the docs it can falsify, across every repository in your graph, with the evidence path for each. This page is for maintainers adding it to a repository: the workflow, inputs, permissions, the comment format and keeping the graph current. Status: written and command-tested, not yet run on a live repository.

## Add it to a repository

1. Index your repositories, all in one command, into a FalkorDB that GitHub's runners can reach (FalkorDB Cloud works; see [Deploy](DEPLOY.md)):

   ```bash
   export FALKORDB_URL='falkor://falkordb:<password>@<host>:<port>'
   npx -y staleproof --org falkordb index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
   ```

2. In the repository's settings, add the secret `STALEPROOF_FALKORDB_URL` with that URL. Optionally add `ANTHROPIC_API_KEY` for agent mode.

3. Add the workflow from [examples/staleproof.yml](../examples/staleproof.yml) as `.github/workflows/staleproof.yml`:

   ```yaml
   # .github/workflows/staleproof.yml — comment on every pull request with the docs it can falsify.
   name: Staleproof
   on:
     pull_request:
       types: [opened, synchronize, reopened]

   permissions:
     contents: read
     pull-requests: write

   jobs:
     docs:
       runs-on: ubuntu-latest
       steps:
         - uses: rajkaria/staleproof/action@main
           with:
             falkordb-url: ${{ secrets.STALEPROOF_FALKORDB_URL }}
             org: falkordb
             # anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}   # optional: the agent judges and proposes edits
   ```

Set `org` to the organisation you indexed with `--org` (or `STALEPROOF_ORG`). The workflow needs no checkout step: Staleproof clones the public repository itself.

## Inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `falkordb-url` | yes | | The FalkorDB holding your graph, `falkor[s]://user:password@host:port`. Passed as `FALKORDB_URL`. Store it as a secret. |
| `org` | yes | | The graph name, as used with `staleproof index --org`. Passed as `STALEPROOF_ORG`. |
| `github-token` | no | `${{ github.token }}` | Passed to Staleproof as `GITHUB_TOKEN` (pull request metadata from the GitHub API) and to the GitHub CLI as `GH_TOKEN` (reading and writing the comment). |
| `anthropic-api-key` | no | `''` | Selects the mode. Empty: graph mode. Set: agent mode, passed as `ANTHROPIC_API_KEY`. |
| `reindex` | no | `'false'` | `'true'` re-indexes this repository before the check. Read [Keep the graph current](#keep-the-graph-current) before turning it on. |
| `version` | no | `latest` | The `staleproof` npm version to run. |

## Permissions and secrets

| Need | Why |
|---|---|
| `pull-requests: write` | Create and update the comment on the pull request. |
| `contents: read` | The default read access for the workflow. |
| Secret `STALEPROOF_FALKORDB_URL` | The graph's URL, including its password. |
| Secret `ANTHROPIC_API_KEY` (optional) | Agent mode. |

The action reads the pull request URL and number from the `pull_request` event (`github.event.pull_request.html_url` and `.number`), so it works only in workflows triggered by pull request events.

## What each step runs

1. **Set up Node.js**: `actions/setup-node@v4` with Node 22.
2. **Re-index this repository**, only when `reindex` is `'true'`:

   ```bash
   npx -y "staleproof@<version>" index "<owner>/<repo>"
   ```

   with `FALKORDB_URL`, `STALEPROOF_ORG` and `GITHUB_TOKEN` set from the inputs.
3. **Check the pull request**:

   ```bash
   mode="--no-agent"
   if [ -n "$ANTHROPIC_API_KEY" ]; then mode=""; fi
   npx -y "staleproof@<version>" check "$PR_URL" $mode --format markdown --out staleproof-comment.md
   ```

   with `FALKORDB_URL`, `STALEPROOF_ORG`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY` and `PR_URL` set.
4. **Post or update the comment**: the GitHub CLI lists the pull request's comments (all pages), takes the first one whose body starts with `<!-- staleproof -->`, and replaces its body with `staleproof-comment.md`. If there is none, it posts a new comment.

Because the comment is found by its first-line marker, each run of the workflow edits the same comment instead of adding a new one.

## Agent mode and graph mode

| | Graph mode (no key) | Agent mode (`anthropic-api-key` set) |
|---|---|---|
| Command | `check <pr> --no-agent --format markdown` | `check <pr> --format markdown` |
| What runs | Impact, clearance and PageRank ranking only. No model, no example runs. | The full agent check: the model reads sections, runs examples on the runner, checks decisions and records a verdict or an edit for every impacted section. |
| What is stored | The pull request and its changes, the first time. No Check node. | A Check node with the trace, verdicts and runs. |
| Comment | Impact table, cleared symbols, and any verdicts recorded earlier (by an agent check, an MCP client or the API). | The same, with this check's verdicts and the agent's summary. |
| Cost | Nothing beyond the runner and FalkorDB. | Model tokens; minutes per pull request (a 43-section check takes about 6 minutes). |

Agent mode uses the default model, `claude-sonnet-5-5`. The action has no inputs for `ANTHROPIC_BASE_URL` or `STALEPROOF_MODEL`; to use an Anthropic-compatible provider such as DeepSeek, set them as job-level `env:` in the workflow, which the action's steps inherit (not exercised). When an agent check ends with status `error` or `refused`, the check step exits with 1 and the comment is not posted.

## The comment

The comment is the Markdown that `check --format markdown` renders ([src/format/markdown.ts](../src/format/markdown.ts)). Its shape, with placeholders in angle brackets:

```markdown
<!-- staleproof -->
### Staleproof: docs this pull request can falsify

<n> changed symbols (and <m> added) reach <total> doc sections (<b> breaking, <a> signature, <c> behavior; <x> in other repositories).

| Change | Doc section | Repository | Evidence path (changed symbol ← … ← doc) | Hops |
|---|---|---|---|---|
| **breaking** | [<heading>](<url>) | <owner>/<repo> | `<changed symbol>` ← `<caller>` ← `<doc>` | <hops> (<exact|by-name|late>) |

_<k> more sections not shown._

<details><summary>Cleared: <n> changed symbol(s) reach no doc within 3 call hops</summary>

- `<qualname>` (<change>) — <t> raw text matches in the docs; check with `git grep -nw <name> -- '*.md' '*.mdx'`

</details>

#### Verdicts

| Verdict | Section | Reason |
|---|---|---|
| <ok|stale|governed|skipped> | [<heading>](<url>) | <reason> |

Proposed edits: `npx staleproof patch <pr-url>`

<the agent's summary, in agent mode>

<sub>Staleproof · FalkorDB graph `<org>` · <before>..<after></sub>
```

| Part | Content |
|---|---|
| Marker | `<!-- staleproof -->` on the first line, invisible on GitHub. The post step finds the comment by it. |
| Summary | The impact summary: changed symbols, sections reached, the count per severity, and how many sections are in other repositories. When the pull request changed no Python symbol, it says so and the table is omitted. |
| Sections table | One row per impacted section. **Change** is `**breaking**` (removed, renamed, or a removed export), `**signature**` or `behavior` (body changed). **Evidence path** lists the nodes from the changed symbol to the doc. **Hops** is the path length and its confidence: `exact` when every edge was resolved through imports and types, `by-name` or `late` otherwise. Rows are in PageRank order of their page. Only the first 40 sections are rendered; the rest are counted below the table. |
| Cleared | Collapsed. The changed symbols with no path to any doc within 3 call hops, each with its raw text-match count and the `git grep` command to check it. Omitted when nothing is cleared. |
| Verdicts | The latest verdict per section for this pull request, from any source. Followed by the `patch` command when any verdict is `stale`. Omitted when there are none. |
| Agent summary | The model's closing summary, in agent mode only. |
| Footer | The graph name and the two commits compared. |

## Keep the graph current

The comment is only as current as the graph. The `reindex` input runs `index "<owner>/<repo>"` for the repository the workflow runs in, before each check. Two things make it the wrong tool for a graph of several repositories:

- **It indexes this repository alone.** Calls and doc links cross repositories only among the repositories of one `index` run. Re-indexing one repository re-resolves its calls and its docs' links against itself only, so its edges into the other repositories disappear until you re-index them all together. Links that earlier pull request checks added for removed symbols are dropped as well.
- **It indexes the default branch's head.** No `--ref` is passed, so the repository is checked out at the remote default branch's head, not at the pull request's base branch. The input's description in `action.yml` says "at the base branch"; the code does not do that.

Leave `reindex` at `'false'` unless the graph holds this one repository only. Instead, re-index every repository together on a schedule, from any one repository, for example as `.github/workflows/staleproof-index.yml`:

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
        run: npx -y staleproof@0.1.0 index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
```

This workflow uses only the documented `index` command; like the action, it has not been run on GitHub. Re-indexing never deletes: what disappeared is marked `gone`, and verdicts and decisions keep pointing at it.

## Pin the version

`version: latest` runs whatever npm has at the time of each run. For repeatable results, pin both the package and the action:

```yaml
- uses: rajkaria/staleproof/action@<commit-sha>
  with:
    falkordb-url: ${{ secrets.STALEPROOF_FALKORDB_URL }}
    org: falkordb
    version: 0.1.0
```

`@main` follows every change to the action itself; a commit SHA does not.

## Known limits

- Not yet run on a live repository. The test in the repository checks that the action's commands and flags exist in the CLI and that the comment marker matches.
- A pull request is diffed once, the first time it is checked. On `synchronize` (new commits pushed), the check reuses that first diff, so the comment does not reflect the new commits.
- In graph mode the comment never includes example runs, and no check is stored.
- The table shows the first 40 impacted sections; the rest are counted, not listed.
- The raw text-match counts in the cleared list cover only docs repositories cloned on the runner, which is usually just the pull request's own repository.
- The pull request's repository must already be in the graph; otherwise the check step fails with `<owner/repo> is not indexed in the "<org>" graph` and nothing is posted.
- FalkorDB must be reachable from the runner: a public endpoint for GitHub-hosted runners, or a self-hosted runner on your network.

## Security notes

- For pull requests from forks, GitHub gives `pull_request` workflows no repository secrets and a read-only token, so the action can neither reach the graph nor comment.
- Do not switch to `pull_request_target` to work around that while agent mode is on. In agent mode the model can run examples, which installs the pull request's code from source on the runner; package builds run with the step's environment, which holds your FalkorDB URL, model key and GitHub token.
- Graph mode only reads the pull request's diff; it runs no code from it.
- The action writes nothing to GitHub other than the comment. Opening a docs pull request is a separate, manual `patch --open-pr`.

## Related

- [CLI](cli.md)
- [Use cases](use-cases.md)
- [Indexing](indexing.md)
- [Deploy](DEPLOY.md)
- [Troubleshooting and FAQ](troubleshooting.md)
