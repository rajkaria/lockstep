---
description: List the docs that depend on a symbol, before you change it
argument-hint: "<symbol>"
---

Find every doc section and example that depends on `$ARGUMENTS`, so they can be updated with the change.

1. Run, from the repository root:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs" docs-for "$ARGUMENTS"
   ```

   It reads a Staleproof graph (docs linked to code through calls and imports, across repositories) and prints
   each section with the path that links it to the symbol.

2. If it reports that no FalkorDB is running or the repository is not indexed, search the docs instead:

   ```bash
   git grep -nw "<the symbol's last name>" -- '*.md' '*.mdx' '*.rst' 'AGENTS.md' 'CLAUDE.md'
   ```

3. List the docs that will need updating if the symbol's signature or behavior changes, with file and line.
