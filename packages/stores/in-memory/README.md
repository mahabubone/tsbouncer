# @tsbouncer/in-memory

The process-local backend: a `TupleStore` and a `Cache` with no dependencies,
no server, and nothing to clean up.

```ts
import { memoryCache, memoryStore } from '@tsbouncer/in-memory';

const authz = createAuthz({ model, store: memoryStore() });
const cached = withCache(authz, memoryCache(), { namespace: 'docs-api-v1' });
```

Use the store for tests and the cache for single-process memoization. Nothing
is persisted and nothing is shared — every instance is a clean slate, which is
exactly what makes both halves the first thing to reach for in tests.

## Two ports, one package

Backends implement ports, and this one implements two: `memoryStore` speaks
`TupleStore`, `memoryCache` speaks `Cache`. Values are deep-cloned on the way
in and on the way out, so a caller mutating an object it passed (or received)
can never corrupt what a later `get` returns. Expiry is lazy — entries are
checked on `get`, never swept by a timer — so an idle cache holds no handles
and never keeps a process alive.

## Capabilities

Store: `atomicWrite`, `atomicReplace`, and `pagination` are true; `persistent`,
`transaction`, and `watch` are false. Cache: `ttl` is true, `persistent` is
false.

## Requirements

ESM only. Node `>=22`. No dependencies, not even optional ones.

## License

[Apache-2.0](./LICENSE)
