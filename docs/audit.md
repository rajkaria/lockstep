# Docs audit

A docs audit answers "how true are these docs right now?" with no pull request: every call in a docs example checked against the code it reaches (in its own repository or another), the latest example runs at the indexed commits, and how much of the public API the docs name or call, summed up as a health score from 0 to 100. This page covers what the audit checks, how the score is computed, the CLI command, the web page, the README badge, the HTTP API and MCP tool, the GitHub Action's scheduled audit, how to read and act on the report, and its limits. It is for maintainers and docs teams who want a baseline before relying on pull request checks, or a weekly report after.

## Run it

```bash
npx -y staleproof audit FalkorDB/falkordb-py
```

With no FalkorDB configured the CLI starts a local one, indexes the repository at its default branch head if the graph does not have it, and prints the report. Name every repository that shares the docs, so calls across them resolve: `staleproof audit acme/acme-client acme/acme-docs` indexes the two together on first use. With no repository at all, `staleproof audit` audits every repository in the graph.

Other ways to run the same audit: the page [staleproof.dev/#/audit](https://staleproof.dev/#/audit) for any public repository, [`GET /api/audit`](http-api.md#get-apiaudit), the MCP tool [`audit_docs`](tools.md#audit_docs), and the [GitHub Action](github-action.md#audit-the-docs-on-a-schedule) on a schedule.

## What it checks

### Examples that no longer fit the code

At index time every docs example is checked statically against the signatures and names its calls reach, and each line that does not fit becomes a `MISMATCH` edge in the graph ([Indexing](indexing.md#static-checks-of-examples) has the rules). The audit lists them, with the doc line, the section, the call as written and what is wrong:

| Kind | Label in the report | Example detail | Languages |
|---|---|---|---|
| `unknown-keyword` | unknown keyword argument | `` `Client` has no parameter `hostname` `` | Python |
| `too-many-arguments` | too many positional arguments | `` `Graph.query` takes at most 2 positional arguments; the example passes 3 `` | Python |
| `missing-argument` | missing required argument | `` `Graph.query` requires `timeout`, which the example does not pass `` | Python |
| `missing-import` | imports a name that does not exist | `` `miniclient` has no `connect` `` | Python, JavaScript, TypeScript |
| `missing-attribute` | calls an attribute that does not exist | `` `Graph` has no attribute `read_only` `` | Python, JavaScript, TypeScript |

The details above come from the test suite's fixture docs. Nothing runs to find them, so they cost no sandbox, work on the hosted service, and cover examples that could never run (an LLM key, a placeholder host). A check is only made when the source settles it: a call reached by name rather than through imports and types, a decorator that may rewrite the signature, a class with an external base or a `__getattr__`, or a `*args`/`**kwargs` splat leaves the line unjudged.

### Example runs

The audit reads the latest recorded run of each example at the indexed commits (the `current` side; runs before and after a pull request are not counted), and only runs whose installed commits are the ones the graph holds now. `staleproof audit --run <n>` first runs up to `n` Python examples in the [sandbox](example-runner.md): those with a mismatch first, then the ones that call the most code. Examples marked `skip` or `expect-error` ([directives](indexing.md#example-directives)) are never run. Without `--run`, the audit uses only what earlier runs recorded.

### API coverage

The public API is what a repository's packages export:

- **Python**: names bound in a public package's `__init__.py` (or a top-level module) that resolve to the organisation's definitions, following `from .x import *` and imports from private modules (`httpx._api.get` counts as `httpx.get`), plus the public methods of exported classes and of their base classes in the organisation.
- **TypeScript and JavaScript**: what each published package's entry file exports, followed through re-exports, plus the public methods of exported classes.

A repository indexed before export information existed, or one whose package has a module-level `__getattr__` (lazy exports the source does not show), falls back to the Python naming rule: no part of the qualified name starts with `_`. Either way, symbols nested in functions and files under `tests/`, `scripts/`, `examples/`, `docs/`, `benchmarks/`, `tools/` and similar are left out.

A public symbol is documented when a doc section names it in inline code or an example calls it (a `MENTIONS` or `USES` edge). A class also counts as documented when any of its methods is, so `g.query(...)` in an example documents `Graph`. Coverage is the documented share, to one decimal place.

### Undocumented API, most used first

The public symbols no doc names or calls, ordered by how much other code depends on them: by the number of other repositories that call them, then classes before functions and methods, then by the number of symbols that call them. The first 25 are listed (`--limit`).

## The score

The score starts at 100 and loses points for three things:

| Deduction | Points | Cap |
|---|---|---|
| Each example with at least one line that no longer fits the code | 8 | 50 |
| Each other example that fails when run (`fail` or `timeout`; examples already counted as mismatched are not counted twice) | 6 | 30 |
| Each percent of public API that no doc names or calls | 0.3, rounded | none |

The score never goes below 0. The grade is `A` from 90, `B` from 80, `C` from 70, `D` from 60, else `F`. Each deduction is listed in the report with its reason.

For example, auditing the fixture repository `acme/mini-client` from the test suite: 2 examples call it in ways it no longer accepts (−16), and 4 of its 11 public symbols are named or called by no doc, 63.6% coverage (−11, from 36.4 × 0.3). The score is 73, grade C.

## What an audit covers

| Called with | Repositories | Examples | Mismatches | API coverage |
|---|---|---|---|---|
| No repository | Every repository in the graph | Every live example | Every one | Every repository's symbols |
| Repositories | Those | The examples in their docs, and examples in other repositories that call their code | In their docs, or in other docs against their code | Their symbols |

So `audit acme/acme-client` also reports a line in `acme/acme-docs` that calls the client wrongly, when both are in the graph. A repository the graph does not have fails with `not indexed in the "<graph>" graph: <repos>` (the CLI indexes it first unless `--no-index`).

## The CLI

```text
staleproof audit [options] [repos...]
```

| Option | Default | Meaning |
|---|---|---|
| `--run <n>` | `0` | First run up to `n` Python examples at the indexed commits (needs `git`, and uv or Python 3.12+) |
| `--limit <n>` | `25` | How many undocumented symbols to list |
| `--format <format>` | `text` | `text`, `markdown` (the Action's job summary and issue body) or `json` |
| `--out <file>` | stdout | Write the report to a file; logs `wrote <file>: <summary>` on stderr |
| `--fail-under <score>` | none | Exit 1 when the score is below this whole number |
| `--fail-on-mismatch` | off | Exit 1 when any example line no longer fits the code |
| `--no-index` | index on first use | Fail instead of indexing repositories the graph does not have yet |

The [global options](cli.md#global-options) apply: without `--org`, the graph is the owner of the first repository named. [CLI](cli.md#audit) has the exit statuses.

**Prints, text.** From the fixture `acme/mini-client` (colours off):

```text
Docs health 73/100 (C)
acme/mini-client@a6214ef

Docs health 73/100 (C) for acme/mini-client. 2 of 5 examples that call the code no longer fit it (4 lines). 7 of 11 public symbols (63.6%) are named or called by a doc.

Score
  -16 2 examples call the code in a way it no longer accepts (8 each, at most 50)
  -11 4 of 11 public symbols are named or called by no doc (0.3 per missing percent)

Examples that no longer fit the code (2 examples, 4 lines)
  ✗ docs/stale.md:0 line 8 · acme/stale-docs
    `miniclient` has no `connect` (imports a name that does not exist; miniclient.connect)
  ✗ docs/stale.md:0 line 10 · acme/stale-docs
    `Client` has no parameter `hostname` (unknown keyword argument; Client)
  ✗ docs/stale.md:1 line 19 · acme/stale-docs
    `Graph.query` takes at most 2 positional arguments; the example passes 3 (too many positional arguments; g.query)
  ✗ docs/stale.md:1 line 20 · acme/stale-docs
    `Graph` has no attribute `read_only` (calls an attribute that does not exist; g.read_only)

API coverage: 7 of 11 public symbols (63.6%) named or called by a doc
  Undocumented, most used first:
  · miniclient.asyncio.client.AsyncClient class · 1 callers (1 other repos) · acme/mini-client
  · miniclient.asyncio.client.AsyncClient.select_graph method · 1 callers (1 other repos) · acme/mini-client
  · miniclient.asyncio.client.AsyncGraph.query method · 1 callers (1 other repos) · acme/mini-client
  · miniclient.asyncio.client.AsyncGraph class · 1 callers · acme/mini-client

Badge: [![docs health](https://staleproof.dev/api/badge/acme/mini-client.svg)](https://staleproof.dev/#/audit?repo=acme%2Fmini-client)
```

The mismatched examples live in another repository (`acme/stale-docs`) and call `acme/mini-client`'s code, so they count for it. When runs are recorded, a section `Example runs at the indexed commits (<p> pass, <f> fail, <s> skipped, <e> not installed)` lists the failing ones. The badge line appears when one repository is audited. When a summary sentence `Indexed by an older Staleproof: …` appears, see [Limits](#limits).

**Prints, Markdown.** The same content as tables: the deductions, the mismatched lines with links to the exact doc line (`| [docs/stale.md:1 line 20](…#L20) | Upgrading guide > Query | `g.read_only` | `Graph` has no attribute `read_only` |`), the failing runs, coverage with the undocumented symbols in a collapsed `<details>` block, the badge, a footer with the graph and commits, and a last line the GitHub Action reads:

```text
<!-- staleproof:audit score=73 mismatched=2 failing=0 coverage=63.6 -->
```

The first line is the marker `<!-- staleproof-audit -->`, which the Action uses to find its issue.

**JSON.** `{summary, org, repos: [{name, sha, symbols, sections, indexVersion}], outdatedIndex, score, grade, deductions: [{points, why}], examples: {total, python, linked, mismatched}, mismatches: [{example, url, repo, path, heading, line, kind, detail, call, symbol}], coverage: {api, documented, percent}, undocumented: [{qualname, repo, kind, signature, url, callers, crossRepoCallers}], runs: [{example, url, status, error, reason}], runCounts: {pass, fail, skipped, error}, generatedAt}`. `examples.linked` counts the examples that call at least one indexed symbol; `examples.mismatched` the ones with at least one `MISMATCH` line.

## On the web

[staleproof.dev/#/audit](https://staleproof.dev/#/audit) audits any public GitHub repository: type `owner/name` (or a repository URL) and press **Audit**. The first audit downloads and indexes the repository into the workspace graph of its owner, showing the progress, then shows the score and grade, the deductions, every example line that no longer fits (linked to the line on GitHub), failing runs recorded earlier, the coverage bar with the undocumented symbols, the badge Markdown (pointing at the host serving the page) and a link to install the GitHub Action. A link to a repository's report is `https://staleproof.dev/#/audit?repo=<owner>%2F<name>`; opening it starts the audit.

The hosted service runs no examples, so its audit scores the static checks and coverage only (plus runs recorded earlier, for FalkorDB's curated repositories). A server you run with `staleproof serve` serves the same page at `#/audit`; it audits the repositories in its graph, and with `--hosted` indexes any public repository first.

## The README badge

```markdown
[![docs health](https://staleproof.dev/api/badge/<owner>/<name>.svg)](https://staleproof.dev/#/audit?repo=<owner>%2F<name>)
```

The report prints this line for one repository. The badge reads `docs health | <score> <grade>`, in the flat shields.io style:

| Score | Colour |
|---|---|
| 90 and up | `#2ea44f` (green) |
| 80 to 89 | `#97ca00` |
| 70 to 79 | `#dfb317` (yellow) |
| 60 to 69 | `#fe7d37` (orange) |
| below 60 | `#e05d44` (red) |
| not indexed on that server | `not audited`, grey |

For an indexed repository the server computes the audit when the badge is requested (cached for 10 minutes per repository) and sends `Cache-Control: public, max-age=3600, s-maxage=3600`, so a README shows a score at most about an hour old. A repository the server has not indexed gets the grey badge, cached for 5 minutes: audit it once on the page (or `POST /api/audit`) and the badge fills in. The badge is served by any `staleproof serve`; replace the host to point it at yours.

## HTTP API and MCP

| Interface | What it does |
|---|---|
| [`GET /api/audit?repo=<owner/name>`](http-api.md#get-apiaudit) | The audit of an indexed repository as JSON, cached for 10 minutes (`&fresh=1` recomputes it); 404 when it is not indexed |
| [`POST /api/audit`](http-api.md#post-apiaudit) | Hosted mode: index the repository if needed, then audit it, streaming progress as server-sent events |
| [`GET /api/badge/<owner>/<name>.svg`](http-api.md#get-apibadgeownernamesvg) | The badge |
| MCP [`audit_docs`](tools.md#audit_docs) | The audit for an assistant: `repos` (default every repository in the graph) and `limit`. The stdio server indexes named repositories on first use; the hosted server indexes the first one and needs it named. It reads recorded runs and runs nothing |

## In CI: audit on a schedule

The [GitHub Action](github-action.md#audit-the-docs-on-a-schedule) audits instead of checking a pull request when the workflow runs on a schedule, `workflow_dispatch` or `push`. Copy [examples/staleproof-audit.yml](../examples/staleproof-audit.yml):

```yaml
name: Staleproof docs audit
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/staleproof@v1
```

Every Monday at 06:00 UTC it indexes the repository (and `also-index`), runs up to 20 examples at the default branch (`audit-runs`), writes the report to the job summary and keeps one issue up to date: opened when an example no longer fits or fails, updated on every run, and closed with a comment once all is clear. `fail-on: mismatches` and `fail-under: <score>` fail the job; the outputs `score` and `mismatched` carry the numbers.

## Reading the report

Work through the mismatches first: each one is a line a reader will copy and see fail.

| Kind | What to do |
|---|---|
| `unknown-keyword` | The parameter was renamed or removed. Find its new name in the signature the evidence points at (`staleproof docs-for <symbol>` shows the signature), or drop the argument |
| `too-many-arguments` | A parameter became keyword-only, or was removed. Pass the rest by keyword, as the current signature names them |
| `missing-argument` | A parameter became required. Pass it, or check whether the example should call something else |
| `missing-import` | The name moved or was removed from the package. Import it from where it lives now, or use its replacement |
| `missing-attribute` | The method was renamed or removed, or never existed on that class. Call the current method |

Then the failing runs: a run that fails at the indexed commits is broken for readers now, whatever the static checks say (a wrong value, a server the page never sets up). Then coverage: the undocumented list is ordered so the symbols other code relies on most come first.

When a finding is intentional, mark the example rather than editing the code: `<!-- staleproof: expect-error -->` above an example that fails on purpose, `<!-- staleproof: skip -->` above one that cannot be judged, or `skip-examples` in `.staleproof.toml` for a whole directory of versioned docs ([directives and repository config](configuration.md#repository-configuration)). Marked examples stay linked to the code (so pull request checks still find them) but are never judged or run. Re-index the docs repository after editing, then audit again.

## What it finds on real repositories

Lines the static checks report on repositories as they are today (checked on 2026-10-17):

- **FalkorDB docs**: `commands/graph.constraint-create.mdx` calls `client.create_constraint`, which `FalkorDB` does not have (`missing-attribute`). Running the example fails with `AttributeError: 'FalkorDB' object has no attribute 'create_constraint'`.
- **GraphRAG-SDK**: `docs/api-reference.mdx` documents `VectorStore(index_name=..., similarity_function=...)`, parameters the constructor no longer has (`unknown-keyword`).
- **Flask**: `docs/views.rst` calls `UserList.as_view()` without its required `name` (`missing-argument`), found in reStructuredText docs.
- **httpx**: the docs pass `extensions=` to `httpx.get`, which no longer accepts it (`unknown-keyword`).

## Limits

- **Static checks follow exact resolutions only.** A call whose receiver the types do not reveal (resolved by name, or not at all) is never judged, so a clean audit means "nothing found where the source is certain", not "every example works". Runs (`--run`, or the Action's `audit-runs`) cover the rest for Python.
- **Guards leave lines unjudged**: functions with a decorator outside a short allow-list (`staticmethod`, `classmethod`, `functools.cache`, `lru_cache`, `abstractmethod`, `override`, `final`, `deprecated`, `wraps`), several definitions under one name (`@overload`), properties, classes with class decorators, a metaclass, a `__getattr__`, a `__new__` or a base class outside the organisation (other than `object`, `ABC`, `Generic`, `Protocol`), modules with a `__getattr__` or a star import from outside the organisation, calls with `*args` or `**kwargs`, and calls or signatures tree-sitter cannot read.
- **TypeScript and JavaScript get no argument checks** (JavaScript accepts any argument count), only names that do not exist; their examples are never run.
- **Runs need a sandbox.** `--run` needs `git` and uv or Python 3.12+; the hosted service and `audit_docs` run nothing and read only recorded runs.
- **Coverage counts references, not explanations.** A symbol named once in inline code counts as documented.
- **An older index** (written before Staleproof 0.3) has no `MISMATCH` edges or export flags. The audit then adds `Indexed by an older Staleproof: examples are not checked against the code until the repositories are indexed again (staleproof index).` to its summary and sets `outdatedIndex`; re-index the repositories. Hosted workspaces indexed by an older version are re-indexed on their next use.
- **One graph at a time.** An audit covers repositories in one graph; cross-repository findings need the repositories indexed together.

## Related

- [CLI](cli.md#audit): the `audit` command and its exit statuses
- [Indexing](indexing.md#static-checks-of-examples): how examples are checked against the code
- [GitHub Action](github-action.md#audit-the-docs-on-a-schedule): the scheduled audit and its issue
- [Configuration](configuration.md#repository-configuration): directives and `.staleproof.toml`
- [Core concepts](concepts.md#static-checks-and-the-audit)
