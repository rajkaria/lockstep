# API

```ts
import { connect, Graph, ping, legacy, variadic, select } from '@acme/arity';

const g = connect('redis://localhost', { retries: 1 }, 'extra');
g.query('MATCH (n) RETURN n');
g.query('MATCH (n) RETURN n', {}, 'x');
const h = new Graph();
Graph.open('a', 'b');
g.explain('q', true, 1);
g.log('a', 'b', 'c');
g.close();
ping();
ping('h', 1, 2);
legacy();
legacy(1, 2, 3);
variadic(1, 2);
g.query(...args);
select('social');
```
