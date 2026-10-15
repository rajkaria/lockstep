from .graph import Graph


class Client:
    """Connection to a mini database."""

    def __init__(self, host: str = "localhost", port: int = 6379):
        self.host = host
        self.port = port

    def select_graph(self, name: str) -> Graph:
        """Open a graph by name."""
        return Graph(self, name)

    def list_graphs(self):
        return []
