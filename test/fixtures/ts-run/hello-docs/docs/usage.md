# Hello

```js
import { greet } from '@acme/hello';

console.log(greet('docs'));
```

```ts
import { ping } from '@acme/hello';

const reply: string = await ping();
console.log(reply);
```

A fragment that uses what the page imported:

```js
console.log(greet('fragment'));
```

```js
import { greet } from '@acme/hello';

await fetch('https://example.com');
```

```js
import { hi } from '@acme/broken';

console.log(hi());
```
