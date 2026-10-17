class Client:
    """A connection to the claims server."""

    def __init__(self, host, port=6379):
        self.host = host
        self.port = port

    def query(self, cypher, params=None, timeout=None):
        """Run a query.

        Args:
            cypher: The query text.
            parameters: Query parameters.
            timeout: Seconds to wait.
        """
        return cypher

    def ro_query(self, cypher, read_only=True, timeout=None):
        """Run a read-only query.

        :param cypher: The query text.
        :param read_only: Refuse writes.
        """
        return cypher
