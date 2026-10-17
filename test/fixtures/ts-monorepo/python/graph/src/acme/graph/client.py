class Client:
    def __init__(self, url: str = "redis://localhost"):
        self.url = url

    def query(self, q: str):
        return [q]
