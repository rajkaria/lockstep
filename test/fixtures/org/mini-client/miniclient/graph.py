class Graph:
    """A named graph."""

    def __init__(self, client, name):
        self.client = client
        self.name = name

    def query(self, q: str, params=None):
        """Run a Cypher query."""
        return self._send("QUERY", q)

    def ro_query(self, q: str):
        """Run a read-only Cypher query."""
        return self.query(q)

    def _send(self, cmd, q):
        return [cmd, self.name, q]

    def delete(self):
        return self._send("DELETE", "")
