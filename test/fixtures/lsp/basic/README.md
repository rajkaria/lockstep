# pkg

A small client for the demo server. Read [the guide](docs/guide.md#install) first; the
[configuration notes](docs/guide.md#configuration) are gone.

Connect with `pkg.client.Client`, then call `Client.query` or `Client.execute()`.

```python
from pkg.client import Client

c = Client("localhost")
c.query("MATCH (n) RETURN n", timeout=5)
```

Run `make test` before you push.
