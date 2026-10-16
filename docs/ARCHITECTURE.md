# Architecture

This page is for contributors: where each part of the code lives, what happens during a check from end to end, the design decisions worth knowing before changing anything, how the documentation is published from `docs/`, and how the test suite is organised.

## Source layout

```text
src/
  cli.ts                 index | check | run | decide | verdict | patch | mcp | serve | facts | db
  index.ts               the library's exports
  config.ts              environment → Config
  pkg.ts                 package root and version
  graph/client.ts        FalkorDB connection; one graph per org; every query can be traced
  graph/queries.ts       every Cypher statement, named (the README's Cypher section and GRAPH-MODEL.md are generated from it)
  graph/schema.ts        the exact-match indexes created before every index run
  indexer/               repo.ts (checkout, file classification, module names), files.ts, treesitter.ts and
                         python.ts (tree-sitter Python extractor), resolve.ts (org-wide symbol table and call
                         resolver), markdown.ts (Markdown/MDX scanner), docs.ts (MENTIONS/USES/LINKS_TO),
                         deps.ts (DEPENDS_ON), write.ts, index.ts (indexOrg)
  pr/                    github.ts (PR metadata), changes.ts (symbol-level diff between the PR's commits),
                         github-diff.ts (the same diff through the GitHub API when there is no git),
                         ingest.ts, open-pr.ts (the docs PR in a fork)
  tools/                 graph-tools.ts (impact, clearance, rank_sections, read_section), run-example.ts,
                         memory-tools.ts (decisions, verdicts, review, "since the last check"), types.ts
                         (ToolResult, Tracer, unknown-parameter check), index.ts (tool sets, JSON schemas)
  runner/                index.ts (runExample, Run nodes, one run at a time), prepare.ts (skip rules, fragment
                         stitching), sandbox.ts (venv per repo@sha set built with an allow-listed
                         environment, the sandboxed process), scratch.ts
                         (scratch FalkorDB start and flush)
  agent/                 loop.ts (runAgentCheck), prompt.ts, model.ts (ModelClient), anthropic.ts (Claude and
                         Anthropic-compatible providers), scripted.ts (ScriptedModel), graph-check.ts (graph mode),
                         trace.ts (trace events)
  mcp/server.ts          stdio MCP server over the tools, plus docs_patch
  server/app.ts          HTTP API (+ SSE), the static web UI and the docs as plain text
  patch.ts               verdicts → unified diff + PR description with evidence
  facts.ts               FACTS.md from the graph
  format/                text.ts (terminal output), markdown.ts (the PR comment)
web/
  index.html, vite.config.ts   Vite + React; the build also emits the docs as plain text (llms.ts)
  llms.ts                /llms.txt, /llms-full.txt, /docs/<slug>.md, robots.txt, sitemap.xml
  src/main.tsx, App.tsx  entry and routes (home, a stored check, the query catalogue, docs)
  src/route.ts           hash routes: #/, #/<home section>, #/check/<id>, #/model, #/docs/<slug>/<anchor>
  src/layout.tsx         header, footer, icons, code blocks
  src/Landing.tsx        the home page's content (also prerendered)
  src/TryIt.tsx          the live demo: paste a PR, watch the check stream in, recent checks
  src/CheckResults.tsx   a check's findings: changed symbols, sections, runs, verdicts; a stored check replayed
  src/components.tsx     evidence paths, Cypher lists, the trace, runs, diffs, the decision form
  src/state.ts           trace events → view (the same reducer live and replayed)
  src/api.ts             API client and the snapshot fallback
  src/Docs.tsx           the docs pages: navigation, table of contents, search
  src/docs/manifest.ts   the page list (file, slug, title, summary, group) and llms.txt builders
  src/docs/render.ts     Markdown → HTML with GitHub-style anchors and in-app links
  src/prerender.tsx      the home page as static HTML
  src/format.ts, types.ts, styles.css
  public/snapshot.json   what the API returned at one moment, for hosts without FalkorDB
python/sitecustomize.py  the sandbox shim (socket and DNS)
grammars/                tree-sitter-python.wasm
scripts/                 falkordb-local.sh (FalkorDB without Docker), seed.sh (index + graph-mode checks + facts),
                         gen-docs.ts (generated docs), snapshot.ts (web/public/snapshot.json),
                         prerender.ts (the home page into web/dist/index.html)
api/[...route].js        the Vercel Function wrapping server/app.ts
action/action.yml        composite GitHub Action
examples/staleproof.yml    workflow using the Action
test/                    vitest suite and the fixture organisation (test/fixtures/org)
```

