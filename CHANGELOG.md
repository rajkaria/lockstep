# Changelog

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
