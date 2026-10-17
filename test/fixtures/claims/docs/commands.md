# Commands

Build with `npm run build`, test with `npm test`, and check the docs with `npm run lint:docs`.

```console
$ npm install
$ npm run docs:build
$ npm run docs:serve
```

The web app: `npm run dev -w @claims/web` or `npm run start -w @claims/web`.

```sh
make build test   # both targets exist
make docs-site
make release-1.2
just check
just publish
task serve
task site:build site:deploy
```

From Python: `uv run claims-py pull`, `python -m claims_demo.cli` and `python -m claims_demo.server`.

```console
$ claims-demo --verbose serve --port 8080
$ claims-demo deploy
$ claims-demo sync --dry-run --force
$ npx claims-demo serve -p 1
```

`claims-py pull --forse`, `python -m claims_demo push --all` and `claims-py fetch`.

Placeholders and tools are not commands of this repository: `npm run <script>`, `make TARGET`,
`pnpm eslint .`, `yarn run tsc`, `npm run docs --if-present`, `uv run pytest`.

Add `"docs:check": "staleproof lint"` to your package.json, then run `npm run docs:check`.
