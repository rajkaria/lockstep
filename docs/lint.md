# Lint docs and agent files

`staleproof lint` checks every claim your docs make about your repository against the repository itself: the
paths they name, the links and anchors they follow, the commands they run (scripts, make targets, the repository's
own CLI and its flags), and the code examples they show. It reads the files AI coding
agents follow on every session first: `AGENTS.md`, `CLAUDE.md`, Cursor, Copilot, Windsurf and Cline rules. It
needs no graph database, no network and no account, and it runs in about a second.

```bash
npx staleproof lint
```

```text
AI agent instructions

  AGENTS.md
    4:21  error    `src/settings.ts` does not exist in the repository.  [path-missing]
    5:26  error    `src/util/old.ts` does not exist; it moved to `src/helpers/old.ts`.  [path-missing]
    6:29  warning  `src/app.ts` has 4 lines; line 999 does not exist.  [line-out-of-range]

Docs

  docs/guide.md
    5:52  warning  This page has no heading `#configuration`.  [anchor-missing]
    7:70  error    `lib/removed.ts` does not exist; it was deleted in 3f2a9c1.  [path-missing]

4 errors, 2 warnings in 2 files (6 files checked, 111 ms).
```

## What it reads

| Files | Report section |
|---|---|
| `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md` (any folder), `.claude/**/*.md` (skills, commands, agents), `.cursorrules`, `.cursor/rules/**`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `.windsurfrules`, `.windsurf/rules/**`, `.clinerules`, `CONVENTIONS.md` | AI agent instructions |
| `README*`, `CONTRIBUTING*`, `DEVELOPMENT*`, `SETUP*`, `INSTALL*` | README and contributing guides |
| Every other Markdown, MDX and reStructuredText page the indexer reads as docs | Docs |
| Code blocks in those pages (Python, JavaScript, TypeScript, Go) | Code examples |
| Docstrings and JSDoc comments of the repository's Python packages and published npm packages | Docstrings |
| Env example files (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`, ...) and every code file's environment reads | Configuration |

Changelogs, codes of conduct, licences, issue templates, translations (`docs/zh/…`, `i18n/de/…`), test fixtures and
vendored folders are not checked. Add files with `[lint] include`, more agent files with `[lint] agent-files`.

## What it checks

| Rule | Severity | Reports |
|---|---|---|
| `path-missing` | error | A code span names a file or folder that does not exist, with where it moved or when it was deleted |
| `line-out-of-range` | warning | `path:line` or `path#L12` past the end of the file |
| `link-broken` | error | A relative link to a missing file (and the right link when the file is at the repository root) |
| `anchor-missing` | warning | `#anchor` with no heading of that slug in the target page |
| `command-missing` | error | A command the repository does not define: `npm run x`, `pnpm x`, `yarn x`, `make x`, `just x`, `task x`, `uv run x`, `python -m pkg.mod` ([below](#commands-and-the-repositorys-own-cli)) |
| `cli-command-unknown` | error | The repository's own CLI shown with a subcommand its definition lacks |
| `cli-flag-unknown` | error | The repository's own CLI shown with an option its definition lacks |
| `env-unused` | warning | A documented environment variable (an `.env.example` line, an env table, `export X=` in a shell block, a code span next to "environment variable") that no code reads ([below](#environment-variables-symbols-and-docstrings)) |
| `env-undocumented` | info | Product code reads a variable that the repository's `.env.example` does not list |
| `symbol-missing` | error | A code span `Client.query_v2`, `pkg.connect_async()` whose class or module is the repository's own and has no such member |
| `docstring-param-unknown` | error | A docstring (Google, NumPy, Sphinx; JSDoc/TSDoc) documents a parameter the signature does not have |
| `docstring-param-undocumented` | info | A docstring documents most parameters but leaves one out |
| `example-*` | error | A docs example that calls the code with an unknown keyword, too many or too few arguments, a missing import or attribute, or a removed symbol ([static example checks](audit.md)) |

The [rules reference](rules.md) lists every rule with an example.

## Precision first

A finding you have to dismiss costs more than one Staleproof misses, so every rule judges only what it can prove:

- **Agent instruction files describe this repository**, so a path they name that does not exist is reported.
  Ordinary docs often describe a reader's project or another repository (`create src/app.py`, Flask's
  `docs/views.rst`), so there a missing path is reported only when git history shows this repository had it: it was
  deleted or renamed. The message says which, and where it went.
- A path counts only when its first folder exists in the repository (or in history): `owner/repo`, `text/plain`,
  `feature/x` and `path/to/<file>` are never paths. URLs, absolute and home paths, globs and placeholders are skipped.
- Paths are tried from the repository root, the page's folder and every folder above it (skills and packages name
  files from their own folder). Paths git ignores, build outputs (`dist/`, `build/`, `.next/`, …) and paths the
  sentence says are created or generated are not reported.
- Links: a docs site that routes extensionless links itself (Docusaurus, MkDocs, Mintlify, VitePress, …) is left
  to route them; folders such a site generates (an API reference) are not required to exist; a root page included in
  the docs site (`CONTRIBUTING.md`) may link relative to the docs folder.
- Git history is read with one `git log` that never fetches file contents, so partial clones stay fast.

Measured on eight public repositories (openai/codex, vercel/ai, pydantic-ai, the MCP Python SDK, TypeScript, httpx,
Flask, falkordb-py): every reported finding was real drift, such as headings renamed under deep links, test files
moved under paths that `AGENTS.md` still names, or links to source files that a port renamed.

## Commands and the repository's own CLI

Commands are read from inline code spans and shell blocks (`bash`, `sh`, `console`, `zsh`, ...; unlabelled blocks
whose lines start with `$ `) the way a shell reads them: prompts and output lines, `VAR=value` prefixes, `sudo` and
`env`, `&&`/`||`/`;`/`|` chains, `\` continuations, comments and heredocs. A `cd` holds for the rest of the block,
and a finding points at the command itself, not at the whole line.

| Command | Checked against |
|---|---|
| `npm run x`, `npm test`/`start`/`stop`, `pnpm [run] x`, `yarn [run] x`, `bun run x` | `scripts` of the nearest `package.json` up from the page (or the `cd`), and the root's; `-w`/`--workspace`, `--filter`, `--prefix`, `-C`, `--dir`, `--cwd`, `yarn workspace x` pick the package |
| `make x`, `make -C dir x` | Targets of `Makefile`/`makefile`/`GNUmakefile`, files they `include`, `.PHONY` lists; pattern rules (`release-%`) match |
| `just x` | Recipes and aliases of the `justfile` (and its imports); `mod` names |
| `task x` | Tasks and aliases of `Taskfile.yml`, included Taskfiles as `namespace:task`, wildcard tasks |
| `uv run x`, `poetry run x`, `hatch run x`, `pdm run x` | `[project.scripts]`, `[tool.poetry.scripts]`, hatch environment scripts; `hatch run env:x` needs the environment |
| `python -m pkg.mod` | Modules of the repository's own Python packages (`pkg/mod.py`, `pkg/mod/__init__.py`; a package needs `__main__.py`) |

The repository's own CLI is the program a `package.json` `bin`, a `[project.scripts]` entry point or a package's
`__main__.py` runs, however the docs invoke it: by name, `npx`/`pnpm exec`/`bunx`, `uv run`/`uvx`, `python -m pkg`,
`node dist/cli.js` or `tsx src/cli.ts`. Its subcommands and options are read from the code that defines them,
without running it: commander (and the subcommands of `.strict()` yargs programs) in JavaScript and TypeScript,
click, typer and argparse in Python, across files (`addCommand(makeSync())`, `@cli.command()` in another module,
`app.add_typer(users, name="users")`). `--help`, `-h`, `--version` and `-V` are always known, as are a parent
command's options; values of options are skipped, `--x=value` and short flag clusters (`-qv`) are read, and
argparse's abbreviations (`--verb` for `--verbose`) are accepted.

What is never judged, because it cannot be proven wrong:

- A definition that is not fully static: computed command or option names, plugin hooks (`pm.hook.register_commands(cli=cli)`),
  custom group classes (`cls=DefaultGroup`), unknown-option passthrough (`allowUnknownOption()`,
  `ignore_unknown_options`, `parse_known_args`), decorators or helpers that may add options, executable subcommands,
  other frameworks (cac, oclif, Cobra, clap, ...). Only the part that is open is skipped.
- Names a dependency's binary or a file could have: `pnpm eslint`, `yarn run tsc`, `bun run index.ts`, `uv run pytest`.
  Through pnpm, yarn and bun only names with a colon (`build:docs`) and the usual script names (`build`, `lint`, `dev`,
  ...) are judged; through `uv run` and friends only a name close to one of the repository's own scripts (a rename).
- Placeholders (`npm run <script>`, `make TARGET`, `$CMD`), `--if-present`, package-manager built-ins, pinned
  versions (`npx tool@1.2.0`), log lines (`tool serve: listening`), and lines that say the command is history
  (removed, renamed, deprecated, a migration).
- Commands about another project: the page scaffolds or clones one (`npx create-next-app`, `git clone` of another
  repository), `cd`s into a folder this repository does not have, defines the script itself (a `package.json`
  snippet), shows a Taskfile, Makefile or justfile of its own, or the text says it is the reader's project ("your
  project", "your package.json"; agent instruction files always describe this repository). A repository that is a
  task runner itself (go-task, just) documents its users' tasks. A script another package of the repository defines
  is not judged from prose that does not say which package it means.
- A repository (or folder) without the manifest: then the docs describe someone else's.

Measured on 22 public repositories (the eight above, plus cline, OpenHands, browser-use, openai-agents-js, llm,
datasette, sqlite-utils, hatch, pydantic, httpie, go-task and two SDKs), with more than 1,300 invocations of their own
CLIs judged: the findings were real, such as a README that runs a `just` recipe the justfile never had, or
`npm run eval:e2e` in a folder whose `package.json` defines only `analysis`.

## Environment variables, symbols and docstrings

**Documented variables** come from env example files (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`,
`.env.local.example`, commented `# X=` lines included), env tables (a table whose header cell says env or variable),
`export X=`, `X=1 cmd` and `$env:X =` in shell blocks, `.env`-style blocks, code spans next to "environment
variable" or `.env`, explicit reads in prose (`process.env.X`, `os.environ["X"]`, `$X`) and Sphinx `envvar`.
**Reads** are found in every code file of the repository, comments and strings left out: `process.env.X`,
`process.env["X"]`, `const { X } = process.env`, `import.meta.env.X`, `Deno.env.get`, `Bun.env`, `os.environ`,
`os.getenv`, Go's `os.Getenv`, Rust's `env::var` and `env!`, Ruby's `ENV`. A documented name also counts as read when
it appears anywhere in the code or the build and CI files (`Dockerfile`, compose files, workflows, hooks): schemas
(zod, envalid, t3-env), constants and `${X}` references all name it.

`env-unused` never judges a name it cannot prove unread:

- Names the platform, a toolchain or a dependency reads by convention: `PATH`, `HOME`, `CI`, `NODE_ENV`, `PORT`,
  `GITHUB_*`, `npm_*`, `VERCEL_*`, proxies and certificates, `PYTHON*`, `RUST_*`, `OTEL_*`, test runners; `OPENAI_*`
  with the openai SDK, `AWS_*` with an AWS SDK, `DATABASE_URL` with Prisma, `SENTRY_*`, `NITRO_*`, `DD_*`, and any
  `NAME_*` whose prefix is a dependency's name (`stripe` → `STRIPE_*`) or a package the docs tell readers to install.
- Names read by the docs' own examples (`os.environ["X"]` in a code block, `"$X"` in a command), names of a family the
  docs or the code treat as a group (`SMOLVM_*`, `UV_\w+`, `startsWith("APP_")`), and names of another product the
  sentence names ("set `LANGSMITH_TRACING` so LangSmith exports traces").
- Computed reads: `` env[`APP_${name}`] `` reads `APP_MODEL` when the code spells out `MODEL`; a variable key
  (`process.env[key]`) takes its names from the code; pydantic `BaseSettings` fields (with `env_prefix`), clap
  `#[arg(env)]` and upper-cased names are matched loosely. When the code reads a name it computes from nothing
  visible (`process.env[a + b]`, `Settings(**os.environ)`), no documented name is judged.
- Docs pages (not READMEs, agent files or env files) often describe the reader's project or another product, so there
  only variables named after this repository (its name, owner or a package it ships: `STALEPROOF_HOME`, `FLASK_APP`)
  are judged. Lines that say a variable was removed or renamed, and migration pages, are history.

`env-undocumented` asks an env example file for the variables read by product code under its folder (an app's
`.env.example` covers that app): tests, scripts, tool configs, variables the code sets itself and platform variables
are left out, and a variable documented anywhere in the docs counts as listed. One finding per variable, on its first
read.

`symbol-missing` judges a span only when its owner is exact: a dotted name the symbol table resolves
(`pkg.client.Client`), a top-level package, or a class name defined once in the code that no module rebinds. The
owner's members must all be visible, as for the `example-missing-attribute` check: no `__getattr__`, metaclass, class
decorator, base class from outside the repository, `setattr`/`__dict__`/`Object.assign(this)` or index signature;
a module's member is judged only when written as a call (`pkg.connect()`) or a Sphinx cross-reference
(``:func:`pkg.connect` ``). Never judged: instance variables in prose (`db.query()`), other packages (`json.dumps`), names
the owner's source mentions (a constructor option), a package name the docs' examples bind as a variable
(`mcp = FastMCP()` makes `mcp.run()` the instance's), names that are file names (`setup.py`), and history lines and
pages.

Docstrings are read from the code the example checks parse (Python packages; JavaScript and TypeScript of published
npm packages): Google `Args:`/`Keyword Args:`, NumPy `Parameters`, Sphinx `:param x:`/`:param type x:`, JSDoc and
TSDoc `@param x`, `@param {T} x`, `@param [x=1]`. A class docstring's `Args:` describe its own `__init__`.
`docstring-param-unknown` skips functions that take `*args`, `...rest` or `**kwargs` (unless a separate `Keyword Args:`
section says which names are keywords; then the `Args:` names are judged), destructured parameters, overloads, and
decorators that may change the signature; `@param opts.x` documents a property, `_controller` is still `controller`,
and the fields of an inline object type (`args: { id: string }`) may be documented by name.
`docstring-param-undocumented` reports a parameter left out of a docstring that documents at least half of them, never
`self`, `cls`, `_private`, `*args`/`**kwargs`, a framework-injected context (`RunContext`, `Context`) or a parameter
its prose already names. Both locate the finding on the docstring line in the code file.

## Options

| Option | Default | Effect |
|---|---|---|
| `[dir]` | `.` | The checkout to lint |
| `--format <f>` | `text` | `text`, `json`, `sarif`, `github` (workflow annotations) or `markdown` |
| `--out <file>` | stdout | Write the report to a file |
| `--fail-on <level>` | `error` | Exit 1 when a finding is at or above `error`, `warning` or `info`; `never` always exits 0 |
| `--rule <ids...>` | all | Only these rules |
| `--disable <ids...>` | none | Skip these rules |
| `--files <paths...>` | all | Report only findings in these files or about them |
| `--with <dirs...>` | none | Other checkouts whose code the docs examples call (an SDK next to a docs repository) |
| `--no-examples` | examples on | Skip the static example checks (the symbol and docstring rules still parse the code; disable them to parse none) |
| `--repo <owner/name>` | origin remote | The GitHub repository, for links in reports |
| `--new` | off | Only findings the changes introduced: absent at the base commit ([below](#only-what-a-change-introduced)) |
| `--base <ref>` | see below | With `--new`: the commit to compare with |
| `--staged` | off | Lint the git index (what the next commit contains) instead of the files on disk |
| `--no-cache` | cache on | Parse every file again instead of reading the parse cache ([below](#the-parse-cache)) |

Exit status: `0` nothing at or above `--fail-on`, `1` findings at or above it, `2` a usage or internal error.

## Only what a change introduced

`--new` reports the findings your changes introduced and nothing a repository already had, so a hook, an editor or a
CI step on an old repository starts quiet:

```bash
npx staleproof lint --new              # the working tree against its base
npx staleproof lint --new --base main  # this branch against main
npx staleproof lint --staged --new     # what the next commit introduces
```

The base is the commit named by `--base`; without it, `HEAD` when the working tree has uncommitted changes (staged,
unstaged or new files), else the merge base with the default branch (`origin/HEAD`, else `origin/main`,
`origin/master`, `main` or `master`). With `--staged` it is `HEAD`. The base is read from the local clone into a
temporary folder (`git read-tree` and `checkout-index`, with the clone's objects and history; nothing is fetched,
and a blob-less clone reads what it lacks the way `git checkout` would), linted the same way, and its findings are
subtracted by fingerprint. The command logs what it compared on stderr:

```text
new findings only: working tree against main (1a2b3c4) (this branch against main); 1 fixed
```

Fingerprints ignore line numbers (rule, file, what is referenced, and which occurrence in the file), so lines added
above a reference never make it new, while a change elsewhere does: a script renamed in `package.json` makes the
README's `npm run` of it a **new** finding, though the README was not touched. That is the point: the change made
the README wrong. A base that is not a commit in the clone is an error (`fetch it first`).

`--staged` lints exactly what `git commit` would record, which differs from the disk when only part of a change is
staged. Inside a pre-commit hook it reads the index git hands the hook (`GIT_INDEX_FILE`).

With `--format json`, `--new` adds `base` (`ref`, `sha`, `label`, `why`), `head` (`label`, `sha`) and `fixed` (how
many base findings the changes removed) to the [JSON output](#json-output); `findings` and `summary` hold only the
new findings.

## The parse cache

What the parsers read from each code file and each docs example is kept in `.staleproof/cache/` at the top of the
checkout, keyed by the file's content (and the Staleproof build), together with the deleted and renamed paths of the
git history, keyed by the refs. A second run parses only the files that changed and reads the history again only
after a commit, a fetch or a branch switch; the findings are the same as without it. The folder ignores itself in
git, is never sent anywhere, and is safe to delete. `--no-cache` or `STALEPROOF_CACHE=off` turns it off;
`STALEPROOF_CACHE_DIR` moves it (the [GitHub Action](github-action.md) keeps it between runs that way). The
[coding-agent hooks](claude-code.md) and `--new` share it.

## In the inner loop

The same check runs before the change leaves the machine: after each edit an AI agent makes and before it stops
([Claude Code plugin](claude-code.md), Cursor hooks), and on `git commit` ([pre-commit, lefthook, husky](pre-commit.md)).
`npx staleproof init` sets up the workflow, the pre-commit hook and the agent hooks in one step
([CLI: init](cli.md#init)).

## In CI

Annotations on the pull request's files, with no setup beyond Node.js:

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0 # history lets lint say where a missing file went
- run: npx -y staleproof lint --format github
```

Only what the pull request introduced (the base branch must be in the checkout):

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0
- run: npx -y staleproof lint --new --base origin/${{ github.base_ref }} --format github
```

The [GitHub Action](github-action.md#docs-this-pull-request-makes-wrong) does this on every pull request without a
checkout: its comment lists the new findings under "Docs this pull request makes wrong", and they appear as
annotations.

Or upload SARIF to GitHub code scanning:

```yaml
- run: npx -y staleproof lint --format sarif --out staleproof.sarif --fail-on never
- uses: github/codeql-action/upload-sarif@v4
  with:
    sarif_file: staleproof.sarif
```

## Configure and silence

In `.staleproof.toml` (or under `[tool.staleproof]` in `pyproject.toml`):

```toml
[lint]
exclude = ["docs/archive/**"]
agent-files = ["prompts/*.md"]

[rules]
"anchor-missing" = "error"   # off | info | warning | error
```

Silence one line with a comment on the line before it or at its end; silence a whole file at its top:

```markdown
<!-- staleproof: ignore -->
<!-- staleproof: ignore path-missing link-broken -->
<!-- staleproof: ignore-file -->
```

MDX uses `{/* staleproof: ignore */}`; reStructuredText `.. staleproof: ignore`. In code, env files and docstrings,
`# staleproof: ignore[rule]` or `// staleproof: ignore[rule]` (several rules separated by commas, none for all) at the
end of a line or alone on the line before it; on the line before a `def` (or its decorators) it covers the whole
docstring, and on any read of a variable it silences `env-undocumented` for that variable. Unknown config keys are
reported as warnings and never stop a run.

