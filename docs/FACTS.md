# FACTS

Generated from the `falkordb` graph by `lockstep-docs facts` at 2026-10-15T15:58:38.316Z (FalkorDB 4.18.3).
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
| CodeExample | 1835 |
| DocSection | 3138 |
| File | 329 |
| Repo | 3 |
| Symbol | 1298 |

| Edges | Count |
|---|---:|
| CALLS | 1708 |
| DEFINED_IN | 6271 |
| DEPENDS_ON | 3 |
| IN_REPO | 329 |
| IN_SECTION | 1824 |
| LINKS_TO | 636 |
| MENTIONS | 627 |
| USES | 718 |

## Resolution quality

- CALLS edges: 1708 (1655 exact through imports and types, 53 by name inside an imported repository)
- CALLS edges that cross a repository boundary: 5
- USES edges from code examples: 718 (633 exact, 85 by name)
- Symbol → doc paths (≤ 3 call hops) that cross a repository boundary: 1285

## Repository dependencies

- FalkorDB/GraphRAG-SDK → FalkorDB/falkordb-py (declares falkordb)
- FalkorDB/docs → FalkorDB/GraphRAG-SDK (examples import graphrag_sdk)
- FalkorDB/docs → FalkorDB/falkordb-py (examples import falkordb)

## Sample cross-repository paths

- 4 hops: `falkordb.asyncio.cluster.Cluster_Conn` ← `falkordb.asyncio.falkordb.FalkorDB.__init__` ← `graphrag_sdk.core.connection.FalkorDBConnection._ensure_client` ← `graphrag_sdk.core.connection.FalkorDBConnection.query` ← `FalkorDB/GraphRAG-SDK:docs/api-reference.mdx:7`
- 4 hops: `falkordb.asyncio.cluster.Is_Cluster` ← `falkordb.asyncio.falkordb.FalkorDB.__init__` ← `graphrag_sdk.core.connection.FalkorDBConnection._ensure_client` ← `graphrag_sdk.core.connection.FalkorDBConnection.query` ← `FalkorDB/GraphRAG-SDK:docs/api-reference.mdx:7`
- 4 hops: `falkordb.asyncio.falkordb.FalkorDB` ← `graphrag_sdk.core.connection.FalkorDBConnection._ensure_client` ← `graphrag_sdk.core.connection.FalkorDBConnection.query` ← `graphrag_sdk.storage.vector_store.VectorStore.backfill_entity_embeddings` ← `FalkorDB/GraphRAG-SDK:docs/api-reference.mdx#finalize`
- 4 hops: `falkordb.asyncio.falkordb.FalkorDB.select_graph` ← `graphrag_sdk.core.connection.FalkorDBConnection._ensure_client` ← `graphrag_sdk.core.connection.FalkorDBConnection.query` ← `graphrag_sdk.storage.vector_store.VectorStore.embed_relationships` ← `FalkorDB/GraphRAG-SDK:docs/api-reference.mdx#finalize`
- 4 hops: `falkordb.asyncio.graph.AsyncGraph` ← `falkordb.asyncio.falkordb.FalkorDB.select_graph` ← `graphrag_sdk.core.connection.FalkorDBConnection._ensure_client` ← `graphrag_sdk.core.connection.FalkorDBConnection.query` ← `FalkorDB/GraphRAG-SDK:docs/api-reference.mdx:7`

## Impact query timing (server-side, FalkorDB)

| Changed symbol | Rows | ms |
|---|---:|---:|
| `falkordb.asyncio.cluster.Cluster_Conn` | 3 | 0.60 |
| `falkordb.asyncio.cluster.Is_Cluster` | 5 | 0.18 |
| `falkordb.asyncio.falkordb.FalkorDB` | 57 | 0.30 |
