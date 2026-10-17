# Guide

## Install

Install the package, then open a client:

```python
from pkg.client import Client

client = Client("localhost", port=6380)
client.query("RETURN 1")
```

## Environment

| Variable | Meaning |
|---|---|
| `PKG_HOST` | The server host. |
| `PKG_TIMEOUT_SECONDS` | How long to wait. |
