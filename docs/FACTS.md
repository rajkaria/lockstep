# FACTS

Generated from the `falkordb` graph by `lockstep-docs facts` at 2026-10-15T16:40:47.244Z (FalkorDB 4.18.3).
Every number in the README comes from this file. Regenerate it; never edit it by hand.

## Repositories

| Repository | Commit | Symbols | Doc sections | Code examples (Python) |
|---|---|---:|---:|---:|
| [FalkorDB/GraphRAG-SDK](https://github.com/FalkorDB/GraphRAG-SDK) | `35e67a0` | 1016 | 513 | 313 (252) |
| [FalkorDB/docs](https://github.com/FalkorDB/docs) | `f804fd7` | 0 | 2618 | 1517 (165) |
| [FalkorDB/falkordb-py](https://github.com/FalkorDB/falkordb-py) | `31f63f4` | 282 | 7 | 5 (2) |

## Graph

| Nodes | Count |
|---|---:|
| Check | 9 |
| CodeExample | 1835 |
| DocSection | 3152 |
| File | 329 |
| PullRequest | 4 |
| Repo | 3 |
| Run | 14 |
| Symbol | 1298 |

| Edges | Count |
|---|---:|
| AT | 14 |
| CALLS | 1708 |
| CHANGED_IN | 7 |
| DEFINED_IN | 6285 |
| DEPENDS_ON | 3 |
| FOR | 9 |
| IN_REPO | 329 |
| IN_SECTION | 1829 |
| LINKS_TO | 644 |
| MENTIONS | 594 |
| OF | 14 |
| USES | 716 |

## Resolution quality

- CALLS edges: 1708 (1655 exact through imports and types, 53 by name inside an imported repository)
- CALLS edges that cross a repository boundary: 5
- USES edges from code examples: 716 (633 exact, 83 by name)
- Symbol → doc paths (≤ 3 call hops) that cross a repository boundary: 1242

## Repository dependencies

- FalkorDB/GraphRAG-SDK → FalkorDB/falkordb-py (declares falkordb)
- FalkorDB/docs → FalkorDB/GraphRAG-SDK (examples import graphrag_sdk)
- FalkorDB/docs → FalkorDB/falkordb-py (examples import falkordb)

## Sample cross-repository paths

- 4 hops: `falkordb.asyncio.falkordb.FalkorDB` ← `graphrag_sdk.core.connection.FalkorDBConnection._ensure_client` ← `graphrag_sdk.core.connection.FalkorDBConnection.query` ← `graphrag_sdk.storage.vector_store.VectorStore.embed_relationships` ← `FalkorDB/GraphRAG-SDK:docs/api-reference.mdx#finalize`
- 4 hops: `falkordb.asyncio.falkordb.FalkorDB.select_graph` ← `graphrag_sdk.core.connection.FalkorDBConnection._ensure_client` ← `graphrag_sdk.core.connection.FalkorDBConnection.query` ← `graphrag_sdk.storage.vector_store.VectorStore.backfill_entity_embeddings` ← `FalkorDB/GraphRAG-SDK:docs/api-reference.mdx#finalize`
- 4 hops: `falkordb.asyncio.graph.AsyncGraph.query` ← `graphrag_sdk.core.connection.FalkorDBConnection.query` ← `graphrag_sdk.storage.graph_store.GraphStore.delete_document_node` ← `graphrag_sdk.api.main.GraphRAG.delete_document` ← `FalkorDB/GraphRAG-SDK:README.md#examples`

## Pull requests checked

| Pull request | Changed symbols | Doc sections reached (≤ 3 hops) |
|---|---:|---:|
| [fix: only forward accepted kwargs from Is_Cluster to redis.Redis](https://github.com/FalkorDB/falkordb-py/pull/262) | 1 | 1 |
| [test: assert the client parses execution plans, and fix a plan parser bug](https://github.com/FalkorDB/falkordb-py/pull/267) | 2 | 3 |
| [fix(asyncio): prevent connection pool kwargs mutation and await schema refresh](https://github.com/FalkorDB/falkordb-py/pull/276) | 4 | 44 |
| [feat: add optional hiredis extra for faster reply parsing](https://github.com/FalkorDB/falkordb-py/pull/304) | 0 | 0 |

## Example runs (sandbox)

14 recorded runs: 10 pass, 4 fail.

| Example | Side | Status | Error / reason | Installed |
|---|---|---|---|---|
| [FalkorDB/docs:agentic-memory/graphiti-mcp-server.mdx:19](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/agentic-memory/graphiti-mcp-server.mdx#L384) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:agentic-memory/graphiti-mcp-server.mdx:19](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/agentic-memory/graphiti-mcp-server.mdx#L384) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:commands/graph.config-get.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.config-get.mdx#L16) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:commands/graph.config-get.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.config-get.mdx#L16) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:commands/graph.config-set.mdx:1](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.config-set.mdx#L24) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:commands/graph.config-set.mdx:1](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.config-set.mdx#L24) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:commands/graph.explain.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.explain.mdx#L17) | after of FalkorDB/falkordb-py/pull/267 | fail | redis.exceptions.ResponseError: Invalid graph operation on empty key | FalkorDB/falkordb-py@a9c7510 |
| [FalkorDB/docs:commands/graph.explain.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.explain.mdx#L17) | before of FalkorDB/falkordb-py/pull/267 | fail | redis.exceptions.ResponseError: Invalid graph operation on empty key | FalkorDB/falkordb-py@031eb04 |
| [FalkorDB/docs:commands/graph.profile.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.profile.mdx#L22) | after of FalkorDB/falkordb-py/pull/267 | pass |  | FalkorDB/falkordb-py@a9c7510 |
| [FalkorDB/docs:commands/graph.profile.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.profile.mdx#L22) | before of FalkorDB/falkordb-py/pull/267 | pass |  | FalkorDB/falkordb-py@031eb04 |
| [FalkorDB/falkordb-py:README.md:4](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L67) | after of FalkorDB/falkordb-py/pull/267 | pass |  | FalkorDB/falkordb-py@a9c7510 |
| [FalkorDB/falkordb-py:README.md:4](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L67) | before of FalkorDB/falkordb-py/pull/267 | fail | TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry' | FalkorDB/falkordb-py@031eb04 |
| [FalkorDB/falkordb-py:README.md:4](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L67) | after of FalkorDB/falkordb-py/pull/262 | pass |  | FalkorDB/falkordb-py@f7c3de7 |
| [FalkorDB/falkordb-py:README.md:4](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L67) | before of FalkorDB/falkordb-py/pull/262 | fail | TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry' | FalkorDB/falkordb-py@49aa012 |

## Impact query timing (server-side, FalkorDB)

| Changed symbol | Rows | ms |
|---|---:|---:|
| `falkordb.asyncio.falkordb.FalkorDB` | 49 | 0.50 |
| `falkordb.asyncio.falkordb.FalkorDB.select_graph` | 49 | 0.33 |
| `falkordb.asyncio.graph.AsyncGraph.query` | 670 | 1.08 |
