# Staleproof for VS Code, Cursor and Windsurf

Staleproof checks what your docs say about your repository against the repository itself, while you
type. A README that runs `npm run lint:docs` after the script was renamed, an `AGENTS.md` that sends
your coding agent to a file that moved, a link to a heading that no longer exists, a docs example that
passes a keyword the function lost, a docstring that documents a parameter the signature dropped: each
shows up on the exact text, with the reason and where Staleproof looked.

It reads the files on disk, your unsaved edits, git and a local parse cache. No account, no graph
database, and nothing leaves your machine.

## What you get

- **Diagnostics** in docs pages, READMEs, AI agent files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`,
  Copilot, Windsurf and Cline rules) and docstrings in Python, TypeScript and JavaScript, 300 ms after
  you stop typing, from the unsaved text. Every rule is listed at
  [staleproof.dev/#/docs/rules](https://staleproof.dev/#/docs/rules).
- **Quick fixes**: the fix Staleproof verified (the finding is gone after the edit and nothing new
  appears), and "Ignore this rule here", which writes the suppression comment `staleproof lint`
  honours. Both are offered only when they work on the text as it is in the editor.
- **Hover** on a code span in the docs (`Client.query`) or a call in a docs example shows the signature
  and where it is defined; **Go to Definition** jumps there.
- **Hover** on a function or class in the code shows "Documented in N places" with links; **Find All
  References** adds the docs lines; a code lens reads "N docs reference this".
- **Staleproof: Fix all in file** applies every verified fix in the current file.
- **Staleproof: Audit workspace** checks every docs page and lists the findings in the Problems panel.

The workspace's `.staleproof.toml` applies (rules turned off or raised, excluded paths, extra agent
files), as for `staleproof lint`. Edits to code reach the docs findings of other files when you save.

## Requirements

Node.js 20 or later. The extension starts `staleproof lsp` from, in order:

1. the `staleproof.path` setting, if you set it;
2. the workspace's own install, `node_modules/.bin/staleproof` (`npm i -D staleproof`);
3. a `staleproof` on your `PATH` (`npm i -g staleproof`);
4. `npx -y staleproof@<the version this extension was built for>` (downloaded once).

An install older than the first release with `staleproof lsp` is passed over.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `staleproof.enable` | `true` | Run the checks. |
| `staleproof.codeLens` | `true` | Show "N docs reference this" above functions and classes. |
| `staleproof.path` | empty | The `staleproof` executable to run (`~` and `${workspaceFolder}` are expanded). |
| `staleproof.trace.server` | `off` | Log the language server messages in Output: Staleproof. |

## Cursor and Windsurf

Install the same extension from Open VSX, or the `.vsix` with "Extensions: Install from VSIX...". It
uses only the standard language client, so every feature works the same.

## Other editors

`staleproof lsp` is a standard language server on stdio. Neovim, Zed, Helix and JetBrains IDEs:
[staleproof.dev/#/docs/editors](https://staleproof.dev/#/docs/editors).

## Troubleshooting

Run **Staleproof: Show output**: the first line says which `staleproof` started. If none did, add it
to the project (`npm i -D staleproof`) or set `staleproof.path`. **Staleproof: Restart server** picks
up a new install.
