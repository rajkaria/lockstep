# Changelog

## 0.6.1 — 2026-10-18

What `staleproof init` writes catches up with what is live, and the pull request report says less that is not so.

- **`staleproof init`**: the workflow it writes has the weekly fix job (`mode: fix`, allowed to fail) now that `v1`
  has fix mode, and `.vscode/extensions.json` recommends the VS Code extension `staleproof.staleproof`, now on the
  Visual Studio Marketplace.
- **Pull request report**: the line about pages the pull request edits says only what applies (examples run after
  the change, sections linked as on the default branch), and nothing when neither does, as in graph mode and the
  GitHub App.
- **GitHub App**: `github-app.json` and the docs register the webhook on `staleproof.dev`, the primary domain.
- Every pinned version (Action default, Claude Code plugin, docs) is 0.6.1.

## 0.6.0 — 2026-10-17

Fix, don't just flag; a GitHub App with no workflow file; diagnostics while you type; the team sees what was checked.

- **`staleproof fix`** ([docs/fix.md](docs/fix.md)) applies every fix Staleproof could re-check: renamed scripts, Make
  and just targets, CLI flags and subcommands, files, headings, environment variables, symbols and parameters, and
  close typos. Each fix is applied in a hard-linked mirror and linted again: its finding must go and nothing new may
  appear; the others are shown as hints, never applied. `--dry-run` prints the unified diff; `--rule`, `--new`,
  `--base`, `--format json`. A second run does nothing, and a file edited meanwhile is never overwritten.
  `staleproof lint --fixes` shows the fixes without applying them. Migration guides, release notes and old versions'
  docs are never rewritten, and ambiguous cases (ties, far names, short-word swaps) get no fix.
- **Suggestions on pull requests**: the verified fix for each docs reference a pull request makes wrong is posted as a
  GitHub suggestion on its diff, one review per push; an earlier suggestion is updated or marked superseded, never
  repeated, and the fixes outside the diff are listed in the comment (`staleproof suggest`, the Action's
  `suggestions` input, on by default).
- **Renovate for docs**: the Action's `mode: fix` and `staleproof fix-pr` keep one pull request from
  `staleproof/fix-docs` with every verified fix at the default branch, updated on each run and closed when nothing is
  left; a pull request you close is not reopened until the fixes change. Only `staleproof/*` refs are written
  ([`examples/staleproof-fix.yml`](examples/staleproof-fix.yml)). The Claude Code hooks name the verified fix
  (`Fix: …`).
- **GitHub App** ([docs/github-app.md](docs/github-app.md)): install once, no workflow file. Every pull request gets a
  "Staleproof" check run with the docs references it makes wrong as line annotations, the doc sections it reaches and
  the examples predicted to break (success, neutral or failure by `[app] fail-on`); a comment only when there is
  something to say, updated in place and edited to "All clear" when a later push fixes everything; verified fixes as
  suggestions, and an **Apply fixes** button that commits them to the branch (never forced; forks get a patch).
  Private repositories are read with the installation token and indexed into one graph per installation
  (`ghp-<id>`) that no public endpoint can read; removing the repository or uninstalling the App drops it. A daily
  `GET /api/github/cron` (`CRON_SECRET`) opens or updates the docs fix pull request (`[app] fix-prs`) and keeps the
  audit issue (`[app] audit-issue`). The `[app]` settings (`comment`, `fail-on`, `suggestions`, `drafts`,
  `also-index`, `fix-prs`, `audit-issue`) are read from the default branch. `github-app.json` and
  `scripts/github-app-register.ts` register your own App; `/api/health` reports `githubApp`, and the install page
  shows **Install the GitHub App** when `GITHUB_APP_SLUG` is set.
- **`staleproof lsp`** ([docs/editors.md](docs/editors.md)): a language server for VS Code, Cursor, Windsurf, Neovim,
  Zed, Helix and JetBrains (LSP4IJ). Diagnostics for docs, READMEs, AI agent files and docstrings from the unsaved
  text, 300 ms after an edit, the same findings as `staleproof lint` (same fingerprints); verified fixes (re-checked
  against the buffer), "ignore this rule here" and "fix all in file" (also `source.fixAll`) as code actions; hover
  and go to definition from a docs code span or example call to the code; "documented in N places", find references
  and a "N docs reference this" code lens from the code to the docs. Unsaved edits to `package.json`, Makefiles or
  `pyproject.toml` re-check the open docs at once. A VS Code and Cursor extension in `editors/vscode` (the server
  from `staleproof.path`, the workspace's `node_modules/.bin`, the `PATH`, then `npx -y staleproof@0.6.0`; settings
  `staleproof.enable`, `staleproof.codeLens` and `staleproof.path`; commands Fix all in file, Audit workspace and
  Restart server) and a Zed dev extension in `editors/zed`, both built but not yet published.
