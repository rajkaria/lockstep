# Using the monorepo

```ts
import { connect } from '@mono/core';

connect('redis://localhost', 'extra').query('RETURN 1');
```

```python
from acme.graph import Client
from acme.tools import run, gone

Client().query()
run("x")
```

```go
import (
	"github.com/mono/store"
	kv "github.com/mono/store/store"
)

db := store.Open("localhost:6379")
db.Close()
kv.Get("a", "b")
```
