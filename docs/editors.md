# Editors (LSP)

`staleproof lsp` is a language server: it shows what [`staleproof lint`](lint.md) finds while you edit, on
the exact text, in VS Code, Cursor, Windsurf, Neovim, Zed, Helix, JetBrains IDEs and any other editor
that speaks the Language Server Protocol. A README that names a renamed script, an `AGENTS.md` that
points at a moved file, a link to a heading that is gone or a docstring that documents a parameter the
signature dropped is marked 300 ms after you stop typing, from the unsaved text, with a verified fix when
there is one. It reads the files, git and the local parse cache: no graph, no account, no network.

## What it does

| Feature | Where | What you see |
|---|---|---|
| Diagnostics | Docs pages, READMEs, AI agent files, docstrings | Every [lint rule](rules.md), on the exact span, with where Staleproof looked. Open files are checked from their unsaved text 300 ms after the last keystroke. |
| Quick fix | On a diagnostic | The [verified fix](rules.md) (the finding is gone after the edit and nothing new appears), re-checked against your unsaved text before it is offered. |
| Ignore this rule here | On a diagnostic | Writes the suppression comment lint honours: `<!-- staleproof: ignore <rule> -->` at the end of a Markdown line (on the line before a heading), `{/* … */}` in MDX, `.. staleproof: ignore` in reStructuredText, `# staleproof: ignore[<rule>]` or `//` on a function's line for its docstring, and `<!-- staleproof: skip -->` before a docs example. Offered only when the comment silences that finding. |
| Fix all in file | Command, or `source.fixAll` on save | Every verified fix in the file, applied as one edit. |
| Hover, Go to Definition | A code span in the docs (`Client.query`), a call in a docs example | The signature, the module and the file and line it is defined at; Go to Definition jumps there. |
| Hover, Find All References, code lens | A function or class in the code | "Documented in N places" with links; the docs lines in the references list; "N docs reference this" above the definition. |
| Audit workspace | Command | Every docs page checked; every finding in the Problems list, not only open files'. |

The workspace's [`.staleproof.toml`](configuration.md) applies: rules turned off or raised, excluded
paths, extra agent files. An unsaved edit to `package.json`, a `Makefile` or `pyproject.toml` re-checks the
open docs pages at once (a renamed script shows up in the README before you save). An edit to code
reaches other files' findings when you save it, when Staleproof lints the workspace again in the
background.

## Install the server

The editor runs `staleproof lsp`. Any of these provides it (Node.js 20 or later):

```bash
npm i -D staleproof        # in the project: node_modules/.bin/staleproof
npm i -g staleproof        # on your PATH
npx -y staleproof lsp      # no install; downloads it once
```

The VS Code extension finds it by itself (below). Other editors take the command in their config: use
`staleproof lsp` with a global or project install on the PATH, else `npx -y staleproof lsp`.

## VS Code, Cursor and Windsurf

Install **Staleproof** from the Visual Studio Marketplace (VS Code) or Open VSX (Cursor, Windsurf, VSCodium),
or a `.vsix` with **Extensions: Install from VSIX...**. It starts the server from, in order: the
`staleproof.path` setting, the workspace's `node_modules/.bin/staleproof`, a `staleproof` on the PATH, and
`npx -y staleproof@<the version the extension was built for>`. An install too old to have `lsp` is passed
over.

| Setting | Default | What it does |
|---|---|---|
| `staleproof.enable` | `true` | Run the checks. |
| `staleproof.codeLens` | `true` | "N docs reference this" above functions and classes. |
| `staleproof.path` | empty | The `staleproof` executable (`~` and `${workspaceFolder}` are expanded). |
| `staleproof.trace.server` | `off` | Log the protocol messages in **Output: Staleproof**. |

Commands: **Staleproof: Fix all in file**, **Staleproof: Audit workspace**, **Staleproof: Restart
server**, **Staleproof: Show output**. To fix on save, add `"source.fixAll.staleproof": "explicit"` to
`editor.codeActionsOnSave`.

A team can recommend it in `.vscode/extensions.json`:

```json
{ "recommendations": ["staleproof.staleproof"] }
```

## Neovim

Neovim 0.11 or later, with or without nvim-lspconfig. In `init.lua`:

```lua
vim.lsp.config('staleproof', {
  cmd = { 'staleproof', 'lsp' }, -- or { 'npx', '-y', 'staleproof', 'lsp' }
  filetypes = { 'markdown', 'mdx', 'rst', 'python', 'typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'go' },
  root_markers = { '.staleproof.toml', '.git' },
  settings = { staleproof = { codeLens = true } },
})
vim.lsp.enable('staleproof')
```

nvim-lspconfig users can put the same table, returned, in `lsp/staleproof.lua` on the runtime path (for
example `~/.config/nvim/lsp/staleproof.lua`) and keep only `vim.lsp.enable('staleproof')` in `init.lua`.
Quick fixes are `vim.lsp.buf.code_action()`, hover `K`, definitions and references the usual mappings.
Code lenses are shown after a refresh and run with `vim.lsp.codelens.run()`:

