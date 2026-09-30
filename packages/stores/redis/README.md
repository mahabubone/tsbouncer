# @tsbouncer/redis

A `TupleStore` over an application-owned Redis client — the fast shared store
for authorization data, and a supported backend in its own right.

```ts
import { createClient } from 'redis';
import { redisStore } from '@tsbouncer/redis';

const client = createClient({ url: 'redis://127.0.0.1:6379' });
await client.connect();

const authz = createAuthz({
  model,
  store: redisStore(client, { prefix: 'acme:authz' }),
});
```

Pass a client you already use. The store never connects, disconnects, or
selects a database — but it connects lazily on first use, so a test that never
touches the server never dials it either.

The same client serves the caching port:

```ts
import { redisCache } from '@tsbouncer/redis';
import { withCache } from '@tsbouncer/tsbouncer';

const cached = withCache(authz, redisCache(client, { prefix: 'acme:cache' }), {
  namespace: 'docs-api-v1',
  ttlMs: 30_000,
});
```

One connection, two ports. The namespace is required and should be versioned
with the model — two applications sharing one Redis must never read each
other's decisions.

## Two roles, one implementation

As the **primary** store it holds the whole access graph durably (Redis
persistence is Redis's job, configured server-side). As the **hot** store it
holds the working set your checks actually walk, with a database of record
behind it. Either way the contract is identical — the conformance suite cannot
tell which role a given instance plays, because there is no behavioral
difference to detect.

## How tuples live in Redis

Plain commands only — no modules, no RediSearch — so this runs against any
Redis 7+ server. Each tuple is a JSON string with per-field index sets, and
every mutation runs as one Lua script: matching, writing, and deleting are all
atomic, and a reader never sees half a write.

Every key starts with the configured prefix (default `tsbouncer`), so one
server hosts many tenants and many test runs without collision. Teardown is a
prefix scan, never a `FLUSHDB`.

## Capabilities

`atomicWrite`, `persistent`, `atomicReplace`, and `pagination` are true.
`transaction` is false — there is no driver transaction to enlist, by design
rather than by omission. `watch` is false: cross-instance invalidation is the
caller's problem until the contract grows a subscription primitive.

## Testing

The conformance and golden suites need a live server and skip without one, so
CI stays SQLite-only:

```bash
TSBUNCER_REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @tsbouncer/redis test
```

## Requirements

ESM only. Node `>=22`. A `redis` peer (`>=6.2.0 <7`) you provide.

## License

[Apache-2.0](./LICENSE)
