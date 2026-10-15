# Architecture

```
src/
  cli.ts                 index | check | run | decide | verdict | patch | mcp | serve | facts | db
  config.ts              environment → Config
  graph/client.ts        FalkorDB connection; one graph per org; every query can be traced
  graph/queries.ts       every Cypher statement, named (README and GRAPH-MODEL.md are generated from it)
  indexer/               git checkout, tree-sitter Python extractor, org-wide symbol table and call resolver,
                         Markdown/MDX scanner, docs linking (MENTIONS/USES/LINKS_TO), DEPENDS_ON
  pr/                    GitHub PR metadata, symbol-level diff between the PR's commits, ingestion,
                         opening the docs PR in a fork
  tools/                 the agent tools; each returns {summary, data, queries}
  runner/                sandbox (uv venv per repo@sha, socket shim → scratch FalkorDB), fragment stitching,
                         skip rules, Run nodes
  agent/                 ModelClient (Anthropic, scripted), the loop, graph mode, trace events
  mcp/server.ts          stdio MCP server over the tools
  server/app.ts          HTTP API (+ SSE) and static web UI
  patch.ts               verdicts → unified diff + PR description with evidence
  facts.ts               FACTS.md from the graph
web/                     Vite + React demo (paste a PR, live trace, evidence paths, runs, verdicts, decisions)
python/sitecustomize.py  the sandbox shim
scripts/                 falkordb-local.sh (FalkorDB without Docker), seed.sh, gen-docs.ts
action/action.yml        composite GitHub Action
```

## A check, end to end

1. `ingestPullRequest`: PR metadata from GitHub → commits before/after → `diffRange` parses both versions of each
   changed Python file and compares definitions → `PullRequest` + `CHANGED_IN`; removed symbols recreated and
   late-linked to docs through the identifiers stored on each section.
2. `runAgentCheck` creates a `Check` node and gives the model the system prompt, the PR URL and a "since your last
   check" summary from the graph. Each turn streams; tool inputs are validated (zod) before running; tool errors go
   back to the model as error results.
3. Tools read and write the graph through a traced view, so every Cypher statement and its server time lands in the
   trace. `run_example` builds (or reuses) a virtualenv per set of repo@sha, flushes the scratch FalkorDB, and runs the
   example with the shim; identical runs are answered from `Run` nodes.
4. When the model stops, the loop checks that every impacted section has a verdict from this check; if not it sends
   up to two reminders, then records the check as incomplete. The trace is stored on the `Check` node, linked to the
   PR and the verdicts it produced.
5. `buildDocsPatch` applies the latest stale verdicts to each file at the indexed commit (refusing sections whose text
   changed since) and renders a unified diff and a PR description with the evidence per section.

## Decisions worth knowing

- One graph per organisation (graph name = org slug): FalkorDB's multi-graph is the tenancy boundary.
- Nothing is deleted on re-index: symbols and sections are marked `gone`, so decisions and verdicts never dangle.
- By-name resolution is allowed only inside repositories the module imports, never for generic names, and is
  narrowed by what the same docs page uses exactly; every by-name edge is labelled.
- The agent never edits without a path: `propose_edit` checks the graph before writing a verdict.
- Agent mode fails loudly without credentials; graph mode is a separate, labelled mode, not a silent fallback.
