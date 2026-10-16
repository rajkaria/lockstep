# Indexing

This page explains what `staleproof index` reads from your repositories and how it turns them into the graph: which files count, how Python, TypeScript and JavaScript are parsed, how calls are resolved across repositories, how Markdown, MDX and reStructuredText sections, inline code and code examples are linked to the code, how each example is checked against the code it calls, how docs mark examples not to run, how repository dependencies are found, and what a re-index keeps and replaces. Read it if you maintain the repositories being indexed, or want to know why an edge exists (or does not).

## Index your organisation

Index every repository that shares code or docs in one command. Cross-repository edges only exist between repositories indexed together.

```bash
npx -y staleproof index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
```

Each argument is `owner/name`, `https://github.com/owner/name` (with or without `.git`) or `git@github.com:owner/name.git`. The graph is the one named by `--org` or `STALEPROOF_ORG`, else the owner of the first repository (`falkordb` here), on the server named by `--db` or `FALKORDB_URL`; see [Configuration](configuration.md). Add `--json` to print the full [index report](#the-index-report) instead of the summary.

You do not have to run `index` before a first check: `staleproof check` (with or without a pull request), `staleproof audit <repos>`, the MCP tools `check_pull_request`, `impact`, `clearance`, `check_changes`, `docs_for_symbol` and `audit_docs`, and a hosted server index a repository the first time they see it, at its default branch head (`check --with` adds the repositories to index with it). Run `index` yourself to index several repositories together, to pick a ref, or to move the graph to newer commits.

Progress goes to stderr, one line per phase: `checkout`, `parse`, `write`, `resolve`, `docs` and `done`.

## The pipeline

1. **Checkout**: each repository is cloned or fetched, or downloaded as a tarball where there is no git (see [Checkouts](#checkouts)).
2. **Parse**: every Python library file, and every TypeScript and JavaScript file of a published npm package, of every repository is parsed. The repository's [configuration](configuration.md#repository-configuration) is read first, and its `ignore` paths are left out.
3. **Symbol table**: one table is built over all the parsed repositories, so a call in one repository can resolve into another.
4. **Write and resolve**: `Repo`, `File` and `Symbol` nodes are written, then each repository's `CALLS` edges are resolved against the whole table.
5. **Docs**: for each repository with Markdown, MDX or reStructuredText pages or example scripts, `DocSection` and `CodeExample` nodes are written and linked to the code with `MENTIONS`, `USES` and `LINKS_TO`, and every example line that no longer fits the code it calls becomes a `MISMATCH` edge ([Static checks of examples](#static-checks-of-examples)).
6. **Dependencies**: `DEPENDS_ON` edges between repositories are written.

Every run first creates the exact-match indexes the queries rely on (already-existing indexes are fine) and gets a run id such as `idx-20261016225012-k3f9`, stored as `seen` on every node it writes. Writes are batched 400 rows at a time. Each `Repo` node records the index format it was written with (`index_version`, 3 since Staleproof 0.3, which added `MISMATCH` edges, `exported` flags, reStructuredText and TypeScript/JavaScript): the [audit](audit.md#limits) says when a graph is older, and a hosted workspace written by an older version is indexed again on its next use.

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
- **What is extracted**: only the files the indexer reads, by the rules in the next section, plus every `pyproject.toml`, `requirements*.txt` and `package.json`; paths with a component starting with `.` are skipped, except a root `.staleproof.toml`. They go to `<STALEPROOF_HOME>/tarballs/<owner>/<name>/<sha>`, and a directory walk replaces `git ls-files`.
- **Limits**: a compressed archive over 150 MB, or more than 4000 extracted files (3000 on a hosted server), is refused with `<repo> is too large to index from an archive here (...)` and the command to run it locally.

Example runs and the text-match counts of `clearance` still need a git clone, so a host without git indexes and checks but runs no examples.

## Which files are indexed

Each tracked path is classified by these rules, in order:

| Rule | Paths | Result |
|---|---|---|
| 1 | Anywhere under `.github/`, `node_modules/`, `venv/`, `.venv/`, `build/`, `dist/`, `site-packages/`, `__pycache__/`, `.tox/`, `.mypy_cache/` | Skipped |
| 2 | `.md`, `.mdx` and `.rst` files | Doc pages, except housekeeping files (names starting with `CHANGELOG`, `CHANGES`, `HISTORY`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`, `SUPPORT`, `AGENTS`, `CLAUDE`, `GEMINI`, `LICENSE`, `NOTICE`, `PULL_REQUEST_TEMPLATE`, `ISSUE_TEMPLATE`, any case) and pages under `test/`, `tests/`, `testing/` or `fixtures/`, which are skipped |
| 3 | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` files | Tests and tooling are skipped: under `__tests__/`, `__mocks__/`, `test/`, `tests/`, `test-utils/`, `e2e/`, `cypress/`, `playwright/`, `fixtures/`, `coverage/`, `out/`, `.next/`, `.docusaurus/` or `.vitepress/`; named `*.test.*`, `*.spec.*`, `*.stories.*`, `*.bench.*`, `*.d.ts`, `*.min.js` or `*.config.*`. Under `example/`, `examples/`, `sample/` or `samples/`: example scripts. Under `script/`, `scripts/`, `benchmark/`, `benchmarks/`, `docs/`, `site/` or `website/`: skipped. Everything else is library code, kept only when it belongs to a published npm package ([TypeScript and JavaScript](#typescript-and-javascript)) |
| 4 | Anything else that is not `.py` | Skipped (notebooks, for example) |
| 5 | Tests: under `test/`, `tests/` or `testing/`, or named `test_*.py`, `*_test.py`, `conftest.py` | Skipped |
| 6 | `setup.py`, `noxfile.py`, `fabfile.py` | Skipped |
| 7 | Under `example/`, `examples/`, `sample/`, `samples/`, `tutorial/`, `tutorials/`, `notebook/`, `notebooks/` | Example scripts (indexed as code examples, not library code) |
| 8 | Under `script/`, `scripts/`, `benchmark/`, `benchmarks/`, `docs/` | Skipped |
| 9 | Everything else ending in `.py` | Python library code |

Then the repository's `ignore` globs ([Repository configuration](configuration.md#repository-configuration)) drop any file they match.

Rule 7 runs before rule 8, so `docs/examples/quickstart.py` is an example script. Example scripts are how examples shipped inside a code repository (such as GraphRAG-SDK's `graphrag_sdk/examples/*.py`, or a package's `examples/quickstart.js`) become docs.

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
- `exported`: whether the repository's packages export it. In Python: a name bound in a public package's `__init__.py` (or a top-level module) that resolves to the organisation's definitions, following `from .x import *` and imports from private modules (`httpx._api.get` is exported as `httpx.get`), plus the public methods of exported classes and of their base classes in the organisation. A package with a module-level `__getattr__` (PEP 562 lazy exports) gets no export flags, because its source does not show what it offers. The [audit](audit.md#api-coverage) measures API coverage over exported symbols.
- `path`, `lineno`, `end_lineno`.

## TypeScript and JavaScript

TypeScript and JavaScript are parsed with the vendored tree-sitter grammars `grammars/tree-sitter-typescript.wasm` (`.ts`, `.mts`, `.cts`) and `grammars/tree-sitter-tsx.wasm` (`.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`), into the same shape as Python, so one resolver and one graph serve both.

- **Packages.** Every `package.json` outside `node_modules/` that has a `name` and is not `private` is a published package. A file belongs to the nearest enclosing package directory, so monorepos with several packages work. Files in no published package (a docs site, an app, build tooling) are not library code and are not indexed.
- **Module names.** `js-<package>` plus the path inside the package, with a leading `src/` dropped and `index` files naming their directory: `packages/core/src/graph/client.ts` of `@acme/core` is `js-acme-core.graph.client`. The `js-` prefix keeps an npm `falkordb` apart from the Python `falkordb`; messages show the npm name (`@acme/minigraph`). The package's own name resolves to its entry file (from `source`, `types`, `module`, `exports["."]` or `main`, mapped from `dist/`, `lib/` or `build/` back to `src/`, with `src/index.ts` and `index.js` as fallbacks), which it re-exports.
- **Symbols.** Classes, functions (declarations and `const f = () => …`), methods (the constructor is `constructor`, visibility `special`; getters are recorded as properties), with their signatures and return types. Methods marked `private`, `protected` or `#name` and top-level declarations that are not exported are `private`.
- **Imports and calls.** ES `import` and `export` (named, default, `* as ns`, re-exports and `export *`), `require(...)` with destructuring, relative imports resolved to the files they name (`./graph`, `./graph.js`, `../util/index`), typed bindings and `this.x` fields, `new Client()`, and structural callees such as `this.graph.query()`. `Promise<…>`, arrays and `| null` are unwrapped from types.
- **Exports.** Only what a module says it exports counts; the package's API is what its entry file exports, through re-exports.
- **Dependencies.** `dependencies`, `peerDependencies` and `devDependencies` that name another indexed package become `DEPENDS_ON` edges.

Arguments are not recorded: JavaScript accepts any argument count, so JavaScript and TypeScript calls are checked only for names that do not exist, never for arity ([Static checks of examples](#static-checks-of-examples)).

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

Markdown and MDX pages are read with a tolerant line scanner, not a strict MDX parser: real docs sites (Mintlify components, stray braces) break strict parsers, and only headings, fenced code, inline code and links are needed. reStructuredText pages have a scanner of their own with the same output ([below](#restructuredtext-sphinx)).

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

Each accepted identifier is matched against symbols in repositories that have code (never a module):

- **Dotted names** resolve exactly through modules and re-exports (`falkordb.FalkorDB`). Otherwise symbols whose qualified name ends with `.Graph.ro_query` match by name, if there are 1 to 4. A dotted name starting with a lowercase variable that is not a package (`db.select_graph()`) falls back to its last part.
- **Bare names** link only when they look like code (called, or containing `_` or a capital), are at least 3 characters, are not generic, do not start with `_`, and are not properties. They link only into the repositories the page is about: the page repository's own packages, the packages its Python, JavaScript and TypeScript examples import, and the packages named in its install commands (`pip install graphrag-sdk`) or inline code (`falkordb`). Again only with 1 to 4 candidates.

The section also stores every identifier it named (and each one's last part) in `idents`. Pull request ingestion uses them to [late-link](concepts.md#resolution) symbols that were removed before the graph was indexed.

### Code examples

Every fenced block (backticks or tildes, any language) is a `CodeExample`, with id `<repo>:<path>:<index>` where `index` counts all fenced blocks in the file from 0 (in reStructuredText, every code block the scanner finds). It is placed in the section that contains its opening fence (`IN_SECTION`). Details:

- **Language**: the info string, normalised: `py`, `python3`, `py3`, `pycon` become `python`; `sh`, `shell`, `zsh`, `console` become `bash`; `js` becomes `javascript`; `ts` becomes `typescript`.
- **Indentation**: code inside an indented fence (common in MDX components) is dedented. An unclosed fence runs to the end of the file and is kept.
- **Size**: the stored code is truncated to 20000 characters.
- **REPL transcripts**: when a block contains `>>> ` lines, only the `>>>` and `...` lines are kept, prompts removed; output lines are dropped.

Python examples are resolved like code, cumulatively per page. The page's Python blocks are concatenated in order and parsed as one throwaway module; calls in each block are attributed to that block, but names resolve through everything above it. A later fragment that calls `g.query(...)` resolves through an earlier block's `g = db.select_graph(...)`. Each call becomes a `USES` edge (with `resolved`, the line and the call text) to a symbol in a repository with code. Definitions inside docs examples never become by-name candidates for anything else.

When a mention or call has several candidates and not all are exact, the page's own exact uses decide: by-name candidates are kept only if they (or their class) are among the symbols the page's examples reach exactly. If that keeps nothing, all candidates stay.

JavaScript and TypeScript examples (fences tagged `js`, `javascript`, `ts`, `typescript`, `jsx`, `tsx`, `mjs`, `cjs` or `node`) resolve the same way, cumulatively per page in their own throwaway module, against the organisation's npm packages: `import { Client } from 'falkordb'` and `require('falkordb')` reach the package `js-falkordb`. They get `USES` edges and static checks, but are never run.

Example scripts (`examples/*.py`, `examples/*.js`, `examples/*.ts` and the like) are one `CodeExample` each, id `<repo>:<path>:0`, `kind: 'script'`, with no section; they are resolved on their own, not cumulatively.

Examples in other languages (shell, Cypher, …) are indexed (code, identifiers) but get no `USES` edges, so they are never reached by an impact walk through calls and never run.

Each `CodeExample` stores `directive`: empty, `skip` or `expect-error` ([Example directives](#example-directives)).

### reStructuredText (Sphinx)

`.rst` pages are read with a tolerant line scanner that produces the same sections, examples, inline code and links as the Markdown scanner, so Sphinx docs (requests, Flask, …) link to code like Markdown docs do. Unknown directives never fail a page.

- **Titles**: an unindented line underlined, or overlined and underlined, with one punctuation character repeated at least 3 times. Levels follow the order in which each style first appears on the page, as in docutils. The first title is the page title (else the file name). Anchors are slugs of the title, duplicates numbered.
- **Code examples**: `.. code-block:: <lang>`, `.. code::` and `.. sourcecode::` (in their language, else the page's `.. highlight::` language, default Python); `.. testcode::`, `.. doctest::`, `.. testsetup::`, `.. ipython::` and `.. jupyter-execute::` (always Python); `::` literal blocks (Python when the default language is Python and the block looks like Python code, `bash` when it has `$ ` prompts, else `text`); and `>>>` doctest paragraphs. Directive options (`:linenos:`, `:caption:`) are skipped. `meta` records the directive (`testcode`, `doctest`, `literal`, …).
- **Inline code**: ` ``literals`` ` and the API roles `:func:`, `:meth:`, `:class:`, `:attr:`, `:obj:`, `:exc:`, `:data:`, `:const:`, `:any:` (also with `:py:`), with `~` and `!` prefixes and `Title <target>` forms handled; `:func:` and `:meth:` targets count as calls. `:mod:` is not a mention. These become `MENTIONS` like inline code in Markdown.
- **Links**: `` :doc:`path` `` is a page link (an absolute `/user/quickstart` is relative to the docs source directory, so it is matched against any indexed page ending in `user/quickstart.rst`, `.md` or `.mdx`); `` :ref:`label` `` points at the section a `.. _label:` line precedes on the same page.
- **Skip markers**: `.. staleproof: skip`, `.. staleproof: expect-error` and Sybil's `.. skip: next` before a block ([Example directives](#example-directives)).
- **Not followed**: `.. include::` and the autodoc directives (`.. autofunction::`, `.. autoclass::`): the text Sphinx generates from docstrings is not in the source. Text before the first title that holds only labels and directives is not a section.

### Links

Links between doc sections become `LINKS_TO` edges, the input to [ranking](concepts.md#ranking). The scanner reads Markdown links `[text](target)` and `href="..."` attributes outside headings and fences.

- Targets with a scheme (`https:`, `mailto:`) are skipped.
- `#anchor` points into the same page. A path starting with `/` is relative to the repository root (site routes such as `/cypher/match`); anything else is relative to the linking file.
- The target file is the first indexed page among: the path as written, the path with `.mdx`, `.md` or `.rst` (after dropping a trailing `/` and any `.md`, `.mdx`, `.rst` or `.html`), and `<path>/index.mdx`, `<path>/index.md`, `<path>/index.rst`, `<path>/README.md`. For a reStructuredText page, or an absolute path that finds nothing, any page whose path ends in the target (with one of those extensions) is used, since Sphinx paths are relative to the docs source directory rather than the repository.
- If the anchor exists on that page, the link points to that section; otherwise to the page's first section.
- Links resolve only within the same repository, and self-links are dropped.

## Static checks of examples

While linking each example, the indexer checks its calls and imports against the code they resolve to, in any repository of the run, and records every line that no longer fits as a `MISMATCH` edge from the `CodeExample` to the symbol concerned (the callee, or the module or class that lacks the name). The edge stores `kind`, `name`, `detail` (the sentence shown to people), `line` (the line in the doc file) and `text` (the callee or import as written). Nothing runs. The [audit](audit.md) lists them, a pull request check shows the impacted ones as already out of date, and [`docs_for_symbol`](tools.md#docs_for_symbol) shows the ones on the docs it returns.

| Kind | What the line does | Detail, from the test fixtures | Checked in |
|---|---|---|---|
| `unknown-keyword` | Passes a keyword the signature does not have | `` `Client` has no parameter `hostname` `` | Python |
| `too-many-arguments` | Passes more positional arguments than the signature takes | `` `Graph.query` takes at most 2 positional arguments; the example passes 3 `` | Python |
| `missing-argument` | Leaves out a required argument | `` `Graph.query` requires `timeout`, which the example does not pass `` | Python |
| `missing-import` | Imports from an organisation package a name no module there defines or binds | `` `miniclient` has no `connect` ``, `` `@acme/minigraph` has no `Gone` `` | Python, JavaScript, TypeScript |
| `missing-attribute` | Calls a method or function a module or class does not have | `` `Graph` has no attribute `read_only` ``, `` `Graph` has no attribute `readOnly` `` | Python, JavaScript, TypeScript |

The checks only report what the source settles, so that a reported line fails the same way when run:

- **Exact resolutions only.** A call is judged only when its callee resolved exactly, through imports, types and re-exports. A by-name or unresolved call is never judged.
- **Signatures that can be trusted.** Argument checks need one definition under the name in its repository (no `@overload` stubs or conditional definitions), a readable signature, no `@property`, and only decorators known to keep the signature: `staticmethod`, `classmethod`, `abstractmethod`, `override`, `final`, `cache`, `lru_cache`, `deprecated` and `wraps`, also with their `functools.`, `typing.`, `typing_extensions.`, `abc.` or `warnings.` prefixes. Any other decorator (a click command, a retry wrapper) may change what the function accepts, so its calls are left alone.
- **Constructors.** A call to a class checks its `__init__` (searched through base classes), without `self`, unless the class has a `__new__` (its own or a base's) or is not closed (next rule). A method called on an instance or a `classmethod` drops its first parameter; a method called through the class, or a `staticmethod`, does not.
- **Closed classes and modules.** A missing attribute is reported only on a class whose members are all visible: no class decorators, no metaclass, no `__getattr__` or `__getattribute__`, and every base class in the organisation (or one of `object`, `ABC`, `Generic`, `Protocol`), recursively. A name counts as present when it is a method, a class-level assignment or annotation, or a `self.<name> = …` in any method, here or in a base class. A module must have no module-level `__getattr__` and no star import from outside the organisation, and a name it imports, assigns or star-imports from the organisation counts as present. Names starting with `__` are never judged.
- **Splats.** `f(*args)` makes the positional count unknown (no `too-many-arguments` or `missing-argument`); `f(**options)` makes the keywords unknown (no `missing-argument`). A signature with `*args` takes any number of positional arguments, and one with `**kwargs` any keyword.
- **Imports.** Only imports from the organisation's own packages are judged; `from x import *` lines are skipped.
- **Marked examples.** Examples with a `skip` or `expect-error` directive, and examples matched by `skip-examples`, are linked but not checked.

The `index` summary adds `<n> mismatches (staleproof audit <repo>)` to each docs repository's line, and the [index report](#the-index-report) has the count per repository.

### Example directives

Docs can mark an example as not runnable or as failing on purpose. A marked example is still linked to the code (impact still reaches its section, and its bindings serve the examples after it on the page), but it is never run, never statically checked and never predicted to break.

| Where | `skip` | `expect-error` |
|---|---|---|
| Markdown comment on a line before the fence (blank lines in between are fine) | `<!-- staleproof: skip -->`, `no-run` or `ignore` in place of `skip` | `<!-- staleproof: expect-error -->` or `raises` |
| MDX comment before the fence | `{/* staleproof: skip */}` | `{/* staleproof: expect-error */}` |
| A word in the fence's info string, such as ` ```python skip ` | `skip`, `no-run`, `norun`, `staleproof:skip`, `staleproof-skip` | `expect-error`, `staleproof:expect-error`, `raises` |
| Markers other docs-testing tools use | `<!-- pytest-codeblocks:skip -->`, Sybil's `<!-- skip: next -->` | `<!-- pytest-codeblocks:expect-exception -->` |
| reStructuredText comment before the block | `.. staleproof: skip` (or `no-run`, `ignore`), Sybil's `.. skip: next` | `.. staleproof: expect-error` (or `raises`) |

A comment counts only when it is the nearest non-blank line above the block: prose in between cancels it. Case does not matter. Whole pages or directories are marked with `skip-examples` in the repository's [configuration](configuration.md#repository-configuration).

## Repository dependencies

`DEPENDS_ON` edges say which repository builds on which. They decide what gets installed for an [example run](example-runner.md) and which repositories may [late-link](concepts.md#resolution) to a removed symbol.

- **Declared**: every tracked `pyproject.toml` and `requirements*.txt`, in any directory, is read: `[project].dependencies`, all optional dependency groups, and `[tool.poetry.dependencies]`. A dependency whose normalised name (PEP 503) is the distribution name of another repository in the graph becomes an edge, `spec: "declares <name>"`.
- **npm packages**: every `package.json` outside `node_modules/` is read the same way: its `dependencies`, `peerDependencies` and `devDependencies` that name another indexed npm package become edges, `spec: "declares js-<name>"`.
- **Docs that import a package**: for doc pages, every Python example line `import pkg` or `from pkg... import`, and every JavaScript or TypeScript `from 'pkg'` or `require('pkg')`, adds an edge from the docs repository to each repository that defines `pkg`, `spec: "examples import <pkg>"` (`js-<name>` for npm packages), unless a declared edge already exists.

On FalkorDB's repositories this gives three edges ([FACTS](FACTS.md#repository-dependencies)): GraphRAG-SDK declares `falkordb`, and the docs site's examples import both `falkordb` and `graphrag_sdk`.

`setup.py` and `setup.cfg` are not read, and TOML files that fail to parse are ignored.

## Re-indexing

Re-running `index` is safe and idempotent, and it never deletes nodes.

- **Merged in place**: `Repo`, `File`, `Symbol`, `DocSection` and `CodeExample` nodes are matched by id and their properties refreshed.
- **Marked `gone`**: a repository's symbols, sections and examples that this run did not see get `status: 'gone'`. They stay in the graph, so verdicts, decisions and runs that point at them keep their history. Impact walks only reach `live` docs. A symbol recreated as `removed` by a pull request returns to `live` if it reappears in the code. `File` nodes are never marked gone.
- **Deleted and rebuilt**: the repository's outgoing `CALLS` edges, and every `MENTIONS`, `USES`, `LINKS_TO` and `MISMATCH` edge from its sections and examples. This includes the `late` edges pull request ingestion created; because a pull request is ingested only once, those late links are not restored.
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
| `docs[]` | Per repository with pages or example scripts: `repo`, `pages`, `sections`, `examples` (`total`, `python`), `mentions`, `uses` (`exact`, `byName`), `links`, `mismatches` (example lines that no longer fit the code: `MISMATCH` edges), `gone` (sections and examples marked gone) |
| `dependsOn[]` | `from`, `to`, `spec` |
| `ms` | Wall time |

Without `--json` the CLI prints one line per repository's code, one per repository's docs, and one per dependency, in this format (columns are padded):

```text
Indexed <n> repositories into graph "<org>" in <seconds>s

  <owner/name>  <sha7>  <symbols> symbols  <calls> calls (<cross-repo> cross-repo)  [<n> parse errors]
  <owner/name>  docs  <sections> sections  <examples> examples  <uses> uses  <mentions> mentions  <links> links  [<n> mismatches (staleproof audit <owner/name>)]
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

- **Python, TypeScript and JavaScript.** Code in other languages is not parsed. TypeScript and JavaScript count only inside a published npm package; their calls get no argument checks (JavaScript accepts any count) and their examples are linked and checked but never run. Examples in other languages (Cypher, shell) are indexed without being linked to code.
- **Static checks follow exact resolutions.** A call reached by name, or not resolved, is never judged; neither is anything behind a decorator outside the allow-list, a dynamic class or module, or a splat.
- **reStructuredText is read by a line scanner**, not by Sphinx: `.. include::`, autodoc output, substitutions and Sphinx extensions are not expanded, and `:ref:` links resolve within one page.
- **Index together for cross-repository edges.** Edges between repositories exist only when the repositories are indexed in one command; indexing one alone drops its edges into the others.
- **Static resolution.** Calls the types do not reveal fall back to labelled by-name edges inside imported repositories, or to no edge.
- **Late links do not survive a re-index** of the docs repository that holds them.
- **GitHub only.** Repositories are cloned or downloaded from github.com. Private repositories need `GITHUB_TOKEN` (or `GH_TOKEN`) with read access; a hosted server indexes what its own token can read.
- **Docs syntax**: ATX headings only in Markdown; links resolve within one repository; section bodies are stored up to 8000 characters and example code up to 20000.
- **Not read**: notebooks, `setup.py` and `setup.cfg` dependencies.

## Related

- [Core concepts](concepts.md): the graph, ids, resolution and confidence
- [Example runner](example-runner.md): what the `USES` edges and `DEPENDS_ON` edges are used for
- [CLI](cli.md): `index` and its options
- [Graph model and Cypher](GRAPH-MODEL.md#indexing): every indexing query
- [Facts from the graph](FACTS.md): the numbers above, regenerated from the graph
