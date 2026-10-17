# Install

Six ways to use Staleproof, from nothing installed to one command on your machine: the website, the GitHub App, the GitHub Action, an MCP server for your AI assistant, the CLI, and your editor. Each section says what it needs, what it does, and what it does not do. The site's install page, [staleproof.dev/#/install](https://staleproof.dev/#/install), has the one-click buttons for the Action and the MCP clients.

| Way | Needs | Runs examples | Repositories |
|---|---|---|---|
| [Website](#website-no-install) | A browser | No | Public |
| [GitHub App](#github-app-no-workflow-file) | Installing the App on the repository | No | Public and private |
| [GitHub Action](#github-action-one-click) | A workflow file in the repository | Yes, before and after each pull request | Public and private |
| [MCP, hosted](#mcp-hosted-no-install) | An MCP client | No | Public |
| [MCP, local](#mcp-local) | Node.js 20+, git, uv or `python3` | Yes | Public and private (with `GITHUB_TOKEN`) |
| [CLI](#cli-one-command) | Node.js 20+, git, uv or `python3` | Yes | Public and private (with `GITHUB_TOKEN`) |
| [Editors](#editors-while-you-type) | Node.js 20+, git, an LSP-capable editor | No | Any local checkout |

## Website: no install

Open [staleproof.dev](https://staleproof.dev) and paste the URL of a pull request in a public GitHub repository, or open `https://staleproof.dev/#/try?pr=<pull request URL>`, which starts the check directly.

- **What it does.** The first check of a repository downloads it and indexes it on the fly into the workspace graph of its owner (`gh-<owner>`), together with any repositories you name next to it (a docs site, an SDK; up to 4 per workspace), then checks the pull request in graph mode and streams the trace: the impacted doc sections with their evidence paths, the cleared symbols and the ranking. Agent mode is offered when the server has a model key, within a daily budget.
- **Audit a repository.** [staleproof.dev/#/audit](https://staleproof.dev/#/audit) audits a public repository with no pull request: every docs example checked against the code it calls, API coverage, a 0-100 health score and the README badge ([Docs audit](audit.md)).
- **What it does not do.** It does not run examples: the hosted service has no sandbox. For FalkorDB's own repositories it shows the runs recorded earlier. It reads public repositories only, and leaves nothing on your repository: no comment, no pull request.

## GitHub App: no workflow file

Install the [GitHub App](github-app.md) from [staleproof.dev/#/install](https://staleproof.dev/#/install) (**Install the GitHub App**, shown once the server has an App), pick the repositories, and click **Install**: no YAML. Or add the [Action](#github-action-one-click) below for example runs.

- **What it does.** Every pull request gets a **Staleproof** check run with the docs references it makes wrong (as annotations), the doc sections its code changes reach and the examples predicted to break, a comment only when there is something to say, and suggestions with an **Apply fixes** button for the fixes Staleproof can verify. Private repositories are read with the installation's token and indexed into a graph no public endpoint can read.
- **What it does not do.** It runs no examples and has no agent mode: the [GitHub Action](github-action.md) does both, in your own CI.

## GitHub Action: one click

On [staleproof.dev/#/install](https://staleproof.dev/#/install), type the repository and click **Add to owner/repo**. GitHub opens its "new file" page with `.github/workflows/staleproof.yml` filled in; click **Commit changes**. Options on the page add a docs repository to index with it (`also-index`), agent mode (needs an `ANTHROPIC_API_KEY` repository secret), failing the check when an example breaks (`fail-on: breaks`), and a weekly audit of the whole docs kept in one issue. Or copy [examples/staleproof.yml](../examples/staleproof.yml) yourself:

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
```

- **What it does.** On every pull request the job starts a FalkorDB, indexes the repository, checks the change (including the examples predicted to break), runs up to 3 affected examples at the commit before the pull request and at the pull request, and posts one comment (kept up to date) with the report; the report also goes to the job summary. On a schedule it audits the docs instead ([examples/staleproof-audit.yml](../examples/staleproof-audit.yml)). Private repositories work with the workflow's default token.
- **What it does not do.** It changes no files, and opens no pull request unless you set `open-docs-pr` in agent mode. Without `falkordb-url` it keeps nothing between runs. Pull requests from forks get a read-only token: the report lands in the job summary, not as a comment.

Inputs, outputs and the comment format: [GitHub Action](github-action.md).

## MCP, hosted: no install

The hosted MCP server speaks Streamable HTTP at `https://staleproof.dev/api/mcp`. Add it to your client:

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http staleproof https://staleproof.dev/api/mcp` |
| Cursor | The **Add to Cursor** button on the install page, or `{"mcpServers": {"staleproof": {"url": "https://staleproof.dev/api/mcp"}}}` in `~/.cursor/mcp.json` |
| VS Code | The **Add to VS Code** button on the install page, or `code --add-mcp '{"name":"staleproof","type":"http","url":"https://staleproof.dev/api/mcp"}'` |
| Claude Desktop and claude.ai | Add a custom connector with the URL `https://staleproof.dev/api/mcp` |

- **What it does.** `check_pull_request` returns the whole report for a pull request in one call; the graph tools behind it (`impact`, `read_section`, `decisions_for`, `rank_sections` and the rest) answer follow-up questions. Before a pull request, `docs_for_symbol` lists the docs that depend on a function and `check_changes` checks edited files; `audit_docs` audits a repository's docs. Any public repository is indexed on first use.
- **What it does not do.** `run_example` is not offered and no example is executed. Private repositories cannot be read.

## MCP, local

```bash
claude mcp add staleproof -- npx -y staleproof mcp
```

- **What it does.** Serves all fourteen tools over stdio, `run_example` included, from your machine. With no `FALKORDB_URL` it starts a local FalkorDB; the tools index the repository they are about the first time they see it. `check_changes` can read the working tree of your checkout directly. Private repositories work with `GITHUB_TOKEN` in the server's environment (`-e GITHUB_TOKEN=<token>`).
- **What it does not do.** It writes nothing to GitHub. The first start installs falkordblite, which takes a minute.

Other clients, the tools and security notes: [MCP server](mcp.md).

## CLI: one command

```bash
npx -y staleproof check https://github.com/<owner>/<repo>/pull/<n> --no-agent
```

- **What it needs.** Node.js 20 or newer, git, and uv (recommended) or `python3` 3.12 or newer for the local FalkorDB and the example runs.
- **What it does.** With no `FALKORDB_URL` it starts a local FalkorDB (falkordblite, no Docker), indexes the pull request's repository at its default branch head into a graph named after the owner, checks the pull request, and runs up to 3 affected examples before and after it in a sandbox. Later checks of the same repository reuse the graph. Add `--with <owner/docs>` for docs that live in another repository, and set `GITHUB_TOKEN` for a private repository.
- **Agent mode.** Without `--no-agent`, `check` runs the agent when model credentials are set: `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and `STALEPROOF_MODEL` for an Anthropic-compatible provider. Without them it prints a note and runs graph mode.
- **Before a pull request, and with none.** `npx -y staleproof check` with no URL checks your uncommitted and unpushed changes (`--fail-on-predicted` for a pre-push hook); `npx -y staleproof audit <owner/repo>` audits the docs as they are.
- **What it does not do.** It opens no pull request unless you run `patch --open-pr`.

The full walkthrough: [Quickstart](getting-started.md). Every command: [CLI](cli.md).

## Editors: while you type

`staleproof lsp` is a language server: the same findings as `staleproof lint`, from the unsaved text, in VS Code, Cursor, Windsurf, Neovim, Zed, Helix and JetBrains IDEs, with the verified fixes as quick fixes. Local only: no graph, no network. Setup for each editor: [Editors (LSP)](editors.md).

## Related

- [Quickstart](getting-started.md)
- [GitHub Action](github-action.md)
- [MCP server](mcp.md)
- [GitHub App](github-app.md)
- [Editors (LSP)](editors.md)
- [CLI](cli.md)
- [Deploy](DEPLOY.md): run the hosted service yourself
