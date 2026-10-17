# Claude Code plugin

The Staleproof plugin for Claude Code tells Claude which docs and agent files its edits make wrong, while it is still working: after each edit it adds the stale references to Claude's context (the README example that still passes a renamed parameter, the `AGENTS.md` line naming a file that moved), and before Claude stops it asks it to fix them, once. It reads only the local checkout and git; nothing leaves the machine. This page covers installing it, what each hook does and prints, the skill and the slash commands, configuration, the same hooks without the plugin (Claude Code settings, Cursor), how it works, and troubleshooting.

## Install

In Claude Code:

```text
/plugin marketplace add rajkaria/staleproof
/plugin install staleproof@staleproof
```

On Claude Code 2.1.275 or later this is one step: `/plugin install staleproof --marketplace rajkaria/staleproof`. From a shell, `claude plugin marketplace add rajkaria/staleproof` then `claude plugin install staleproof@staleproof`. To try it from a clone of this repository without installing: `claude --plugin-dir plugins/claude-code`.

The hooks need Node.js 20 or later and git on the `PATH`. They run the Staleproof the project already has (`node_modules/staleproof`, in the project or a folder above it), else a global `staleproof`, else the release the plugin was made with through `npx -y staleproof@0.5.0` (downloaded once, then cached by npm). A Staleproof older than 0.5 has no hooks and is skipped.

| Part | Name | What it does |
|---|---|---|
| Hook | `SessionStart` | Lints once in the background, so the first edit's hook is fast, and remembers what was already stale |
| Hook | `PostToolUse` on `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | The docs this edit made wrong, added to Claude's context |
| Hook | `Stop` | The docs this session made wrong: Claude is asked to fix them before it stops |
| Skill | `staleproof` | When and how to keep docs and agent files in step with code changes |
| Command | `/staleproof:check [base]` | What the uncommitted changes make wrong, plus docs examples predicted to break |
| Command | `/staleproof:fix [paths...]` | Fix the stale references, applying verified fixes first |
| Command | `/staleproof:audit` | Every stale reference in the repository, with a summary |
| Command | `/staleproof:docs-for <symbol>` | The docs that depend on a symbol, before you change it |
| MCP server | `staleproof` | The [MCP tools](mcp.md) over stdio, from the same CLI. They read a FalkorDB graph: without one configured, `staleproof mcp` starts a local one on first use ([CLI](cli.md#falkordb-on-first-use)). Turn the server off in `/mcp` to keep only the hooks, which never need it |

## After each edit

When Claude edits a file, the hook lints the working tree, compares it with `HEAD` by [fingerprint](lint.md#only-what-a-change-introduced), and keeps the new findings that concern this edit:

- findings in the edited file;
- findings about it: a path or link that names it, or a docs example calling code it defines;
- findings that appeared since the previous hook (a script renamed in `package.json` makes the untouched README's `npm run` line wrong);
- docs that name a function, method or class constructor whose signature the edit changed, when they pass a parameter that is gone (or any call, when a parameter is now required, or the symbol was removed). Calls in Python, JavaScript and TypeScript code blocks are left to the example checks, which judge each call.

Each finding is said once per session (the stop hook repeats what is left). With nothing to say, the hook prints nothing. Otherwise Claude reads, next to the tool result:

```text
Staleproof: this edit leaves docs out of date (checked against HEAD, nothing left the machine):
- README.md:8:8 `connect` has no parameter `timeout`. [example-unknown-keyword]
- docs/usage.md:3 still names `timeout` of `connect`; demo/client.py changed it to `def connect(host, deadline=10)`.
Update them in the same change, or say why they stay.
```

At most ten items are listed; more end with `and <n> more: run npx staleproof lint to see them all.` Verified fixes are listed after their finding (`Fix: …`).

## Before Claude stops

The stop hook lints the working tree against `HEAD` again and lists every new error-level finding the session introduced, the signature mentions above, and, when a FalkorDB is already running on this machine with the repository indexed, the docs examples in this or another repository that a static check predicts the changes break (it never starts a database and never indexes). If there are findings, Claude is asked to continue:

```json
{"decision": "block", "reason": "Staleproof: 1 doc reference this session made wrong (new since HEAD):\n- README.md:8:8 `connect` has no parameter `timeout`. [example-unknown-keyword]\n- docs/usage.md:3 still names `timeout` of `connect`; demo/client.py changed it to `def connect(host, deadline=10)`.\nUpdate the docs and agent files above in this change (apply the fixes listed), or explain why they stay as they are."}
```

It never blocks twice in a row: when Claude is already continuing because of a stop hook (`stop_hook_active`), whatever is left goes to you as a message instead. It also stays silent in a session that edited nothing, and about references that were already new since `HEAD` when the session started: those are not the session's doing. Mentions alone never block; they are shown to you.

## Configure

| Setting | Values | Effect |
|---|---|---|
| `[hooks] stop` in [`.staleproof.toml`](configuration.md#hooks) | `block` (default), `warn`, `off` | What the stop hook does with new findings: ask Claude to fix them, only tell you, or nothing |
| `STALEPROOF_HOOK` | `block`, `warn`, `off` | Wins over `[hooks] stop` for this shell; `off` also silences the edit hook |
| `STALEPROOF_CACHE` | `off` | Parse every file on every run instead of reading `.staleproof/cache/` |
| `STALEPROOF_CLI` | path to a `dist/cli.js` | Run that Staleproof (a checkout of it) instead of the one the plugin finds |

Rules, severities and excluded files come from the same config as [`staleproof lint`](lint.md#configure-and-silence), and `<!-- staleproof: ignore -->` comments silence a line for the hooks too. To turn the plugin off for a while: `/plugin disable staleproof@staleproof`.

## Without the plugin

`staleproof init --claude` writes the same three hooks into the project's `.claude/settings.json`, merged with what is there (other hooks and settings are kept; running it again adds nothing):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "npx -y staleproof@0.5.0 hook session-start", "async": true, "timeout": 120 }] }],
    "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "npx -y staleproof@0.5.0 hook post-edit", "timeout": 15 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "npx -y staleproof@0.5.0 hook stop", "timeout": 60 }] }]
  }
}
```

