#!/usr/bin/env bash
# Index FalkorDB's three repositories and run a graph-mode check of each
# preloaded pull request (examples executed before and after each PR), so the
# demo opens with real results. Idempotent; safe to re-run.
#   FALKORDB_URL=... scripts/seed.sh          (uses `lockstep-docs` from PATH, else the local build)
set -euo pipefail
cli=(lockstep-docs)
command -v lockstep-docs >/dev/null 2>&1 || cli=(node "$(dirname "$0")/../dist/cli.js")
"${cli[@]}" index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
IFS=',' read -r -a prs <<< "${LOCKSTEP_PRELOADED:-https://github.com/FalkorDB/falkordb-py/pull/262,https://github.com/FalkorDB/falkordb-py/pull/267,https://github.com/FalkorDB/falkordb-py/pull/276}"
for pr in "${prs[@]}"; do
  "${cli[@]}" check "$pr" --no-agent --runs 3
done
"${cli[@]}" facts --out "${FACTS_OUT:-docs/FACTS.md}"
