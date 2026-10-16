# JavaScript client

Install it with `npm install @acme/minigraph`.

## Connect

Use `Client` and `selectGraph()`.

```typescript
import { Client, type Options } from '@acme/minigraph';

const opts: Options = { url: 'redis://localhost' };
const db = new Client(opts);
const g = db.selectGraph('social');
await g.query('CREATE (:Person)');
```

## Old API

```js
import connect, { Gone } from '@acme/minigraph';
const g2 = connect('redis://x').selectGraph('x');
g2.readOnly('MATCH (n) RETURN n');
```
