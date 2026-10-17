---
name: staleproof
description: Keep docs and AI agent files (README, docs/, AGENTS.md, CLAUDE.md, Cursor and Copilot rules) true to the code. Use when changing public functions or classes, CLI commands or flags, package scripts, environment variables or file layout, or anything an agent file describes; and when a Staleproof hook reports docs an edit made wrong.
---

# Keep the docs true to the code

Docs and agent instruction files describe the repository: the paths in it, the commands that run it, the
functions it exports and how to call them. When the code changes and they do not, the next reader (or the
next agent session) follows instructions that no longer work. Staleproof finds those places; this skill is
how to act on them.

## When you change code

Update the docs and agent files in the same change, not later, whenever you:

- rename, move or delete a file or folder that a doc or `AGENTS.md`/`CLAUDE.md` names;
- change the parameters of a public function, method or class constructor that docs or examples call;
- rename or remove a CLI command or flag, a `package.json` script, a Makefile target;
- add, rename or stop reading an environment variable;
- change how the project is built, tested or run.

Before you change a public symbol, see which docs depend on it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs" docs-for "Client.query"
```

That needs a Staleproof graph of the repository. Without one, search the docs for the name instead:
`git grep -nw query -- '*.md' '*.mdx' '*.rst'`.

## When a Staleproof hook reports something

After an edit, the hook lists docs the edit made wrong, as `path:line message [rule]`, sometimes with a
verified fix. Before stopping, it lists every reference this session made wrong. For each item:

1. Open the doc at that line and read the claim in context.
2. If the code change was intended, update the doc to match the code (apply the listed fix when there is one).
   If the doc was right and the code is wrong, fix the code.
3. If the reference should stay as it is (it describes another version, or another project's layout), say so
   in your reply, and silence that one line with `<!-- staleproof: ignore rule-id -->` on the line before it.

Never delete a doc or an example only to make a finding go away.

## Check by hand

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs" lint --new        # what your uncommitted changes made wrong
node "${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs" lint              # every stale reference in the repository
node "${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs" lint --format json # with fixes, for applying them one by one
```

`lint` reads only the local checkout: paths, links and anchors, `npm run`/`make` commands, CLI commands and
flags, and the code examples in the docs. Nothing is sent anywhere. The rules are listed at
https://staleproof.dev/#/docs/rules.