A project with Staleproof as a dependency gets `npx --no-install staleproof` instead. Use either the plugin or these hooks, not both.

### Cursor

`staleproof init --cursor` writes `.cursor/hooks.json` ([Cursor hooks](https://cursor.com/docs/agent/hooks), version 1): `postToolUse` on `Write` runs `staleproof hook post-edit --cursor` (its findings come back as `additional_context`), `stop` runs `staleproof hook stop --cursor` with `loop_limit: 1` (a `followup_message` when the session made docs wrong; never after a follow-up, `loop_count > 0`), and `sessionStart` warms the cache.

### Other agents

`staleproof hook <event>` reads the hook JSON on stdin and prints the answer on stdout, always exiting 0:

| Event | Reads | Prints |
|---|---|---|
| `session-start` | `cwd`, `session_id` | Nothing |
| `post-edit` | `cwd`, `session_id`, `tool_input.file_path` (or `notebook_path`, `tool_response.filePath`; Cursor: `file_path`, `workspace_roots`) | `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "…"}}`; with `--cursor`, `{"additional_context": "…"}` |
| `stop` | `cwd`, `session_id`, `stop_hook_active` (Cursor: `conversation_id`, `loop_count`) | `{"decision": "block", "reason": "…"}`, or `{"systemMessage": "…"}`; with `--cursor`, `{"followup_message": "…"}` |

`--no-graph` skips the predicted breaks in `stop`. See [CLI: `hook`](cli.md#hook).

## How it works

- **Graph-free.** The hooks run the same engine as [`staleproof lint`](lint.md): the working tree's docs, READMEs and agent files against its own files, scripts, CLI, environment variables and code.
- **Against `HEAD`.** The first hook after a commit lints that commit once, from a temporary copy of it read from the local clone's objects (never fetched), and keeps its fingerprints in `.staleproof/cache/`; every later hook compares with them.
- **The parse cache.** What the parsers read from each code file (and each docs example) is kept in `.staleproof/cache/`, keyed by the file's content, along with the deleted and renamed paths of the git history keyed by the refs. A warm hook re-parses only the files that changed. The folder ignores itself (`git status` stays clean), is safe to delete, and is written only on this machine. `staleproof init` adds `.staleproof/` to `.gitignore` as well.
- **Session state** (what each hook already said) sits next to the cache, one small file per session; old ones are pruned.
- **Never in the way.** A hook that errors or runs out of time (10 seconds for an edit, 50 before stopping) prints nothing and exits 0; the agent goes on.

The budget is 2 seconds for an edit hook with a warm cache. Most of it is the lint itself (the same work as a warm `staleproof lint`) and starting Node.js; repositories with tens of thousands of files take longer, and a hook that runs out of time says nothing.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Nothing ever shows up | Check the hook runs: `echo '{"cwd":"'$PWD'","tool_input":{"file_path":"'$PWD'/README.md"}}' \| npx -y staleproof hook post-edit` prints the context or nothing. `claude --debug` shows each hook's output. The hooks need a git checkout. |
| The first edit after a commit says nothing | The hook ran out of time linting the new `HEAD` (a large repository). The next edit uses the result; the session-start hook usually has it ready. |
| `hook error` in the transcript | An old global `staleproof` (before 0.5) answered. Upgrade it (`npm i -g staleproof`) or remove it; the plugin then uses npx. |
| Claude is asked about references it did not touch | They were made wrong by uncommitted changes from before the session, in a session whose start hook did not run. Commit or stash them, or set `[hooks] stop = "warn"`. |
| A reference is right as it is | Silence it with `<!-- staleproof: ignore rule-id -->` on the line before it, or turn the rule off in `[rules]`. |

## Related

- [Lint docs and agent files](lint.md): the engine the hooks run, every rule and how to silence one.
- [Pre-commit hooks](pre-commit.md): the same check on `git commit`, with pre-commit, lefthook or husky.
- [MCP server](mcp.md): the tools the plugin's MCP server serves.
- [Configuration](configuration.md#hooks): `[hooks]` and the environment variables.
