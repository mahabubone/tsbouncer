# @tsbouncer/testkit

The conformance suites every port implementation must pass, plus a golden dataset
with a fixed expected outcome.

**There is no CLI. The suites are the gate.** A store that does not pass
`storeConformance`, or a cache that does not pass `cacheConformance`, is not done.

```bash
npm i -D @tsbouncer/testkit
```

## Conformance

Call `storeConformance` from a Vitest test file. It registers the whole suite against
the store you hand it.

```ts
import { storeConformance } from '@tsbouncer/testkit';
import { kyselyStore } from '@tsbouncer/kysely';

storeConformance({
  name: 'kysely',
  create: () => kyselyStore(db),
});
```

`create` runs once per test and must return an empty store. Use `teardown` to release
whatever it holds.

| option | meaning |
| --- | --- |
| `name` | used in the suite name |
| `create` | fresh, empty store for each test |
| `teardown` | release resources held by the store |
| `skip` | capabilities the store does not claim |

Capabilities not listed in `skip` are asserted to **work**, not merely to be declared.
Do not silence a failure you have not understood — and note that `capabilities` is
self-reported in both directions: a store that claims a capability it does not honour
is caught by the suite, and a store that reports `pagination: false` is simply not
asked for a cursor.

Caches get the same treatment through `cacheConformance`, including
capability-gated TTL tests:

```ts
import { cacheConformance } from '@tsbouncer/testkit';
import { memoryCache } from '@tsbouncer/in-memory';

cacheConformance({
  name: 'memoryCache',
  create: () => memoryCache(),
});
```

## Golden dataset

A fixed model, a fixed tuple set, and a fixed expected outcome — `assertGolden`
fails on the first divergence. This is what catches a store that over-matches or drops
condition bindings while still passing its own narrower assertions.

```ts
import { assertGolden, goldenChecks, goldenModel, goldenTuples } from '@tsbouncer/testkit';
```

## Contract helpers

For asserting a *behaviour* once rather than per store:

```ts
import { contract, formatReport, summarise } from '@tsbouncer/testkit';

const report = contract('exclusion does not short-circuit', () => {
  expect(...).toBe(...);
});
```

`formatReport` renders a ✗/✓ summary with detail; `summarise` folds several reports into
one line for a CI step.

## Requirements

ESM only, Node `>=22`, Vitest `>=3` (peer dependency).

## Links

- [Root README](https://github.com/mahabubone/tsbouncer#readme)
- [PLAN.md](https://github.com/mahabubone/tsbouncer/blob/main/PLAN.md)
- [AGENTS.md](https://github.com/mahabubone/tsbouncer/blob/main/AGENTS.md) — the working rules

## License

[Apache-2.0](./LICENSE)
