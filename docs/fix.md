# Fix stale docs

Staleproof does not only flag a stale docs reference: when the right answer is unambiguous it proposes the edit, re-checks it, and applies it. `staleproof fix` rewrites the files; pull requests get one-click GitHub suggestions; `mode: fix` in the GitHub Action keeps one weekly pull request with every fix (Renovate for docs). A fix is applied only when it is **verified**: Staleproof applies it in a mirror of the repository, lints again, and keeps it only if its finding is gone and no new finding appeared anywhere.

## Fix the working tree

```bash
npx -y staleproof fix --dry-run   # the unified diff, nothing written
npx -y staleproof fix             # apply every verified fix
npx -y staleproof fix --new       # only what your changes made stale
```

```text
fixed  AGENTS.md:4:24  command-missing  Rename to `npm run docs:lint` (renamed in package.json)
fixed  docs/usage.md:3:18  anchor-missing  Rename to `#install` (the closest heading)
hint   AGENTS.md:3:66  path-missing  Rename to `src/config/defaults.ts` (renamed in this change) (not applied: the fix did not pass re-checking)
Fixed 13 findings in 5 files; 3 findings left.
```

A second run has nothing to do. A `hint` is a fix Staleproof could propose but not verify (here the reference also names line 40, which the moved file does not have): it is shown, never applied. Options, output and exit codes are in the [CLI reference](cli.md#fix).

## Where a fix comes from

Staleproof proposes a fix only when there is one right answer.

1. **A rename between two states of the repository.** `fix` compares the working tree with the base `lint --new` uses (the last commit when you have uncommitted work, else the merge base with the default branch); pull request suggestions compare the pull request's base and head. Renamed files come from git's rename detection (or identical content, or the one file of that name, when there is no git). Renamed names come from lines whose only change is one name: a `package.json` script, a Make, just or Task target, a CLI flag or subcommand, an environment variable read, a function or method, a parameter. A heading whose text changed renames its anchor.
2. **Moves in git history.** A path the repository renamed in an earlier commit (the same evidence `path-missing` reports as "it moved to").
3. **The one close name.** One existing name within two edits of the stale one (one edit for names of four characters or less, three for long heading anchors), with no other name as close: `npm run buld` → `npm run build`, `--colour` → `--color`, `Client.qeury` → `Client.query`, `#instal` → `#install`. <!-- staleproof: ignore command-missing -->

| Rule | What the fix writes |
|---|---|
| `path-missing` | The file's new path, written from the same folder the page wrote it from (or the shortest way that resolves) |
| `link-broken` | The new link target, relative to the page; a root path written in a nested page becomes relative to the page |
| `anchor-missing` | The renamed or closest heading anchor |
| `command-missing` | The renamed or closest script, target or recipe |
| `cli-command-unknown`, `cli-flag-unknown` | The renamed or closest subcommand or option of the repository's own CLI |
| `env-unused` | The variable the code reads now, at every mention on the page (and in `.env.example`) |
| `symbol-missing` | The renamed or closest member of the class or module |
| `docstring-param-unknown` | The renamed parameter, or the one undocumented parameter when exactly one name is unknown |
| `example-unknown-keyword` | The renamed or closest keyword parameter of the function the example calls |
| `example-missing-attribute`, `example-missing-import`, `example-removed` | The renamed or closest member |

## When Staleproof does not fix

- **Two answers.** `npm run dov` is one edit from both `dev` and `doc`; a name renamed to two different names in the change. Nothing is proposed.
- **Too far, or a different word.** `npm run tset` is two edits from `test`, too many for a four-letter name; `API_KEY` and `APP_KEY` differ in a whole short word, so one is not a typo of the other. <!-- staleproof: ignore command-missing -->
- **History.** Migration guides, release notes, old versions' docs (`versioned_docs/`, `v1/`, `legacy/`) and lines that say a name was renamed, removed or replaced name the old name on purpose. They are never rewritten.
- **A fix that breaks something else.** The fix is re-checked; if the finding stays or another appears (a path whose `:line` is past the end of the moved file, an anchor the new link target lacks), it stays a hint.
- **A rename that changes the shape.** A documented parameter replaced by an options object (`signal` → `options: { abortSignal }`) is not renamed: the entry now describes a property.
- **An import its example still uses.** Renaming `from pkg import conect` alone would break the call below it; an import written `as` another name is fixed.

Rules turned `"off"` in `.staleproof.toml`, ignored files and `<!-- staleproof: ignore -->` lines are neither reported nor fixed. Nothing leaves the machine: the mirror is a set of hard links in a temporary folder, removed when the check ends, and the files are written only by `staleproof fix` without `--dry-run` (a file you edit meanwhile is skipped, never overwritten).

## Suggestions on pull requests

In check mode the [GitHub Action](github-action.md#docs-this-pull-request-makes-wrong) (and the [GitHub App](github-app.md)) posts each verified fix for a reference the pull request makes stale as a GitHub suggestion, when the lines are on the pull request's diff:

````markdown
**Staleproof** `command-missing`: `lint:docs` is not a script in package.json. Rename to `npm run docs:lint` (renamed in package.json).

```suggestion
Run `npm run docs:lint` before pushing.
```
````

One review per push. A suggestion already posted on the same lines is updated (or left when it says the same); one whose lines changed since is left as it is; nothing is posted twice. Fixes outside the diff (the untouched README line that still runs the old script) are listed at the end of the comment with `npx staleproof fix`. Turn suggestions off with `suggestions: false`. From the command line: `staleproof suggest <pr-url>` ([CLI](cli.md#suggest)).

## A weekly fix pull request

`mode: fix` lints the default branch, applies every verified fix on the branch `staleproof/fix-docs`, and opens one pull request, **Staleproof: fix N stale docs references**, with a table of the fixes and where Staleproof looked for each. Every run rebuilds the branch from the default branch and updates the same pull request; when nothing is left it closes it. A pull request you close without merging is not opened again until the fixes change (one Staleproof closed itself because nothing was left does not count: if the same drift comes back, it opens a new one). Staleproof writes only branches under `staleproof/`.

```yaml
# .github/workflows/staleproof-fix.yml
name: Staleproof fix docs
on:
  schedule:
    - cron: '17 6 * * 1'
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/staleproof@v1
        with:
          mode: fix
```

The workflow's token opens the pull request only when the repository lets it: turn on **Allow GitHub Actions to create and approve pull requests** (Settings → Actions → General → Workflow permissions; it is off for new repositories and organizations), or pass a token of your own as `github-token`. Without it the run pushes `staleproof/fix-docs` and fails with `GitHub Actions may not open pull requests in <owner/name>` and a link that opens the pull request by hand.

Run it locally with `staleproof fix-pr <owner/name>` ([CLI](cli.md#fix-pr)).

## In your editor and your coding agent

The [VS Code extension and language server](editors.md) offers each verified fix as a quick fix, and the [Claude Code plugin](claude-code.md) adds `Fix: …` to the docs it tells Claude an edit made wrong, so the agent applies it in the same change.

## Related

- [Lint docs and agent files](lint.md): what each rule checks.
- [Lint rules](rules.md): every rule, and which can be fixed.
- [GitHub Action](github-action.md): inputs `suggestions` and `mode: fix`.
