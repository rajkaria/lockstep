# Agent guide

- The entry point is `src/app.ts`; the CLI starts in `src/app.ts:2`.
- Settings live in `src/settings.ts`.
- String helpers are in `src/util/old.ts`.
- The banner is printed by `src/app.ts:999`.
- Read [the guide](docs/guide.md), [usage](docs/setup.md#usage) and [the old guide](docs/old-guide.md).
- Never edit `src/ghost.ts`. <!-- staleproof: ignore -->
- Builds go to `dist/app.js`; the local report is `src/report.json`.
- Running `npm run report` creates `src/cache/today.json`.
- Upstream is `acme/claims-demo`; the MIME type is `text/plain`.
