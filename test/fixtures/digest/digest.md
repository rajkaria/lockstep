### Staleproof docs digest: acme/app

Docs health for acme/app: 81/100 (B), down 7 since the last digest (2026-10-10, 88/100). 4 new since then, 1 fixed. 5 open problems: 3 docs references, 1 example line, 1 failing example. 1 verified fix ready (staleproof fix).

**New since the last digest**

- [AGENTS.md:4](https://github.com/acme/app/blob/abc1234def5678/AGENTS.md#L4): `npm run lint:docs` is not a script in package.json.
- [README.md:21](https://github.com/acme/app/blob/abc1234def5678/README.md#L21): `STALE_URL` is not read anywhere in the code.
- [docs/api.md:44](https://github.com/acme/app/blob/abc1234def5678/docs/api.md#L44): Example: `connect` has no parameter `tls`.
- [docs/run.md](https://github.com/acme/app/blob/abc1234def5678/docs/run.md#L5): Example fails when run: TypeError: connect() got an unexpected keyword argument 'tls'

**Verified fixes** (`staleproof fix` applies them)

- [AGENTS.md:4](https://github.com/acme/app/blob/abc1234def5678/AGENTS.md#L4): Rename to `npm run lint-docs` (script renamed in package.json)

[Full report](https://github.com/acme/app/issues/7)
