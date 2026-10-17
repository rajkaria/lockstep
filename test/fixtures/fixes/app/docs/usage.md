# Usage

Read [the setup](setup.md#instal) first, then the [old guide](old-guide.md).

Call `Client.qeury()` to run a query.

```python
from mypkg.client import Client

c = Client()
c.query("match (n) return n", timout=3)
```
