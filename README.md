# Lockstep

An agent that keeps a devtools company's docs true to its code. Give it a pull request: it walks a
FalkorDB graph of code, docs and past decisions across every repository, proves which examples now
break by running them, and proposes the docs fix with the path behind each paragraph.

> Work in progress. This README is rewritten when the first release lands.

## Develop

```bash
npm install
npm run verify        # typecheck + tests (starts a local FalkorDB on port 6380, no Docker needed)

npx tsx src/cli.ts db start                      # local FalkorDB on :6379 (falkordblite binaries, no Docker)
npx tsx src/cli.ts index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
npx tsx src/cli.ts check https://github.com/FalkorDB/falkordb-py/pull/267 --no-agent
npx tsx src/cli.ts facts                         # writes docs/FACTS.md from the graph
```
