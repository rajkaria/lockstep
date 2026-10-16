# Indexing

This page explains what `staleproof index` reads from your repositories and how it turns them into the graph: which files count, how Python is parsed, how calls are resolved across repositories, how Markdown sections, inline code and code examples are linked to the code, how repository dependencies are found, and what a re-index keeps and replaces. Read it if you maintain the repositories being indexed, or want to know why an edge exists (or does not).

## Index your organisation

Index every repository that shares code or docs in one command. Cross-repository edges only exist between repositories indexed together.

```bash
npx -y staleproof index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
```

Each argument is `owner/name`, `https://github.com/owner/name` (with or without `.git`) or `git@github.com:owner/name.git`. The graph is the one named by `--org` or `STALEPROOF_ORG`, else the owner of the first repository (`falkordb` here), on the server named by `--db` or `FALKORDB_URL`; see [Configuration](configuration.md). Add `--json` to print the full [index report](#the-index-report) instead of the summary.

You do not have to run `index` before a first check: `staleproof check`, the MCP tools `check_pull_request`, `impact` and `clearance`, and a hosted server index a pull request's repository the first time they see it, at its default branch head (`check --with` adds the repositories to index with it). Run `index` yourself to index several repositories together, to pick a ref, or to move the graph to newer commits.

Progress goes to stderr, one line per phase: `checkout`, `parse`, `write`, `resolve`, `docs` and `done`.

## The pipeline

1. **Checkout**: each repository is cloned or fetched, or downloaded as a tarball where there is no git (see [Checkouts](#checkouts)).
2. **Parse**: every Python library file of every repository is parsed.
3. **Symbol table**: one table is built over all the parsed repositories, so a call in one repository can resolve into another.
4. **Write and resolve**: `Repo`, `File` and `Symbol` nodes are written, then each repository's `CALLS` edges are resolved against the whole table.
5. **Docs**: for each repository with Markdown pages or example scripts, `DocSection` and `CodeExample` nodes are written and linked to the code with `MENTIONS`, `USES` and `LINKS_TO`.
6. **Dependencies**: `DEPENDS_ON` edges between repositories are written.

Every run first creates the exact-match indexes the queries rely on (already-existing indexes are fine) and gets a run id such as `idx-20261016225012-k3f9`, stored as `seen` on every node it writes. Writes are batched 400 rows at a time.

## Checkouts

- **Where**: `<STALEPROOF_HOME>/repos/<owner>/<name>` (`~/.staleproof` by default).
- **First time**: `git clone --filter=blob:none` over HTTPS. Blobs are fetched when needed.
- **Private repositories**: with `GITHUB_TOKEN` (or `GH_TOKEN`) set, git sends the token to `https://github.com/` through its environment configuration (an `http.extraheader`, never in the remote URL or on the command line), so every repository the token can read clones like a public one. Without a token, terminal prompts are disabled and a private repository fails to clone.
- **Later**: `git fetch --prune origin`.
- **Which commit**: the remote's default branch head (`origin/HEAD`, falling back to `origin/main`), checked out detached. Its SHA becomes `Repo.sha`, the indexed commit that doc URLs, example runs and the docs patch are pinned to.
- **A specific ref**: `--ref <repo>=<ref>`, repeatable, is passed to `git checkout --detach`. Use `origin/<branch>`, a tag or a commit SHA: a bare branch name refers to the clone's local branch, which later fetches do not move.

```bash
npx -y staleproof index FalkorDB/falkordb-py FalkorDB/docs --ref FalkorDB/falkordb-py=origin/main
```

Files are listed with `git ls-files`, so untracked build output never enters the graph.

### Without git: tarballs

When `git` is not installed (a serverless host), or with `STALEPROOF_INGEST=github`, each repository is downloaded as a tarball instead ([src/indexer/tarball.ts](../src/indexer/tarball.ts)):

- **Where from**: `https://codeload.github.com/<owner>/<name>/tar.gz/<ref>` without a token, which costs no GitHub API request. With `GITHUB_TOKEN` (or `GH_TOKEN`), the API's `repos/<owner>/<name>/tarball/<ref>` endpoint, one API request, which also reads private repositories the token can see.
- **Which commit**: `<ref>` defaults to `HEAD`, the default branch head. The commit SHA comes from the archive's pax header (the `comment=<sha>` record `git archive` writes), so learning it costs no API call. `--ref` must be a branch, tag or SHA GitHub knows; `origin/<branch>` exists only in a clone.
- **What is extracted**: only the files the indexer reads, by the rules in the next section, plus every `pyproject.toml` and `requirements*.txt`; paths with a component starting with `.` are skipped. They go to `<STALEPROOF_HOME>/tarballs/<owner>/<name>/<sha>`, and a directory walk replaces `git ls-files`.
- **Limits**: a compressed archive over 150 MB, or more than 4000 extracted files (3000 on a hosted server), is refused with `<repo> is too large to index from an archive here (...)` and the command to run it locally.

Example runs and the text-match counts of `clearance` still need a git clone, so a host without git indexes and checks but runs no examples.

## Which files are indexed

Each tracked path is classified by these rules, in order:

| Rule | Paths | Result |
|---|---|---|
| 1 | Anywhere under `.github/`, `node_modules/`, `venv/`, `.venv/`, `build/`, `dist/`, `site-packages/`, `__pycache__/`, `.tox/`, `.mypy_cache/` | Skipped |
| 2 | `.md` and `.mdx` files | Markdown pages, except housekeeping files (names starting with `CHANGELOG`, `CHANGES`, `HISTORY`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`, `SUPPORT`, `AGENTS`, `CLAUDE`, `GEMINI`, `LICENSE`, `NOTICE`, `PULL_REQUEST_TEMPLATE`, `ISSUE_TEMPLATE`, any case) and pages under `test/`, `tests/`, `testing/` or `fixtures/`, which are skipped |
| 3 | Anything that is not `.py` | Skipped (notebooks, `.rst`, JavaScript and TypeScript are not indexed as code) |
| 4 | Tests: under `test/`, `tests/` or `testing/`, or named `test_*.py`, `*_test.py`, `conftest.py` | Skipped |
| 5 | `setup.py`, `noxfile.py`, `fabfile.py` | Skipped |
| 6 | Under `example/`, `examples/`, `sample/`, `samples/`, `tutorial/`, `tutorials/`, `notebook/`, `notebooks/` | Example scripts (indexed as code examples, not library code) |
| 7 | Under `script/`, `scripts/`, `benchmark/`, `benchmarks/`, `docs/` | Skipped |
| 8 | Everything else ending in `.py` | Python library code |

Rule 6 runs before rule 7, so `docs/examples/quickstart.py` is an example script. Example scripts are how examples shipped inside a code repository (such as GraphRAG-SDK's `graphrag_sdk/examples/*.py`) become docs.

A hosted server ([hosted mode](DEPLOY.md#hosted-mode)) also skips translated docs: paths under `docs/`, `doc/`, `documentation/`, `i18n/`, `locale/`, `locales/`, `translation/`, `translations/` or `content/` followed by a language directory, such as `docs/zh/`, `docs/pt-BR/` or `i18n/ja/` (`TRANSLATION_DIR` in [src/hosted/workspaces.ts](../src/hosted/workspaces.ts)). The CLI indexes them.

## Python parsing

Python is parsed with tree-sitter compiled to WebAssembly (`web-tree-sitter` and the grammar vendored at `grammars/tree-sitter-python.wasm`), so no native build is needed. Tree-sitter tolerates syntax errors: a file with an error still yields the definitions it can read. A file that cannot be read or parsed at all is listed in the report's `parseErrors` as `<path>: <message>`.

### Module names

A package root is the topmost directory of a chain of directories that each contain an `__init__.py`; module names start at its parent. `graphrag_sdk/src/graphrag_sdk/core/connection.py` becomes `graphrag_sdk.core.connection`, so `src/` layouts work. A file whose directory has no `__init__.py` is a loose module named after its full path (`src/util.py` becomes `src.util`). `Repo.packages` lists the first component of every module name; it is how the indexer knows which repository defines `falkordb` or `graphrag_sdk`.

### Symbols

Each module yields `Symbol` nodes of four kinds: `module`, `class`, `function` and `method`. A `method` is a `def` directly in a class body; a `def` nested inside a method is a `function`. Each symbol stores:

- `qualname`: `<module>.<Class>.<method>`, for example `falkordb.asyncio.falkordb.FalkorDB.__init__`; the id is `<owner>/<name>:<qualname>`.
- `signature`: `def name(<parameters>)` (or `async def`) with ` -> <return>` when annotated; `class Name(<bases>)` for classes.
- `doc`: the first line of the docstring.
- `decorators`: as written, without `@` (`property`, `x.setter`).
- `visibility`: `special` for `__name__`, `private` for a leading `_`, otherwise `public`.
- `path`, `lineno`, `end_lineno`.

## Call resolution

Every call site is resolved against one symbol table built from all the repositories in the `index` command. The resolver is static: it follows what the source says, without running it.

### Exact resolution

A call resolves exactly when the callee evaluates to a definition in the organisation. The resolver follows:

- **Imports**: `import a.b`, `import x as y`, `from m import n as a`, relative imports (`from . import x`, where one dot in an `__init__.py` means the package itself) and `from m import *`.
- **Package re-exports**: `pkg.Name` resolves through a `from .module import Name` in the package's `__init__.py`, following import chains through modules and star imports; `pkg.Class.method` resolves through the class.
- **Attribute types**: a variable bound to `Class(...)`, or to a call whose return type is known, is an instance of that class, so `g.query(...)` resolves to the class's method.
- **Return annotations**: a function annotated `-> AsyncGraph` returns an `AsyncGraph`. Without an annotation, the first `return` expression that evaluates to something is used. `Optional[...]`, `Awaitable[...]`, `Coroutine[...]` and `X | None` are unwrapped.
- **Base classes**: a method not defined on the class is looked up on its bases, recursively.
- **`self.x = ...` assignments**: an assignment to `self.<attr>` in any method is recorded on the class, so `self._graph.query(...)` in one method resolves through `self._graph = self._driver.select_graph(...)` in another, into another repository if that is where `select_graph`'s return type lives. When an attribute has several assignments, one that resolves into the organisation wins over one typed `Any` or external.
- **Properties**: `obj.prop` on a `@property` or `cached_property` evaluates to the property's return type.
- **Other bindings**: `with X as y`, and annotated parameters (`def f(g: Graph)`).

Calling a class adds a second exact edge to its `__init__` (searched through bases too). That is how #262's README example reaches `FalkorDB.__init__`, and from there `Is_Cluster`.

Not tracked: `for` loop targets, tuple unpacking, the walrus operator, and anything only known at run time. Each lookup has a depth limit, so cycles in imports or types end.

### By-name fallback

When exact resolution fails, an attribute call `x.m()` can still get edges by name, under these rules:

- Only attribute calls. A bare call `foo()` that does not resolve gets no edge.
- Only when the receiver is unknown. If it evaluates to something outside the organisation (`redis.Redis().get()`), there is no edge.
- Never for generic names: 105 names such as `get`, `set`, `run`, `execute`, `close`, `connect`, `build`, `create` and `data` (the `GENERIC` list in [src/indexer/resolve.ts](../src/indexer/resolve.ts)), and never for names starting with `__`.
- Candidates are the functions and methods named `m` in the module's own repository and in the repositories that define the top-level packages the module imports.
- Edges are written only when there are 1 to 4 candidates, one edge to each.

Every edge records how it was found in `resolved`: `exact` or `by-name`. One edge is kept per caller and callee, with `exact` preferred, and calls of a function to itself are dropped.

### Why edges are labelled

A by-name edge can be wrong: it says "a method with this name, in a repository this module imports". The label travels with it. An impacted section whose evidence path contains a `by-name` edge has [confidence](concepts.md#confidence) `by-name`, the PR comment and the terminal output show it, and graph mode only runs examples from `exact` sections. Nothing presents a guess as a proven path.

## Docs

### Sections

Markdown and MDX pages are read with a tolerant line scanner, not a strict MDX parser: real docs sites (Mintlify components, stray braces) break strict parsers, and only headings, fenced code, inline code and links are needed.

- **Headings**: ATX headings only (`#` to `######` at the start of a line). Setext headings, indented headings and JSX or HTML headings are not recognised, and a `#` line inside a fence is never a heading.
- **Sections**: each heading starts a section that runs to the next heading of any level. Text before the first heading becomes a level-0 section with an empty anchor, kept only if it has content.
- **Page title**: the front matter `title:`, else the first H1, else the file name.
- **`heading_path`**: the ancestor headings joined with ` > `, starting from the page's own headings: `falkordb-py > Usage > Asynchronous Example`.
- **Anchors**: an explicit `{#id}` after the heading, else a slug of the heading text (lowercase, punctuation removed, whitespace turned into `-`). Links, tags, backticks and word-boundary emphasis are removed from heading text first. Duplicates get `-1`, `-2`.
- **Body**: the section's Markdown with its heading line, trimmed and truncated to 8000 characters.
- **URL**: `https://github.com/<repo>/blob/<indexed sha>/<path>#L<line>`.

### Mentions

A section `MENTIONS` a symbol when its inline code names it. Only inline code counts: prose and fenced blocks do not. A span names code when:

- it does not start with a shell or tool word followed by a space (`pip`, `npm`, `uv`, `docker`, `git`, `curl`, `cd`, `export`, `python`, `node` and similar);
- it is a dotted identifier, optionally called: `Graph.ro_query`, `db.select_graph("x")`, `select_graph()`;
- it is not all capitals (configuration keys, Cypher keywords) and not a Cypher procedure (`algo.`, `db.idx.`, `GRAPH.` and similar).

Each accepted identifier is matched against symbols in repositories that have Python code (never a module):

- **Dotted names** resolve exactly through modules and re-exports (`falkordb.FalkorDB`). Otherwise symbols whose qualified name ends with `.Graph.ro_query` match by name, if there are 1 to 4. A dotted name starting with a lowercase variable that is not a package (`db.select_graph()`) falls back to its last part.
- **Bare names** link only when they look like code (called, or containing `_` or a capital), are at least 3 characters, are not generic, do not start with `_`, and are not properties. They link only into the repositories the page is about: the page repository's own packages, the packages its Python examples import, and the packages named in its install commands (`pip install graphrag-sdk`) or inline code (`falkordb`). Again only with 1 to 4 candidates.

The section also stores every identifier it named (and each one's last part) in `idents`. Pull request ingestion uses them to [late-link](concepts.md#resolution) symbols that were removed before the graph was indexed.

### Code examples

Every fenced block (backticks or tildes, any language) is a `CodeExample`, with id `<repo>:<path>:<index>` where `index` counts all fenced blocks in the file from 0. It is placed in the section that contains its opening fence (`IN_SECTION`). Details:

- **Language**: the info string, normalised: `py`, `python3`, `py3`, `pycon` become `python`; `sh`, `shell`, `zsh`, `console` become `bash`; `js` becomes `javascript`; `ts` becomes `typescript`.
- **Indentation**: code inside an indented fence (common in MDX components) is dedented. An unclosed fence runs to the end of the file and is kept.
- **Size**: the stored code is truncated to 20000 characters.
- **REPL transcripts**: when a block contains `>>> ` lines, only the `>>>` and `...` lines are kept, prompts removed; output lines are dropped.

Python examples are resolved like code, cumulatively per page. The page's Python blocks are concatenated in order and parsed as one throwaway module; calls in each block are attributed to that block, but names resolve through everything above it. A later fragment that calls `g.query(...)` resolves through an earlier block's `g = db.select_graph(...)`. Each call becomes a `USES` edge (with `resolved`, the line and the call text) to a symbol in a repository with Python code. Definitions inside docs examples never become by-name candidates for anything else.

When a mention or call has several candidates and not all are exact, the page's own exact uses decide: by-name candidates are kept only if they (or their class) are among the symbols the page's examples reach exactly. If that keeps nothing, all candidates stay.

Example scripts (`examples/*.py` and the like) are one `CodeExample` each, id `<repo>:<path>:0`, `kind: 'script'`, with no section; they are resolved on their own, not cumulatively.

Examples in other languages are indexed (code, identifiers) but get no `USES` edges, so they are never reached by an impact walk through calls and never run.

### Links

Links between doc sections become `LINKS_TO` edges, the input to [ranking](concepts.md#ranking). The scanner reads Markdown links `[text](target)` and `href="..."` attributes outside headings and fences.

- Targets with a scheme (`https:`, `mailto:`) are skipped.
- `#anchor` points into the same page. A path starting with `/` is relative to the repository root (site routes such as `/cypher/match`); anything else is relative to the linking file.
- The target file is the first indexed page among: the path as written, the path with `.mdx` or `.md` (after dropping a trailing `/` and any `.md`, `.mdx` or `.html`), and `<path>/index.mdx`, `<path>/index.md`, `<path>/README.md`.
- If the anchor exists on that page, the link points to that section; otherwise to the page's first section.
- Links resolve only within the same repository, and self-links are dropped.

## Repository dependencies

`DEPENDS_ON` edges say which repository builds on which. They decide what gets installed for an [example run](example-runner.md) and which repositories may [late-link](concepts.md#resolution) to a removed symbol.

- **Declared**: every tracked `pyproject.toml` and `requirements*.txt`, in any directory, is read: `[project].dependencies`, all optional dependency groups, and `[tool.poetry.dependencies]`. A dependency whose normalised name (PEP 503) is the distribution name of another repository in the graph becomes an edge, `spec: "declares <name>"`.
- **Docs that import a package**: for Markdown pages, every Python example line `import pkg` or `from pkg... import` adds an edge from the docs repository to each repository that defines `pkg`, `spec: "examples import <pkg>"`, unless a declared edge already exists.

On FalkorDB's repositories this gives three edges ([FACTS](FACTS.md#repository-dependencies)): GraphRAG-SDK declares `falkordb`, and the docs site's examples import both `falkordb` and `graphrag_sdk`.

`setup.py` and `setup.cfg` are not read, and TOML files that fail to parse are ignored.

## Re-indexing

Re-running `index` is safe and idempotent, and it never deletes nodes.

- **Merged in place**: `Repo`, `File`, `Symbol`, `DocSection` and `CodeExample` nodes are matched by id and their properties refreshed.
- **Marked `gone`**: a repository's symbols, sections and examples that this run did not see get `status: 'gone'`. They stay in the graph, so verdicts, decisions and runs that point at them keep their history. Impact walks only reach `live` docs. A symbol recreated as `removed` by a pull request returns to `live` if it reappears in the code. `File` nodes are never marked gone.
- **Deleted and rebuilt**: the repository's outgoing `CALLS` edges, and every `MENTIONS`, `USES` and `LINKS_TO` edge from its sections and examples. This includes the `late` edges pull request ingestion created; because a pull request is ingested only once, those late links are not restored.
- **Kept**: `DEPENDS_ON` edges are never deleted. Pull requests, verdicts, decisions, runs and checks are not touched.

A section's id comes from its heading, so renaming a heading (or moving the file) gives the section a new id. The old one is marked `gone`, and decisions or verdicts attached to it stay on the old id.

Because the symbol table holds only the repositories in the current command, re-indexing one repository alone re-resolves its outgoing edges against that repository only: its calls into other repositories and its docs' links into other repositories disappear. Re-index repositories together. Indexing on first use (`check`, MCP) indexes the pull request's repository with the `--with` repositories only, and the GitHub Action's `reindex` input re-indexes the pull request's repository with its `also-index` repositories only; see [GitHub Action](github-action.md). A hosted workspace is always re-indexed whole.

## The index report

`index --json` prints the `IndexReport`:

| Field | Meaning |
|---|---|
| `org` | The graph name |
| `run` | The run id (`idx-…`) |
| `repos[]` | Per repository: `repo`, `sha`, `files` (indexed files of any kind), `symbols`, `calls` (`exact`, `byName`, `crossRepo`: edges whose target is in another repository), `gone` (symbols marked gone by this run), `parseErrors` |
| `docs[]` | Per repository with pages or example scripts: `repo`, `pages`, `sections`, `examples` (`total`, `python`), `mentions`, `uses` (`exact`, `byName`), `links`, `gone` (sections and examples marked gone) |
| `dependsOn[]` | `from`, `to`, `spec` |
| `ms` | Wall time |

Without `--json` the CLI prints one line per repository's code, one per repository's docs, and one per dependency, in this format (columns are padded):

```text
Indexed <n> repositories into graph "<org>" in <seconds>s

  <owner/name>  <sha7>  <symbols> symbols  <calls> calls (<cross-repo> cross-repo)  [<n> parse errors]
  <owner/name>  docs  <sections> sections  <examples> examples  <uses> uses  <mentions> mentions  <links> links
  <from> → <to> (<spec>)
```

## Resolution quality on FalkorDB's repositories

From [FACTS](FACTS.md#resolution-quality), generated from the graph of the three repositories:

| Repository | Symbols | Doc sections | Code examples (Python) |
|---|---:|---:|---:|
| FalkorDB/GraphRAG-SDK | 1016 | 513 | 313 (252) |
| FalkorDB/docs | 0 | 2618 | 1517 (165) |
| FalkorDB/falkordb-py | 282 | 7 | 5 (2) |

- `CALLS` edges: 1,708, of which 1,655 exact and 53 by name; 5 of them cross a repository boundary.
- `USES` edges from code examples: 716, of which 633 exact and 83 by name.
- `MENTIONS` edges: 594; `LINKS_TO` edges: 644.
- Symbol-to-doc paths within 3 call hops that cross a repository boundary: 1,257.

Only 5 call edges cross repositories, yet 1,257 symbol-to-doc paths do: the docs site has no code of its own, and its examples call the client and the SDK directly.

## Limits

- **Python code only.** Code repositories are parsed as Python. Docs can be any Markdown or MDX, but examples in other languages (JavaScript, TypeScript, Cypher, shell) are indexed without being linked to code or run.
- **Index together for cross-repository edges.** Edges between repositories exist only when the repositories are indexed in one command; indexing one alone drops its edges into the others.
- **Static resolution.** Calls the types do not reveal fall back to labelled by-name edges inside imported repositories, or to no edge.
- **Late links do not survive a re-index** of the docs repository that holds them.
- **GitHub only.** Repositories are cloned or downloaded from github.com. Private repositories need `GITHUB_TOKEN` (or `GH_TOKEN`) with read access; a hosted server indexes what its own token can read.
- **Docs syntax**: ATX headings only; links resolve within one repository; section bodies are stored up to 8000 characters and example code up to 20000.
- **Not read**: notebooks, reStructuredText, `setup.py` and `setup.cfg` dependencies.

## Related

- [Core concepts](concepts.md): the graph, ids, resolution and confidence
- [Example runner](example-runner.md): what the `USES` edges and `DEPENDS_ON` edges are used for
- [CLI](cli.md): `index` and its options
- [Graph model and Cypher](GRAPH-MODEL.md#indexing): every indexing query
- [Facts from the graph](FACTS.md): the numbers above, regenerated from the graph
