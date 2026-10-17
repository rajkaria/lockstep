# Release gate

`staleproof release` checks a release before it goes out: which public API changes since the last tag break callers, whether the changelog says so, which docs still call or name what changed, and what lint finds at the release commit. It compares two commits of your clone with no graph and no network, and fails the job when a breaking change is missing from the changelog or the docs still rely on it. This page covers running it, what counts as a breaking change, how the changelog is read, the report and exit status, the GitHub Action's release mode, results on real releases, and limits. It is for maintainers who cut releases and want the changelog and docs to match what the release really changes.

## Run it

```bash
npx -y staleproof release
```

In a clone with tags this compares `HEAD` with the latest tag reachable from it. When `HEAD` itself carries a tag (a `release: published` run), the tag before it is used, and a stable release skips prereleases (`v13.0.0` is compared with `v12.1.0`, not `v13.0.0-0`).

```text
staleproof release [dir] [--from <ref>] [--to <ref>] [--changelog <file>] [--fail-on <gates>] [--format text|markdown|json] [--out <file>] [--repo <owner/name>]
```

| Option | Default | Meaning |
|---|---|---|
| `--from <ref>` | the latest tag reachable from `--to`, not on it | The previous release: a tag, branch or commit of the clone |
| `--to <ref>` | `HEAD` | The release |
| `--changelog <file>` | the first of `CHANGELOG.md`, `CHANGES.md`, `HISTORY.md`, `NEWS.md`, `RELEASES.md`, `CHANGELOG.rst`, `CHANGES.rst`, `HISTORY.rst`, `CHANGELOG`, `docs/changelog.md` at `--to` | The changelog to read |
| `--fail-on <gates>` | `undocumented-breaking,stale-docs` | Which gates fail the run, comma-separated, or `never` to only report |
| `--format <format>` | `text` | `text`, `markdown` (the Action's job summary) or `json` |
| `--out <file>` | stdout | Write the report to a file |
| `--repo <owner/name>` | from the `origin` remote | The repository's name in the report and links |

Nothing is fetched: both commits must be in the clone (`git fetch --tags` first; in CI, `actions/checkout` with `fetch-depth: 0`).

## What counts as a breaking change

Only the public API, as of the previous release, and only changes that make a call that used to work fail:

| Change | Reported as |
|---|---|
| A public function, class or method is gone | `removed` |
| It is gone and a twin with the same parameters appeared | `renamed to <new name>` |
| A package stops re-exporting a name (`from pkg import X` breaks) | `no longer exported from <package>` |
| Fewer positional parameters, with no `*args` / rest parameter | `takes at most N positional arguments (was M)` |
| A parameter a caller could pass by keyword is gone (Python, no `**kwargs`) | `` `timeout` is no longer a parameter `` or `` parameter `timeout` renamed to `deadline` `` |
| A parameter became keyword-only or positional-only (Python) | `` `x` is keyword-only now ``, `` `x` can no longer be passed by keyword `` |
| A new required parameter, or an optional one became required | `` new required parameter `key` ``, `` `x` is required now `` |
| Two positional parameters swapped places (Python) | `` positional order changed: `verify` now comes before `cert` `` |
| `*args` or `**kwargs` dropped | `no longer takes *args` |

JavaScript, TypeScript and Go are judged by position only (their callers pass no keywords): fewer parameters, more required ones, a rest parameter dropped.

**Public API** is what the packages export, as the [audit](audit.md#api-coverage) defines it: names a public package's `__init__.py` binds (Python honours `__all__` here: a helper `from ._client import *` does not export is not public), what a published npm package's entry exports, capitalised Go names outside `internal/`, plus the public methods and constructors of exported classes. When a package exports nothing its source shows (an empty `__init__.py`, lazy `__getattr__` exports), naming decides: no `_` in the path, not under `tests/`, `scripts/`, `examples/` or `docs/`.

**Not judged**, counted as compatible instead: added parameters with defaults, properties and their setters (they are not called), and functions with a decorator that may rewrite the signature (anything but `staticmethod`, `classmethod`, `functools.wraps`, `lru_cache` and the like). A removed class is reported once, not once per method.

## The changelog

The gate reads the changelog at `--to` (or, when checking `HEAD` with no `--to`, the copy on disk if you have edited it and not committed yet) and picks the section for this release:

1. the heading naming the release's version, when `--to` is a version tag or carries one (`## [2.0.0] - 2026-10-01`, `Version 3.1.0` underlined in reStructuredText);
2. else the first section when it is `Unreleased` (or "Upcoming", "Next release") and not empty;
3. else the top release section, unless its version is the previous release's (then the release has no section yet, and every breaking change is undocumented).

Markdown (ATX `##` and setext underlines) and reStructuredText headings are read; headings inside code fences are not.

A breaking change is **in the changelog** when the section names the symbol (its full name, `Class.member`, or its bare name as a word), or, for a signature change, every parameter it changed, written as code (`` `proxies` ``), as `proxies=`, or as "the proxies argument". The report shows what matched. Mentioning is not judged for meaning: a changelog that calls a removed parameter "deprecated" still names it.

## Docs that still rely on the change

[Lint](lint.md) runs on both commits. A finding at `--to` that `--from` did not have, about a symbol the release removed or changed incompatibly, is a docs reference the release broke: an example still passing `retries=` to a function that now takes `attempts=`, an example calling a removed method, a code span naming a removed class. Findings that were already there at the previous release are not this release's doing and do not count.

## The report

```text
Release acme/minipkg: v1.0.0 (a5b95a9) → HEAD (01ffad7) (from: the latest tag reachable from HEAD)
Changelog: CHANGELOG.md, the section for this version "2.0.0 - 2026-10-01" (line 5)

Breaking API changes (2); 1 other public signature changed compatibly
  ✓ minipkg.client.Client.close: removed  (changelog: "Client.close")
  ✗ minipkg.client.connect: parameter `retries` renamed to `attempts`  (not in the changelog)

Docs still relying on them (2)
  docs/guide.md:6  `connect` has no parameter `retries`. [example-unknown-keyword]
  docs/guide.md:8  `Client` has no attribute `close`. [example-missing-attribute]

Docs references at HEAD (01ffad7): 2 findings in 1 file checked, 2 new since v1.0.0 (a5b95a9)
  docs/guide.md:6  error  `connect` has no parameter `retries`. [example-unknown-keyword] (new)
  docs/guide.md:8  error  `Client` has no attribute `close`. [example-missing-attribute] (new)

Release gate (--fail-on undocumented-breaking,stale-docs): fails: 1 breaking change is not in the changelog; 2 docs references still rely on what changed.
```

`--format markdown` writes the same as tables, starting with `<!-- staleproof-release -->` and ending with a counts line for CI: `<!-- staleproof:release breaking=2 undocumented=1 stale=2 findings=2 new-errors=0 failed=2 -->` (`new-errors`: new error-level findings besides the stale references). `--format json` is the whole report (`version: 1`).

**Gates.** `undocumented-breaking` fails when a breaking change is not in the changelog. `stale-docs` fails when a docs reference relies on something the release changed, or when the release adds any other error-level lint finding.

**Exit status.** 0 when no selected gate fails, 1 when one does, 2 for a usage error or when the commits cannot be read (`no tag is reachable from HEAD (other than one on that commit): pass --from <ref>`, `v9 is not a commit in <dir> (fetch it first; Staleproof never fetches for lint)`).

## In the GitHub Action

`mode: release` runs the gate on the checked-out repository, writes the report to the job summary and fails the job per `release-fail-on`. Copy [examples/staleproof-release.yml](../examples/staleproof-release.yml):

```yaml
name: Staleproof release gate
on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      from:
        description: Compare with this tag or commit (default the latest tag before the release)
        required: false
        default: ''

permissions:
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: rajkaria/staleproof@v1
        with:
          mode: release
          release-from: ${{ inputs.from }}
```

On `release: published` the checkout is the release's tag, so the gate compares it with the tag before. Inputs: `release-from`, `release-to`, `release-fail-on` (default `undocumented-breaking,stale-docs`), `changelog`. Outputs: `breaking`, `undocumented`, `stale-docs`. See [GitHub Action](github-action.md#release-gate).

## On real releases

| Release | Breaking changes found | Hand check |
|---|---|---|
| encode/httpx 0.27.2 → 0.28.0 | 13: `proxies` and `cert` removed from `httpx.get`/`post`/... and `proxies`/`app` from `Client`/`AsyncClient` (in the changelog); `create_ssl_context` lost `http2` and swapped `cert`/`verify`, `HTTPTransport`/`AsyncHTTPTransport` moved `trust_env` before `http1` (not in the changelog) | All 13 true. The 3 undocumented ones are real: positional callers of those break. The changelog names `cert` as "now deprecated" for the top-level functions, where 0.28.0 removed it; the gate counts the mention (it does not judge meaning). |
| encode/httpx 0.28.0 → 0.28.1 | 0 | True: a bug fix. |
| pallets/flask 3.0.3 → 3.1.0 | 0 (11 compatible signature changes) | True: new optional parameters; the `max_content_length` setter is a property, not a call. |
| tj/commander.js v12.1.0 → v13.0.0 | 1: `Help.wrap` removed, in the changelog | True ("`Help.wrap()` refactored into `formatItem()` and `boxWrap()`"). The other breaking items there are behaviour, which no signature shows. |
| tj/commander.js v13.1.0 → v14.0.0 | 0 | True: the break is the Node.js version. |

## Limits

- Signatures, not behaviour: a function that now raises on input it used to accept, or returns something else, is not seen. The changelog check covers only what the gate found.
- One repository: docs in another repository are not checked against the release (run [`staleproof check`](cli.md#check) on the pull requests, or the [audit](audit.md) on the docs repository).
- A name mentioned for another reason counts as mentioned, so a short, common name (`get`) can pass when the changelog says nothing about it.
- Python's `__all__` is read when it is a literal list or tuple; one built at run time is not, and the module's public names count instead.

## Related

- [Docs audit](audit.md): the docs as they are now, with no release.
- [Lint docs and agent files](lint.md): the reference checks the gate runs at both commits.
- [CLI](cli.md#release): every option.