- **Checked stamp** ([docs/verified-stamp.md](docs/verified-stamp.md)): `GET /api/verified/<owner>/<repo>.json`
  (per-page status from the hosted audit, CORS `*`, a 10-minute CDN cache) and
  `GET /api/verified/<owner>/<repo>/stamp.js`, a script under 4 KB with no cookies, storage or referrer, light and dark
  aware, and exact about what was checked. Private (`ghp-`) graphs are never served. A Docusaurus plugin
  (`docusaurus-plugin-staleproof`) and a MkDocs plugin (`mkdocs-staleproof`) in `integrations/`, and a Mintlify or
  plain-HTML snippet.
- **`staleproof digest`**: the docs health change since the last digest, new drift with links, problems fixed and
  verified fixes, posted to Slack, Discord or any webhook; the state lives in the audit issue or the graph. The
  Action's `digest-webhook` input posts it after each scheduled audit.
- **CODEOWNERS routing**: the audit issue groups the docs to fix by owner, and the pull request comment lists "Owners
  of affected docs"; plain text unless `[audit] mention-owners = true`.
- **`staleproof release`** ([docs/release.md](docs/release.md)): the release gate. Breaking public API changes since
  the last tag, whether the changelog names them, docs still relying on what changed, and lint at the release;
  `--fail-on undocumented-breaking|stale-docs|never`, exit codes 0, 1 and 2. The Action's `mode: release` runs it
  ([`examples/staleproof-release.yml`](examples/staleproof-release.yml)).

Fixed by the end-to-end runs on GitHub:

- `open-docs-pr` re-applies each edit to the file on the pull request's branch, so the docs pull request never
  reverts the branch's own changes; an edit that no longer applies is left out and named, and nothing is opened
  when none is left.
- When the repository setting "Allow GitHub Actions to create and approve pull requests" is off, `mode: fix` and
  `open-docs-pr` say so, name the alternative (a token in `github-token`) and link to open the pull request by
  hand.
- A fix pull request Staleproof closed itself no longer counts as declined: the same drift coming back opens a new
  one.
- The Action's cache key includes the action's source when `version: source`, so runs on a moving ref like `@main`
  save a fresh graph instead of restoring an older one every time.
- A VS Code extension's `package.json` (`engines.vscode`) is no longer taken for an npm package, and when two
  manifests share a name the shallowest one is the package: an extension named like its library made every docs
  example importing that library report missing names. This repository's own lint is now a test.

## 0.5.0 — 2026-10-17

Commands, CLIs, environment variables, symbols and docstrings checked too; only what a change makes wrong in pull
requests; JS/TS argument checks and runs; Go.

- **More claims checked by `staleproof lint`** ([docs/lint.md](docs/lint.md)):
  - `command-missing`: `npm run`/`npm test`/`start`/`stop`, `pnpm [run]`, `yarn [run]`, `bun run` against the
    nearest `package.json` and the workspace that `-w`/`--filter`/`--prefix`/`yarn workspace`/`cd` pick; `make`
    targets (includes, `.PHONY`, pattern rules), `just` recipes, `task` tasks (included namespaces); near-renames of
    the repository's own scripts through `uv`/`poetry`/`hatch`/`pdm run`; `python -m` modules of its own packages.
  - `cli-command-unknown` and `cli-flag-unknown`: the repository's own CLI shown with a subcommand or option its
    definition lacks, however it is invoked (`npx`, `uv run`, `python -m`, `node dist/cli.js`, `tsx src/cli.ts`),
    read statically from commander, click, typer, argparse and strict yargs, across files.
  - `env-unused` (warning) and `env-undocumented` (info): documented environment variables (env example files, env
    tables, `export X=`, `X=1 cmd`, code spans next to "environment variable") that no code, build, CI or hook file
    reads, and product code reading a variable its `.env.example` does not list. Platform, toolchain and dependency
    variables, the docs' own examples, families and computed reads are never judged.
  - `symbol-missing`: a code span `Client.query_v2` / `pkg.connect_async()` whose owner is exactly the repository's
    own class or module and has no such member, with the same openness guards as the example checks.
  - `docstring-param-unknown` and `docstring-param-undocumented` (info): Google, NumPy and Sphinx docstrings and
    JSDoc/TSDoc `@param` against the signature, reported on the docstring line in the code file.
  - Code suppressions `# staleproof: ignore[rule]` / `// staleproof: ignore[rule]`; the code is parsed once for the
    example, symbol and docstring checks. Every finding on 22 public repositories was checked by hand; each false
    positive became a guard, ending with zero known at error severity.
