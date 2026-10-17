# Listing

The schema functions, by name:

```ts
import * as a from '@acme/arity';

a.select();
a.connect();
a.ping();
```

Calls on an object are never a listing:

```ts
import { connect } from '@acme/arity';

const g = connect('x');
g.log();
g.close();
g.query();
```
