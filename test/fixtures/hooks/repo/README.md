# demo

Open a connection:

```python
from demo.client import connect

conn = connect("localhost", timeout=5)
```

Lint the docs with `npm run lint:docs`. The client is in `demo/client.py`.