- **Only what a change makes wrong** ([docs/lint.md](docs/lint.md#only-what-a-change-introduced)):
  `staleproof lint --new [--base <ref>]` reports the findings a change introduced, by line-independent fingerprint
  (default base: `HEAD` for uncommitted changes, else the merge base with the default branch; never fetched), and
  `--staged` lints the git index, also inside pre-commit hooks. A script renamed in `package.json` makes the untouched
  README's `npm run` a new finding.
- **Pull request checks list "Docs this pull request makes wrong"**: the docs and AI agent files linted at both
  commits, above the impact, in the comment, CLI text and JSON, and the web check view; graph mode's first step is
  `new_findings`; `check --annotations` prints GitHub workflow commands; `staleproof check` without a pull request lists
  what the working tree makes wrong. The GitHub Action adds the annotations, a `findings` output and
  `fail-on: findings`.
- **Index format 4**: lint findings are stored as Finding nodes in their doc sections; hosted workspaces re-index on
  next use and read every tarball path, hidden agent files included. The audit lists findings agent files first, with
  a "Docs references" deduction (3 per error, 1 per warning, at most 25) ([docs/audit.md](docs/audit.md)).
- **`GET /api/lint?repo=owner/name`** lints any public repository without indexing it (cached 10 minutes), and the
  MCP tool **`lint_docs`** does the same for agents (or a local checkout with `new_only`); `check_pull_request` and
  `check_changes` include the new findings.
- **JavaScript and TypeScript**: docs examples get `example-too-many-arguments` and `example-missing-argument`
  (optional, default, rest and destructured parameters as TypeScript reads them; every parameter optional in
  JavaScript files; overloads, decorators and `arguments` never judged); signature changes predict the examples they
  break; examples run in a Node sandbox against packages built from source at the pull request's commits, with only
  the scratch FalkorDB reachable ([docs/example-runner.md](docs/example-runner.md#javascript-and-typescript)).
  `audit --run` runs them too.
- **Go**: packages named from `go.mod` (multi-module repositories and `go.work`), Go examples in docs checked for
  missing or unexported names, argument counts (variadic aware) and packages, Go pull request diffs compared per
  package with predicted breaks ([docs/indexing.md](docs/indexing.md#go)).
- **Monorepos and precision for every language**: Python namespace packages split across uv workspace members
  resolve; API listing blocks, versioned copies of older docs and translated READMEs are not judged; subclass
  attributes and overrides are respected; long chains of example bindings resolve again.
- Fix: `lint --new` on a checkout reached through a symlink (macOS temporary folders) compared the working tree with
  itself.
- **Claude Code plugin** ([docs/claude-code.md](docs/claude-code.md)): `/plugin marketplace add rajkaria/staleproof`,
  then `/plugin install staleproof@staleproof`. After every edit Claude hears which docs and agent files the edit made
  wrong (path:line, rule); before it stops it is asked once to fix what the session introduced. A `staleproof`
  skill, `/staleproof:check`, `/staleproof:fix`, `/staleproof:audit` and `/staleproof:docs-for`, and the MCP server
  come with it. Everything runs locally.
- **`staleproof hook session-start|post-edit|stop`** for Claude Code and Cursor: silent when nothing is wrong, never
  fails the agent, blocks a stop at most once (`stop_hook_active`); `[hooks] stop = "block" | "warn" | "off"`,
  overridden by `STALEPROOF_HOOK`. A light `dist/hook.js` entry starts in a quarter of a second.
- **`staleproof init`** writes `.staleproof.toml`, the workflow (pull request check plus a weekly audit), the README
  badge, the pre-commit, lefthook or husky hook and `.gitignore` lines; `--claude`/`--cursor` add the agent hooks;
  `--yes`, `--dry-run`, `--skip`; a second run changes nothing.
- **pre-commit** ([docs/pre-commit.md](docs/pre-commit.md)): hook `staleproof` runs `lint --new --staged` on commit,
  `staleproof-predicted` runs on pre-push.
- **Local parse cache** in `.staleproof/cache/` (by file content; `--no-cache`, `STALEPROOF_CACHE`,
  `STALEPROOF_CACHE_DIR`), and lint skips the git history and Go parsing when no enabled rule needs them. The Action's
  new `cache` input keeps the graph dump and the parse cache between runs with actions/cache.

## 0.4.0 — 2026-10-17

Every repository, every teammate, every agent.

- **`staleproof lint`**: every path, link, anchor and code example in the docs, READMEs and the files AI coding agents
  read on every session (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/**`, Cursor, Copilot, Windsurf and Cline
  rules, `CONVENTIONS.md`) checked against the repository itself, with no graph and no network. Rules `path-missing`
  (with where the file moved or the commit that deleted it), `line-out-of-range`, `link-broken`, `anchor-missing`,
  and the static example checks as `example-*` findings. Output as text, JSON (`version: 1`), SARIF 2.1.0, GitHub
  workflow annotations or Markdown; `--fail-on`, `--rule`, `--disable`, `--files`, `--with`. Agent instruction files
  are listed first. Precision guards: in docs a missing path counts only with git-history evidence; slugs, MIME
  types, placeholders, globs, ignored and generated paths, translations, docs-site routes and generated API folders
  are never reported. On eight public repositories every finding was real drift ([docs/lint.md](docs/lint.md)).
- **Findings model**: one `Finding` shape (rule, severity, message, exact span, surface, subject, evidence, fix,
  line-independent fingerprint) that the next surfaces (hooks, editor, PR checks, the GitHub App) share; the rule
  registry generates [docs/rules.md](docs/rules.md).
- **`.staleproof.toml`**: new `[lint]` (`include`, `exclude`, `agent-files`) and `[rules]` tables, plus `[hooks]`,
  `[app]` and `[audit]` read ahead of the features that use them. Unknown keys warn instead of being silently
  dropped; `<!-- staleproof: ignore [rules] -->` and `ignore-file` comments silence findings.

## 0.3.0 — 2026-10-17

Docs drift found without a pull request, before a pull request, and in more languages.

- **Static API checks of docs examples.** At index time every call in a docs example is checked against the code it
  reaches, across repositories: unknown keyword arguments, too many positional arguments, missing required arguments,
  imported names and attributes that no longer exist. Findings are `MISMATCH` edges with the doc line. Only exact
  resolutions are judged; decorators outside an allow-list, external or metaclass bases, `__getattr__`, splats and
  signatures written as calls are left alone. On FalkorDB's docs this finds `client.create_constraint` (no such method:
  the runs fail with `AttributeError`) and `VectorStore(index_name=..., similarity_function=...)` (parameters the
  constructor no longer has); on Flask's, `UserList.as_view()` without its required `name`.
- **Predicted breaks.** A pull request check lists the impacted examples whose calls the code after the pull request
  no longer accepts (removed or renamed names, stopped exports, signatures that reject the call), before anything
  runs: in the impact tool, the terminal, the PR comment, the web UI and the hosted site. Graph mode runs those
  examples first. The comment ends with a machine-readable counts line; the Action gains `fail-on: predicted` and a
  `predicted` output.
- **Docs audit** (`staleproof audit`, `#/audit` on the site, `GET`/`POST /api/audit`, MCP `audit_docs`): a 0–100
  health score, every example line that no longer fits the code, API coverage over what the packages export (with
  the undocumented API ranked by use), and example runs at the indexed commits (`--run`). A README badge at
  `/api/badge/<owner>/<repo>.svg`.
- **Before a pull request.** `staleproof docs-for <symbol>` (MCP `docs_for_symbol`, `GET /api/docs-for`) lists the
  docs that depend on a function before it changes. `staleproof check` with no pull request checks the working tree
  (uncommitted and unpushed changes) statically and writes nothing; `--fail-on-predicted` makes it a pre-push hook.
  MCP `check_changes` takes edited file contents (hosted) or a checkout (local), for coding agents.
- **Example directives and repository config.** `<!-- staleproof: skip -->` / `expect-error` (also MDX comments, fence
  words, RST comments, and the markers pytest-codeblocks and Sybil use) keep an example from being run or judged;
  `.staleproof.toml` or `[tool.staleproof]` sets `ignore` and `skip-examples` globs.
- **GitHub Action.** `mode: audit` (the default on schedule and workflow_dispatch) writes the audit to the job summary
  and keeps one issue up to date (opened when something needs fixing, closed when all clear), with `fail-on:
  mismatches`, `fail-under`, `audit-runs` and `score`/`mismatched` outputs. `open-docs-pr` opens the agent's proposed
  edits as a pull request into the checked pull request's branch (`staleproof patch --open-pr --in-repo`). Open pull
  requests whose head moved since they were last checked are read again (CLI, HTTP, MCP).
- **reStructuredText (Sphinx) docs**: section titles, `code-block`/`testcode`/`doctest` directives, `::` literal
  blocks, `>>>` doctests, API roles (`:meth:`, `:class:` …) as mentions, `:doc:`/`:ref:` links.
- **TypeScript and JavaScript**: npm packages (monorepos too) indexed as `js-<name>` modules with their entry's
  re-exports, classes, functions, methods, imports and calls; JS/TS docs examples and `examples/*.js` linked;
  removed, renamed and unexported names checked and predicted (no argument-count checks: JavaScript accepts any).
- The install page writes an optional weekly-audit workflow, rules for coding agents (AGENTS.md) and a pre-push hook.

## 0.2.0

- Self-serve: the hosted site checks any public repository's pull requests (indexed on first use), MCP over HTTP at
  `/api/mcp`, a one-click install page, the zero-config Action `rajkaria/staleproof@v1`, and a CLI that starts a
  local FalkorDB and indexes on first use.
- Renamed from Lockstep to **Staleproof**. The npm package is `staleproof` (was `lockstep-docs`, now deprecated), the
  CLI is `staleproof`, the MCP server is `staleproof`, the repository is `rajkaria/staleproof` (the old URL redirects)
  and the site is https://staleproof.dev. Environment variables are `STALEPROOF_*`; the former `LOCKSTEP_*` names are
  still read when the new ones are unset, an existing `~/.lockstep` home is still used, virtualenvs marked
  `.lockstep-ok` are reused, and the GitHub Action updates comments it posted under the old marker.
- Website: a new home page that leads with results (the falkordb-py#262 worked example and the grep baseline from
  FACTS.md), use cases, integrations and FAQ; the live demo folds failed or unfinished checks away; the home page is
  prerendered into `index.html` for readers without JavaScript.
- Documentation: twenty pages under `docs/` (quickstart, use cases, CLI, GitHub Action, MCP, HTTP API, library,
  concepts, indexing, example runner, memory, agent, tools, configuration, deploy, troubleshooting), rendered on the
  site at `#/docs/<page>` with search, an outline and "Copy as Markdown".
- For LLMs: `/llms.txt`, `/llms-full.txt` and `/docs/<page>.md` on the site (and from `staleproof serve`), a
  generated `llms.txt` in the repository, `robots.txt` and `sitemap.xml`. `docs/tools.md` parameters and the
  repository `llms.txt` are generated by `npm run docs` and checked by tests, like the Cypher reference.

## 0.1.0 — unreleased

First version.

- Index public GitHub repositories (Python code, Markdown/MDX docs, example scripts) into one FalkorDB graph per
  organisation, with call edges resolved across repositories through imports, re-exports, attribute and return types.
- Pull requests become symbol-level changes (removed, renamed, signature, modified, added, export-removed).
- Agent tools over the graph: impact, clearance, read_section, run_example, decisions_for, rank_sections,
  propose_edit, record_verdict (+ write_decision, docs_patch for humans and MCP clients).
- Sandboxed example runner: repositories installed from source at the commits before and after a PR, scratch
  FalkorDB, no network; runs remembered on the graph.
- Agent loop (Claude, tool use) with a stored trace per check and a stop condition: every impacted section gets a
  verdict or an edit. Graph mode runs the same tools without a model.
- Decisions with GOVERNS/SUPERSEDES; verdict memory with maintainer accept/reject; docs patch as a git-apply-able diff
  and an optional PR in your fork.
- CLI, MCP server, web demo with live trace, GitHub Action, Docker/compose deploy kit, FACTS.md generated from the graph.
