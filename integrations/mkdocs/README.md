# mkdocs-staleproof

A [Staleproof](https://staleproof.dev) "checked" stamp on every MkDocs page: one line under the
title that says what was checked against which commit and when, or how many references on the
page are out of date.

```bash
pip install mkdocs-staleproof
```

```yaml
# mkdocs.yml
repo_url: https://github.com/owner/name
plugins:
  - staleproof
```

Options: `repo` (`owner/name`, default from `repo_url`), `server` (default
`https://staleproof.dev`), `docs_path` (the docs folder relative to the repository root; worked
out from `docs_dir` by default), `placement` (`top`, `bottom` or `none`).

The repository must have been audited once on the server (open
`https://staleproof.dev/#/audit?repo=owner/name`); pages with no data show nothing. The script
sets no cookies, uses no storage and sends no referrer. See
[the verified stamp docs](https://staleproof.dev/#/docs/verified-stamp).
