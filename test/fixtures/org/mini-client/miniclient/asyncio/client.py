from ..graph import Graph


class AsyncGraph(Graph):
    async def query(self, q: str, params=None):
        return self._send("QUERY", q)


class AsyncClient:
    def __init__(self, host: str = "localhost"):
        self.host = host

    def select_graph(self, name: str) -> AsyncGraph:
        return AsyncGraph(self, name)
