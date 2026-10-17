class Client:
    """A small client."""

    def __init__(self, host: str = "localhost") -> None:
        self.host = host

    def query(self, q: str, timeout: float = 1.0) -> list:
        """Run a query.

        Args:
            q: The query text.
            timeout_ms: How long to wait.
        """
        return [q, timeout]

    def close(self) -> None:
        """Close the client."""
        self.host = ""
