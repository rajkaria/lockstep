# Changelog

## 0.3.0 — unreleased

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