```lua
vim.api.nvim_create_autocmd({ 'BufEnter', 'InsertLeave' }, {
  callback = function(args) vim.lsp.codelens.refresh({ bufnr = args.buf }) end,
})
```

Fix all in file: `:lua vim.lsp.buf.code_action({ context = { only = { 'source.fixAll' } }, apply = true })`.

## Zed

Zed adds language servers through extensions. The repository has one in `editors/zed`: install Rust with
rustup, run **zed: install dev extension** and pick that folder. It starts a `staleproof` on the PATH, else
`npx -y staleproof@<version>`, for Markdown, Python, TypeScript, TSX, JavaScript and Go. Zed runs it next
to the other servers of those languages; to order them, list it in `languages` in `settings.json`:

```json
{
  "languages": {
    "Markdown": { "language_servers": ["staleproof", "..."] }
  }
}
```

## Helix

In `~/.config/helix/languages.toml` (or a project's `.helix/languages.toml`). A language's
`language-servers` list replaces the built-in one, so keep the servers you use:

```toml
[language-server.staleproof]
command = "staleproof"   # or "npx" with args = ["-y", "staleproof", "lsp"]
args = ["lsp"]

[[language]]
name = "markdown"
language-servers = ["marksman", "staleproof"]

[[language]]
name = "python"
language-servers = ["ruff", "pylsp", "staleproof"]

[[language]]
name = "typescript"
language-servers = ["typescript-language-server", "staleproof"]
```

Helix shows diagnostics, code actions (`space a`), hover and go to definition; it has no code lenses.

## JetBrains IDEs (LSP4IJ)

Install the **LSP4IJ** plugin (IntelliJ IDEA 2024.2 or later, and the other IDEs of the same versions).
Then **Settings | Languages & Frameworks | Language Servers**, **+**:

- **Server** tab: name `Staleproof`, command `staleproof lsp` (`npx -y staleproof lsp` without an install;
  on Windows `cmd /c staleproof lsp`).
- **Mappings** tab, **File name patterns**: `*.md`, `*.mdx`, `*.rst`, `*.mdc`, `*.py`, `*.ts`, `*.tsx`,
  `*.js`, `*.jsx`, `*.go`.
- **Configuration** tab (optional): `{ "staleproof": { "codeLens": true } }`.

The LSP console in the **Language Servers** tool window shows the server's log.

## Any other editor

Run `staleproof lsp` (stdin and stdout; `--stdio` is accepted and ignored). The server reads its settings
from `initializationOptions.settings` and from the `staleproof` configuration section (`enable`,
`codeLens`), and answers `workspace/executeCommand` for:

| Command | Arguments | Does |
|---|---|---|
| `staleproof.fixAll` | the document URI | Applies every verified fix in the file through `workspace/applyEdit`; returns `{ applied, fixes }`. |
| `staleproof.audit` | none | Lints the workspace, publishes every file's findings, returns `{ errors, warnings, infos, files, message }`. |
| `staleproof.openReferences` | a list of locations | Opens one (asking which when there are several): what the code lens runs. |

A client that implements its own references view can declare `initializationOptions.clientCommands:
["staleproof.showReferences"]`; code lenses then carry `staleproof.showReferences(uri, position,
locations)` for the client to run, as the VS Code extension does. Code action kinds: `quickfix` and
`source.fixAll.staleproof`.

## Speed

The server lints the workspace once when it starts (as `staleproof lint` does, warm from the parse cache
in `.staleproof/cache`), then re-checks only the file you edit. On Staleproof's own repository (33 docs
pages, about 370 files), warm, over 25 edits: a docs page is re-checked in 17 to 37 ms at the median and
under 115 ms at the 95th percentile, a docstring edit in 20 to 26 ms and under 75 ms. With the 300 ms
pause after the last keystroke, the diagnostics arrive under 450 ms after the edit at the 95th
percentile. Rules that read the whole repository (`env-unused`) run after the fast pass, only when the
variables a page documents change.
Re-linting after a save and verifying fixes wait for a pause in typing.

## Privacy

The server reads the workspace's files, runs `git` in it (file list, ignore rules, history for moved
files) and keeps its parse cache under `.staleproof/cache`. It sends nothing over the network and needs
no FalkorDB. Through npx, npm downloads the package once.

## Troubleshooting

- **No diagnostics.** Check the server started: VS Code **Staleproof: Show output**; Neovim `:checkhealth
  vim.lsp`; Helix `hx --health markdown`. Run `npx -y staleproof lint` in the workspace: the editor shows
  the same findings.
- **A finding you disagree with.** Use **Ignore this rule here**, or turn the rule off in
  [`.staleproof.toml`](configuration.md).
- **`lsp` is not a command.** The `staleproof` found is older than the language server: update it
  (`npm i -D staleproof@latest`).

## Related

- [Lint docs and agent files](lint.md)
- [Lint rules](rules.md)
- [Configuration](configuration.md)
- [Claude Code plugin](claude-code.md)
- [CLI](cli.md#lsp)
