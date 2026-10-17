# Lint docs and agent files

`staleproof lint` checks every claim your docs make about your repository against the repository itself: the
paths they name, the links and anchors they follow, and the code examples they show. It reads the files AI coding
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
| Code blocks in those pages (Python, JavaScript, TypeScript) | Code examples |

Changelogs, codes of conduct, licences, issue templates, translations (`docs/zh/…`, `i18n/de/…`), test fixtures and
vendored folders are not checked. Add files with `[lint] include`, more agent files with `[lint] agent-files`.

## What it checks

| Rule | Severity | Reports |
|---|---|---|
| `path-missing` | error | A code span names a file or folder that does not exist, with where it moved or when it was deleted |
| `line-out-of-range` | warning | `path:line` or `path#L12` past the end of the file |
| `link-broken` | error | A relative link to a missing file (and the right link when the file is at the repository root) |
| `anchor-missing` | warning | `#anchor` with no heading of that slug in the target page |
| `example-*` | error | A docs example that calls the code with an unknown keyword, too many or too few arguments, a missing import or attribute, or a removed symbol ([static example checks](audit.md)) |

The [rules reference](rules.md) lists every rule with an example. Commands (`npm run x`, `make x`), the repository's
own CLI flags, environment variables, symbol references in prose and docstrings are next on the list there.

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
| `--no-examples` | examples on | Skip the static example checks (no code is parsed) |
| `--repo <owner/name>` | origin remote | The GitHub repository, for links in reports |

Exit status: `0` nothing at or above `--fail-on`, `1` findings at or above it, `2` a usage or internal error.

## In CI

Annotations on the pull request's files, with no setup beyond Node.js:

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0 # history lets lint say where a missing file went
- run: npx -y staleproof lint --format github
```

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

MDX uses `{/* staleproof: ignore */}`; reStructuredText `.. staleproof: ignore`. Unknown config keys are reported
as warnings and never stop a run.

## JSON output

`--format json` prints `{ "version": 1, "repo", "sha", "findings": [...], "summary", "warnings", "tool" }`. Each
finding has `rule`, `severity`, `message`, `path`, `line`, `column`, `endLine`, `endColumn` (1-based, end
exclusive), `surface` (`agent`, `readme`, `docs`, `example`, `docstring`, `config`), `subject` (what the text refers
to), `evidence` (where Staleproof looked, and a link to the line) and a `fingerprint` that stays the same when lines
are added above the finding. Fields are only ever added to this format.

## Related

- [Lint rules](rules.md): every rule with an example.
- [Docs audit](audit.md): a health score, example runs and API coverage, using the graph.
- [Configuration](configuration.md): `.staleproof.toml`.