## A check, end to end

1. `ingestPullRequest`: PR metadata from GitHub → commits before/after → `diffRange` parses both versions of each changed Python file and compares definitions → `PullRequest` + `CHANGED_IN`; removed symbols recreated and late-linked to docs through the identifiers stored on each section. Without `git`, the same diff is read through the GitHub API.
2. `runAgentCheck` creates a `Check` node and gives the model the system prompt, the PR URL and a "since the last check" summary from the graph. Each turn streams; tool inputs are checked for unknown parameters and validated (zod) before running; tool errors go back to the model as error results.
3. Tools read and write the graph through a traced view, so every Cypher statement and its server time lands in the trace. `run_example` builds (or reuses) a virtualenv per set of repo@sha, flushes the scratch FalkorDB, and runs the example with the shim; identical runs are answered from `Run` nodes.
4. After any `impact` call, the loop collects the section ids of every impact page itself. When the model stops, the loop checks that each of those sections has a verdict from this check; if not, it sends up to two reminders, then records the check as incomplete. The trace is stored on the `Check` node, linked to the PR and the verdicts it produced. Graph mode (`runGraphCheck`) runs impact, clearance, rank_sections and up to 3 example runs in that order instead, with no model and no verdicts.
5. `buildDocsPatch` applies the latest stale verdicts to each file at the indexed commit, read from the local clone or from raw.githubusercontent.com (refusing sections whose text changed since), and renders a unified diff and a PR description with the evidence per section.

The details: [The agent](agent.md), [Example runner](example-runner.md), [Decisions and memory](memory.md).

## Decisions worth knowing

- One graph per organisation (graph name = org slug): FalkorDB's multi-graph is the tenancy boundary.
- Nothing is deleted on re-index: symbols and sections are marked `gone`, so decisions and verdicts never dangle.
- By-name resolution is allowed only inside repositories the module imports, never for generic names, and is narrowed by what the same docs page uses exactly; every by-name edge is labelled.
- Every variable-length pattern binds a path variable and clearance counts bound paths, because an anonymous variable-length pattern missed callers on FalkorDB 4.18; [test/traversal.test.ts](../test/traversal.test.ts) keeps it that way.
- The agent never edits without a path: `propose_edit` checks the graph before writing a verdict.
- Unknown tool parameters are an error, in the agent loop and over MCP, so a model never gets the same answer to an argument that was silently dropped.
- Code from a pull request never sees the server's environment: the install step (which runs build code) gets an allow-list of paths, locale, proxies, certificates and `UV_*`/`PIP_*` settings; the example gets nothing inherited.
- Example runs are serialised in one process (the scratch server is flushed per run), and the server runs one check at a time.
- Agent mode fails loudly without credentials; graph mode is a separate, labelled mode, not a silent fallback.

## How the docs are published

The documentation is the Markdown in `docs/` plus the repository README. One list, `DOCS` in [web/src/docs/manifest.ts](../web/src/docs/manifest.ts), names every page (file, slug, title, one-sentence summary, group) and drives every place they are published:

| Output | Built by | Served at |
|---|---|---|
| Web docs pages | `web/src/Docs.tsx` loads `docs/<file>.md` and renders it with `web/src/docs/render.ts` (GitHub-style anchors; links to other pages become in-app routes, links to code go to GitHub) | `#/docs/<slug>` |
| `/llms.txt` | `llmsTxt()` in the manifest: a summary, quick facts, and one line per page | the site root |
| `/llms-full.txt` | `llmsFullTxt()`: every page in reading order, each under a header | the site root |
| `/docs/<slug>.md` | each page's Markdown as is | the site |
| `robots.txt`, `sitemap.xml` | `web/llms.ts` | the site root |
| `llms.txt` in the repository | `npm run docs`, linking to `docs/<file>` | GitHub |

