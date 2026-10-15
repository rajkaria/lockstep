from .connection import Connection


class Rag:
    """Question answering over a knowledge graph."""

    def __init__(self, graph_name: str = "kg"):
        self.conn = Connection(graph_name)

    async def ask(self, question: str):
        """Answer a question from the graph."""
        return await self.conn.run(f"MATCH (n) WHERE n.text CONTAINS '{question}' RETURN n")

    async def ingest(self, text: str):
        return await self.conn.run("CREATE (:Doc)")
