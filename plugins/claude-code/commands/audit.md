---
description: Audit the whole repository's docs and agent files for stale references, with a health summary
---

Audit every doc, README and agent instruction file in this repository, not only what the current changes touch.

1. Run, from the repository root:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs" lint --format markdown --fail-on never
   ```

2. For the graph audit (a 0-100 docs health score, example runs and API coverage), run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs" audit <owner/name> --format markdown`, with the repository's
   GitHub name. It indexes the repository into a local FalkorDB first, which takes a minute; ask before running it.

3. Summarize: how many references are stale, in which files, agent files first, and the three fixes that matter
   most. Offer `/staleproof:fix`.