## JSON output

`--format json` prints `{ "version": 1, "repo", "sha", "findings": [...], "summary", "warnings", "tool" }`. Each
finding has `rule`, `severity`, `message`, `path`, `line`, `column`, `endLine`, `endColumn` (1-based, end
exclusive), `surface` (`agent`, `readme`, `docs`, `example`, `docstring`, `config`), `subject` (what the text refers
to), `evidence` (where Staleproof looked, and a link to the line) and a `fingerprint` that stays the same when lines
are added above the finding. Fields are only ever added to this format.

## Fixing what lint finds

`staleproof fix` applies the fixes it can re-check; `staleproof lint --fixes` shows them without applying (`fix:` lines in text, `Fix:` in annotations, `fixes` in SARIF). [Fix stale docs](fix.md) has the details.

## Related

- [Lint rules](rules.md): every rule with an example.
- [Docs audit](audit.md): a health score, example runs and API coverage, using the graph.
- [Configuration](configuration.md): `.staleproof.toml`.
- [Editors (LSP)](editors.md): the same findings in VS Code, Cursor, Neovim, Zed, Helix and JetBrains while you type.
- [Fix stale docs](fix.md): the fixes `staleproof fix` applies, re-checked first.
- [Claude Code plugin](claude-code.md): these findings after every edit an agent makes, and before it stops.
- [Pre-commit hooks](pre-commit.md): `lint --new --staged` on every commit.
