import os


class Client:
    """A connection to the demo server."""

    def __init__(self, host, port=6379):
        self.host = host or os.environ.get("PKG_HOST", "localhost")
        self.port = port

    def query(self, cypher, params=None):
        """Run a query.

        Args:
            cypher: The query text.
            parameters: Query parameters.
        """
        return cypher

    def close(self):
        """Close the connection."""
        return None
