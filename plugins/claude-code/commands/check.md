---
description: Check the docs and agent files against the uncommitted changes, plus the docs examples they are predicted to break
argument-hint: "[base ref]"
---

Check what the working tree's changes make wrong in the docs, READMEs and agent files of this repository.

1. Run, from the repository root:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs" lint --new --format markdown
   ```

   If an argument was given ("$ARGUMENTS"), add `--base $ARGUMENTS` to compare with that commit instead.

2. For docs examples the changes are predicted to break, here and in other repositories, run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs" check --no-index
   ```

   It needs a Staleproof graph that already has this repository. If it says no FalkorDB is running, or that the
   repository is not indexed, skip this step and say so in one line (`staleproof index owner/name` builds one).

3. Report what was found, grouped by file, agent files first, each with its line and what to change. Do not
   edit anything unless asked; suggest `/staleproof:fix` when there are findings.
