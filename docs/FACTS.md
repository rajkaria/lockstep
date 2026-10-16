# FACTS

Generated from the `falkordb` graph by `lockstep-docs facts` at 2026-10-16T17:19:38.971Z (FalkorDB 4.22.0).
Every number in the README comes from this file. Regenerate it; never edit it by hand.

## Repositories

| Repository | Commit | Symbols | Doc sections | Code examples (Python) |
|---|---|---:|---:|---:|
| [FalkorDB/GraphRAG-SDK](https://github.com/FalkorDB/GraphRAG-SDK) | `35e67a0` | 1016 | 513 | 313 (252) |
| [FalkorDB/docs](https://github.com/FalkorDB/docs) | `f804fd7` | 0 | 2618 | 1517 (165) |
| [FalkorDB/falkordb-py](https://github.com/FalkorDB/falkordb-py) | `31f63f4` | 282 | 7 | 5 (2) |

## Graph

| Nodes (live) | Count |
|---|---:|
| Check | 13 |
| CodeExample | 1835 |
| DocSection | 3138 |
| File | 329 |
| PullRequest | 4 |
| Repo | 3 |
| Run | 57 |
| Symbol | 1298 |
| Verdict | 70 |

| Edges | Count |
|---|---:|
| ABOUT | 70 |
| AT | 57 |
| CALLS | 1708 |
| CHANGED_IN | 9 |
| DEFINED_IN | 6271 |
| DEPENDS_ON | 3 |
| EVIDENCE | 756 |
| FOR | 83 |
| IN_REPO | 329 |
| IN_SECTION | 1824 |
| LINKS_TO | 644 |
| MENTIONS | 594 |
| OF | 57 |
| PRODUCED | 70 |
| USES | 716 |

## Resolution quality

- CALLS edges: 1708 (1655 exact through imports and types, 53 by name inside an imported repository)
- CALLS edges that cross a repository boundary: 5
- USES edges from code examples: 716 (633 exact, 83 by name)
- Symbol → doc paths (≤ 3 call hops) that cross a repository boundary: 1257

## Repository dependencies

- FalkorDB/GraphRAG-SDK → FalkorDB/falkordb-py (declares falkordb)
- FalkorDB/docs → FalkorDB/GraphRAG-SDK (examples import graphrag_sdk)
- FalkorDB/docs → FalkorDB/falkordb-py (examples import falkordb)

## Sample cross-repository paths

- 4 hops: `falkordb.asyncio.falkordb.FalkorDB` ← `graphrag_sdk.core.connection.FalkorDBConnection._ensure_client` ← `graphrag_sdk.core.connection.FalkorDBConnection.query` ← `graphrag_sdk.storage.vector_store.VectorStore.backfill_entity_embeddings` ← `FalkorDB/GraphRAG-SDK:docs/api-reference.mdx#finalize`
- 4 hops: `falkordb.asyncio.falkordb.FalkorDB.select_graph` ← `graphrag_sdk.core.connection.FalkorDBConnection._ensure_client` ← `graphrag_sdk.core.connection.FalkorDBConnection.query` ← `graphrag_sdk.storage.vector_store.VectorStore.backfill_entity_embeddings` ← `FalkorDB/GraphRAG-SDK:docs/api-reference.mdx#finalize`
- 4 hops: `falkordb.asyncio.graph.AsyncGraph.query` ← `graphrag_sdk.core.connection.FalkorDBConnection.query` ← `graphrag_sdk.storage.graph_store.GraphStore.delete_document_chunks` ← `graphrag_sdk.api.main.GraphRAG.delete_document` ← `FalkorDB/GraphRAG-SDK:README.md#examples`

## Pull requests checked

| Pull request | Changed symbols | Doc sections reached (≤ 3 hops) | …in other repositories |
|---|---:|---:|---:|
| [fix(ingestion): preserve document structure on update](https://github.com/FalkorDB/GraphRAG-SDK/pull/336) | 2 | 73 | 3 |
| [fix: only forward accepted kwargs from Is_Cluster to redis.Redis](https://github.com/FalkorDB/falkordb-py/pull/262) | 1 | 1 | 0 |
| [test: assert the client parses execution plans, and fix a plan parser bug](https://github.com/FalkorDB/falkordb-py/pull/267) | 2 | 3 | 2 |
| [fix(asyncio): prevent connection pool kwargs mutation and await schema refresh](https://github.com/FalkorDB/falkordb-py/pull/276) | 4 | 43 | 41 |

## Without the graph: grep for the changed names

For each pull request, a whole-word search of every live doc section for the names of the symbols it changed
(what a reviewer can do without the graph), next to the sections the impact traversal reaches.

| Pull request | Changed names | Reached by the graph | …that grep also finds | grep matches outside them |
|---|---|---:|---:|---:|
| FalkorDB/GraphRAG-SDK/pull/336 | `update`, `run` | 73 | 30 | 219 |
| FalkorDB/falkordb-py/pull/262 | `Is_Cluster` | 1 | 0 | 0 |
| FalkorDB/falkordb-py/pull/267 | `_operation_tree`, `Is_Cluster` | 3 | 0 | 0 |
| FalkorDB/falkordb-py/pull/276 | `Cluster_Conn`, `_query`, `__init__` | 43 | 0 | 8 |

Total: the graph reaches 120 sections; grep finds 30 of them and matches 227 others.

## Example runs (sandbox)

51 recorded runs: 5 skipped, 6 error, 24 pass, 16 fail.

| Example | Side | Status | Error / reason | Installed |
|---|---|---|---|---|
| [FalkorDB/GraphRAG-SDK:docs/api-reference.mdx:52](https://github.com/FalkorDB/GraphRAG-SDK/blob/35e67a0b27fdcc7f2c28508b09e86169851a8187/docs/api-reference.mdx#L716) | before of FalkorDB/GraphRAG-SDK/pull/336 | skipped | reads a local file the docs do not provide (employees.csv) | FalkorDB/GraphRAG-SDK@d703d4a, FalkorDB/falkordb-py@31f63f4 |
| [FalkorDB/GraphRAG-SDK:docs/graph-schema.mdx:7](https://github.com/FalkorDB/GraphRAG-SDK/blob/35e67a0b27fdcc7f2c28508b09e86169851a8187/docs/graph-schema.mdx#L267) | after of FalkorDB/falkordb-py/pull/276 | error | dependency conflict: graphrag-sdk==1.4.0 requires falkordb[hiredis]>=1.8.0,<2, which the other checkouts don't satisfy ( | FalkorDB/GraphRAG-SDK@35e67a0, FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/GraphRAG-SDK:docs/graph-schema.mdx:7](https://github.com/FalkorDB/GraphRAG-SDK/blob/35e67a0b27fdcc7f2c28508b09e86169851a8187/docs/graph-schema.mdx#L267) | before of FalkorDB/falkordb-py/pull/276 | error | dependency conflict: graphrag-sdk==1.4.0 requires falkordb[hiredis]>=1.8.0,<2, which the other checkouts don't satisfy ( | FalkorDB/GraphRAG-SDK@35e67a0, FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/GraphRAG-SDK:docs/graph-schema.mdx:8](https://github.com/FalkorDB/GraphRAG-SDK/blob/35e67a0b27fdcc7f2c28508b09e86169851a8187/docs/graph-schema.mdx#L276) | after of FalkorDB/falkordb-py/pull/276 | error | dependency conflict: graphrag-sdk==1.4.0 requires falkordb[hiredis]>=1.8.0,<2, which the other checkouts don't satisfy ( | FalkorDB/GraphRAG-SDK@35e67a0, FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/GraphRAG-SDK:docs/graph-schema.mdx:8](https://github.com/FalkorDB/GraphRAG-SDK/blob/35e67a0b27fdcc7f2c28508b09e86169851a8187/docs/graph-schema.mdx#L276) | before of FalkorDB/falkordb-py/pull/276 | error | dependency conflict: graphrag-sdk==1.4.0 requires falkordb[hiredis]>=1.8.0,<2, which the other checkouts don't satisfy ( | FalkorDB/GraphRAG-SDK@35e67a0, FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/GraphRAG-SDK:docs/storage.mdx:16](https://github.com/FalkorDB/GraphRAG-SDK/blob/35e67a0b27fdcc7f2c28508b09e86169851a8187/docs/storage.mdx#L314) | after of FalkorDB/falkordb-py/pull/276 | error | dependency conflict: graphrag-sdk==1.4.0 requires falkordb[hiredis]>=1.8.0,<2, which the other checkouts don't satisfy ( | FalkorDB/GraphRAG-SDK@35e67a0, FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/GraphRAG-SDK:docs/storage.mdx:16](https://github.com/FalkorDB/GraphRAG-SDK/blob/35e67a0b27fdcc7f2c28508b09e86169851a8187/docs/storage.mdx#L314) | before of FalkorDB/falkordb-py/pull/276 | error | dependency conflict: graphrag-sdk==1.4.0 requires falkordb[hiredis]>=1.8.0,<2, which the other checkouts don't satisfy ( | FalkorDB/GraphRAG-SDK@35e67a0, FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/GraphRAG-SDK:graphrag_sdk/examples/07_incremental_updates.py:0](https://github.com/FalkorDB/GraphRAG-SDK/blob/35e67a0b27fdcc7f2c28508b09e86169851a8187/graphrag_sdk/examples/07_incremental_updates.py#L1) | before of FalkorDB/GraphRAG-SDK/pull/336 | skipped | needs an LLM provider (OPENAI_API_KEY); Lockstep does not hold provider keys | FalkorDB/GraphRAG-SDK@d703d4a, FalkorDB/falkordb-py@31f63f4 |
| [FalkorDB/docs:agentic-memory/graphiti-mcp-server.mdx:19](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/agentic-memory/graphiti-mcp-server.mdx#L384) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:agentic-memory/graphiti-mcp-server.mdx:19](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/agentic-memory/graphiti-mcp-server.mdx#L384) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:commands/graph.config-get.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.config-get.mdx#L16) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:commands/graph.config-get.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.config-get.mdx#L16) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:commands/graph.config-set.mdx:1](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.config-set.mdx#L24) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:commands/graph.config-set.mdx:1](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.config-set.mdx#L24) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:commands/graph.constraint-create.mdx:3](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.constraint-create.mdx#L119) | after of FalkorDB/falkordb-py/pull/276 | fail | AttributeError: 'FalkorDB' object has no attribute 'create_constraint' | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:commands/graph.constraint-create.mdx:3](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.constraint-create.mdx#L119) | before of FalkorDB/falkordb-py/pull/276 | fail | AttributeError: 'FalkorDB' object has no attribute 'create_constraint' | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:commands/graph.constraint-drop.mdx:1](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.constraint-drop.mdx#L54) | after of FalkorDB/falkordb-py/pull/276 | fail | AttributeError: 'FalkorDB' object has no attribute 'drop_constraint' | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:commands/graph.constraint-drop.mdx:1](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.constraint-drop.mdx#L54) | before of FalkorDB/falkordb-py/pull/276 | fail | AttributeError: 'FalkorDB' object has no attribute 'drop_constraint' | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:commands/graph.explain.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.explain.mdx#L17) | after of FalkorDB/falkordb-py/pull/276 | fail | redis.exceptions.ResponseError: Invalid graph operation on empty key | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:commands/graph.explain.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.explain.mdx#L17) | before of FalkorDB/falkordb-py/pull/276 | fail | redis.exceptions.ResponseError: Invalid graph operation on empty key | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:commands/graph.explain.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.explain.mdx#L17) | after of FalkorDB/falkordb-py/pull/267 | fail | redis.exceptions.ResponseError: Invalid graph operation on empty key | FalkorDB/falkordb-py@a9c7510 |
| [FalkorDB/docs:commands/graph.explain.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.explain.mdx#L17) | before of FalkorDB/falkordb-py/pull/267 | fail | redis.exceptions.ResponseError: Invalid graph operation on empty key | FalkorDB/falkordb-py@031eb04 |
| [FalkorDB/docs:commands/graph.list.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.list.mdx#L14) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:commands/graph.list.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.list.mdx#L14) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:commands/graph.profile.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.profile.mdx#L22) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:commands/graph.profile.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.profile.mdx#L22) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:commands/graph.profile.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.profile.mdx#L22) | after of FalkorDB/falkordb-py/pull/267 | pass |  | FalkorDB/falkordb-py@a9c7510 |
| [FalkorDB/docs:commands/graph.profile.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.profile.mdx#L22) | before of FalkorDB/falkordb-py/pull/267 | pass |  | FalkorDB/falkordb-py@031eb04 |
| [FalkorDB/docs:commands/graph.slowlog.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.slowlog.mdx#L26) | after of FalkorDB/falkordb-py/pull/276 | fail | redis.exceptions.ResponseError: Invalid graph operation on empty key | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:commands/graph.slowlog.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/commands/graph.slowlog.mdx#L26) | before of FalkorDB/falkordb-py/pull/276 | fail | redis.exceptions.ResponseError: Invalid graph operation on empty key | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:genai-tools/graphrag-sdk.mdx:1](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/genai-tools/graphrag-sdk.mdx#L25) | before of FalkorDB/GraphRAG-SDK/pull/336 | skipped | needs an LLM provider (LiteLLM(); Lockstep does not hold provider keys | FalkorDB/GraphRAG-SDK@d703d4a, FalkorDB/falkordb-py@31f63f4 |
| [FalkorDB/docs:getting-started/index.mdx:6](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/getting-started/index.mdx#L121) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:getting-started/index.mdx:6](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/getting-started/index.mdx#L121) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:index.mdx:1](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/index.mdx#L88) | after of FalkorDB/falkordb-py/pull/276 | fail | redis.exceptions.ResponseError: Invalid graph operation on empty key | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:index.mdx:1](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/index.mdx#L88) | before of FalkorDB/falkordb-py/pull/276 | fail | redis.exceptions.ResponseError: Invalid graph operation on empty key | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:operations/opentelemetry.mdx:10](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/operations/opentelemetry.mdx#L206) | after of FalkorDB/falkordb-py/pull/276 | fail | ModuleNotFoundError: No module named 'opentelemetry' | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:operations/opentelemetry.mdx:10](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/operations/opentelemetry.mdx#L206) | before of FalkorDB/falkordb-py/pull/276 | fail | ModuleNotFoundError: No module named 'opentelemetry' | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:operations/opentelemetry.mdx:4](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/operations/opentelemetry.mdx#L81) | before of FalkorDB/falkordb-py/pull/276 | skipped | contains placeholders to fill in (e.g. "<your-host>") | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:udfs/index.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/udfs/index.mdx#L20) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:udfs/index.mdx:0](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/udfs/index.mdx#L20) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/docs:udfs/index.mdx:6](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/udfs/index.mdx#L158) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/docs:udfs/index.mdx:6](https://github.com/FalkorDB/docs/blob/f804fd70f915fbd6f2651b56088739c0227c36fc/udfs/index.mdx#L158) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/falkordb-py:README.md:2](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L32) | before of FalkorDB/falkordb-py/pull/276 | skipped | not Python (bash) | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/falkordb-py:README.md:3](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L39) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/falkordb-py:README.md:3](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L39) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/falkordb-py:README.md:4](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L67) | after of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@2a970dc |
| [FalkorDB/falkordb-py:README.md:4](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L67) | before of FalkorDB/falkordb-py/pull/276 | pass |  | FalkorDB/falkordb-py@e307df3 |
| [FalkorDB/falkordb-py:README.md:4](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L67) | after of FalkorDB/falkordb-py/pull/267 | pass |  | FalkorDB/falkordb-py@a9c7510 |
| [FalkorDB/falkordb-py:README.md:4](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L67) | before of FalkorDB/falkordb-py/pull/267 | fail | TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry' | FalkorDB/falkordb-py@031eb04 |
| [FalkorDB/falkordb-py:README.md:4](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L67) | after of FalkorDB/falkordb-py/pull/262 | pass |  | FalkorDB/falkordb-py@f7c3de7 |
| [FalkorDB/falkordb-py:README.md:4](https://github.com/FalkorDB/falkordb-py/blob/31f63f44a5745b9bec65969a1db706906718cb82/README.md#L67) | before of FalkorDB/falkordb-py/pull/262 | fail | TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry' | FalkorDB/falkordb-py@49aa012 |

## Impact query timing (server-side, FalkorDB)

| Changed symbol | Rows | ms |
|---|---:|---:|
| `falkordb.asyncio.falkordb.FalkorDB` | 49 | 0.74 |
| `falkordb.asyncio.falkordb.FalkorDB.select_graph` | 49 | 0.79 |
| `falkordb.asyncio.graph.AsyncGraph.query` | 670 | 2.85 |