`web/llms.ts` produces the plain-text files; the Vite build emits them into `web/dist`, the Vite dev server serves them, and `staleproof serve` serves them from the built web directory. On Vercel they are static files.

Some parts are generated from the code and never edited by hand. `npm run docs` ([scripts/gen-docs.ts](../scripts/gen-docs.ts)) rewrites the README's Cypher section, [docs/GRAPH-MODEL.md](GRAPH-MODEL.md), the parameter reference between the generated markers in [docs/tools.md](tools.md), and the repository `llms.txt`. `staleproof facts` writes [docs/FACTS.md](FACTS.md) from the graph. Tests keep them in sync: [test/docs.test.ts](../test/docs.test.ts) fails if the README's Cypher section or GRAPH-MODEL.md drift from `src/graph/queries.ts`, and [test/docs-site.test.ts](../test/docs-site.test.ts) fails if the tools reference or `llms.txt` drift, if a page in `docs/` is missing from the manifest (or the reverse), if a page lacks its single H1 and opening paragraph, or if any relative link or heading anchor in `docs/*.md` or the README is broken.

To add a page: write `docs/<file>.md` with one H1 and a summary paragraph, add an entry to `DOCS`, then run `npm run docs` and `npm run verify`.

## Testing

```bash
npm install
npm run verify      # typecheck (engine + web), then the whole vitest suite
```

The integration tests need a FalkorDB. Without `FALKORDB_TEST_URL`, the global setup ([test/global-setup.ts](../test/global-setup.ts)) starts the Docker-free local server on port 6380 with `scripts/falkordb-local.sh` and leaves it running for the next run. Test files run one at a time, against a fixture organisation of three small repositories (`test/fixtures/org`: a client, an SDK built on it, and a docs site). No test calls a paid model API, and GitHub API responses are faked.

| Area | Test files |
|---|---|
| Indexing | `python.test.ts` (extractor), `resolve.test.ts` (module names, symbol table, exact and by-name resolution), `markdown.test.ts` (scanner, identifiers, links), `index-code.test.ts`, `index-org.test.ts` (the whole organisation in FalkorDB) |
| Pull requests | `changes.test.ts` (change kinds, diff parsing, the GitHub API source) |
| Graph queries and tools | `tools.test.ts` (impact paging, clearance, ranking, read_section), `traversal.test.ts` (variable-length paths, bound path variables) |
| Example runner | `prepare.test.ts` (skip rules, stitching, outcomes, install conflicts, the install environment allow-list), `sandbox.test.ts` (the shim, timeout, no inherited secrets), `run-example.test.ts` (before/after runs in FalkorDB) |
| Memory and patch | `memory.test.ts` (decisions, supersession, edit guard, verdict history, the docs patch, opening the docs PR, "since the last check") |
| Agent | `agent.test.ts` (the loop with a scripted model, reminders, errors, time budget, unknown parameters, every impact page), `anthropic-model.test.ts` (the Claude and compatible request shapes against a local fake API) |
| Interfaces | `mcp.test.ts`, `server.test.ts` (HTTP API and SSE), `format.test.ts` (the PR comment), `action.test.ts` (the Action calls real commands and flags), `web-state.test.ts` (the web view reducer) |
| Package and facts | `package.test.ts` (shipped assets, the built UI and the plain-text docs served), `facts.test.ts` |
| Docs | `docs.test.ts` (generated sections, no internal material in tracked files), `docs-site.test.ts` (manifest, page shape, links and anchors, generated reference, llms.txt) |

## Related

- [Core concepts](concepts.md): the vocabulary the code uses
- [The agent](agent.md): the check loop in detail
- [Graph model and Cypher](GRAPH-MODEL.md): every query
- [Deploy](DEPLOY.md): running it on Vercel, Docker Compose or one machine
