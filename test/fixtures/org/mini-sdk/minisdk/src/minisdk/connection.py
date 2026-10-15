class Connection:
    """Lazy connection to the graph store."""

    def __init__(self, graph_name: str):
        from miniclient.asyncio import AsyncClient

        self._driver = AsyncClient()
        self._graph = self._driver.select_graph(graph_name)

    async def run(self, q: str):
        return await self._graph.query(q)
