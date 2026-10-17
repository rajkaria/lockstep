class Client:
    def query(self, text):
        return text


def connect(host, timeout=10):
    """Open a connection to host."""
    return Client()
