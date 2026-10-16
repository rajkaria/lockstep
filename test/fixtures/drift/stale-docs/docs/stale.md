# Upgrading guide

This page was written for an older release of `miniclient`.

## Connect

```python
from miniclient import Client, connect

db = Client(hostname="db.local", port=6379)
g = db.select_graph("social")
```

## Query

Use `Graph.query` and `Graph.ro_query`.

```python
g.query("MATCH (n) RETURN n", {}, 30)
g.read_only("MATCH (n) RETURN n")
```

## Ask

```python
import asyncio
from minisdk import Rag

async def main():
    rag = Rag("kg")
    print(await rag.ask("who", top_k=3))

asyncio.run(main())
```

## Fine

```python
g.delete()
```
