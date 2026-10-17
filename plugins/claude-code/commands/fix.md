---
description: Fix the docs and agent files that no longer match the code
argument-hint: "[paths...]"
---

Fix the stale references Staleproof finds in this repository's docs, READMEs and agent files.

1. Run, from the repository root:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs" lint --new --format json --fail-on never
   ```

   If arguments were given ("$ARGUMENTS"), add `--files $ARGUMENTS` to fix only those files. If `--new` finds
   nothing, run it again without `--new` to see the references that were already stale.

2. For each finding: when it has a `fix` with `"verified": true`, apply its `edits` exactly. Otherwise open the
   doc at `path:line`, read `message` and `evidence`, and change the doc to match the code. If the doc is right
   and the code is wrong, say so instead of editing the doc. If a reference must stay (it describes another
   version or project), add `<!-- staleproof: ignore <rule> -->` on the line before it and say why.

3. Run the same `lint` command again and repeat until it reports nothing you can fix. Summarize what you
   changed, file by file.
