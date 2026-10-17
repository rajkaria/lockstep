# Pre-commit hooks

Staleproof can stop a commit that makes the docs wrong: on `git commit` it lints what the commit contains (the git index, not the files on disk) against `HEAD` and fails when the staged changes introduce a stale reference in the docs, READMEs or AI agent files, such as a renamed script the README still runs or a moved file `AGENTS.md` still names. A second, optional hook runs on `git push` and fails when a docs example is predicted to break. This page shows the setup for [pre-commit](https://pre-commit.com), lefthook, husky and a plain git hook, what each hook runs, and why the pre-commit hooks run the published package.

## pre-commit

In `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/rajkaria/staleproof
    rev: v0.6.0
    hooks:
      - id: staleproof
      # - id: staleproof-predicted   # on push: docs examples predicted to break (needs a graph, below)
```

Then `pre-commit install` (and `pre-commit install --hook-type pre-push` for the second hook). `staleproof init` adds the entry to an existing `.pre-commit-config.yaml`, or creates one in a Python repository.

| Hook id | Stage | Runs | Fails when |
|---|---|---|---|
| `staleproof` | `pre-commit` | `staleproof lint --new --staged` | The staged changes introduce an error-level finding ([`--fail-on`](lint.md#options) `error`) |
| `staleproof-predicted` | `pre-push` | `staleproof check --fail-on-predicted` | A docs example (here or in another indexed repository) is predicted to break; needs a Staleproof graph of the repository (`npx staleproof index owner/name` once) |

Both take no file names (`pass_filenames: false`): a renamed script in `package.json` can make an unstaged README wrong, so the hook lints the whole index. It reads only the local clone; nothing is fetched or sent. To try the hook before adding it: `pre-commit try-repo https://github.com/rajkaria/staleproof staleproof --ref v0.6.0`.

### Why the hooks run the published package

The hooks are `language: script`: pre-commit runs `plugins/claude-code/scripts/staleproof.mjs` from this repository, which starts the Staleproof the project already has (`node_modules/staleproof`), else a global one, else `npx -y staleproof@<the tag's version>`. A `language: node` hook would make pre-commit install this repository itself as an npm package from git, which needs a build: the CLI in `dist/` is not committed, and building it pulls every development dependency (about 250 MB) on each machine and version; tried with pre-commit 4.7, the install takes more than a minute and then fails in npm's git-dependency step. The published package is built once, by the release. The cost is that Node.js 20 or later (with `npx`) must be on the `PATH`: pre-commit does not provision it for a script hook.

## lefthook

In `lefthook.yml`:

```yaml
pre-commit:
  commands:
    staleproof:
      run: npx -y staleproof@0.6.0 lint --new --staged
pre-push:
  commands:
    staleproof-predicted:
      run: npx -y staleproof@0.6.0 check --fail-on-predicted
```

`staleproof init` adds the `pre-commit` command when `lefthook.yml` has no `pre-commit:` block yet, and prints it to add by hand otherwise.

## husky

In `.husky/pre-commit` (husky 9):

```bash
npx -y staleproof@0.6.0 lint --new --staged
```

`staleproof init` appends the line when `.husky/` exists. In a project with Staleproof as a dependency, `npx --no-install staleproof` uses that copy instead (init picks it).

## A plain git hook

```bash
printf '#!/bin/sh\nexec npx -y staleproof@0.6.0 lint --new --staged\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

## Skipping it once

`git commit --no-verify` skips every hook; with pre-commit, `SKIP=staleproof git commit` skips only this one. To keep a reference that is right as it is, silence it in the doc instead: `<!-- staleproof: ignore rule-id -->` on the line before it ([Lint: configure and silence](lint.md#configure-and-silence)).

## Related

- [Lint docs and agent files](lint.md): what the hook checks, `--new` and `--staged`.
- [Claude Code plugin](claude-code.md): the same check after each edit an agent makes, and before it stops.
- [CLI: `init`](cli.md#init): writes the hook entry with the rest of the setup.
