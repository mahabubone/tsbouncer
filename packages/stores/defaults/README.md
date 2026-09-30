# @tsbouncer/defaults

One-call client setup for the dependency-free backends: an in-memory store, or
a JSON file when given a path.

```ts
import { createDefaultAuthz } from '@tsbouncer/defaults';

const authz = createDefaultAuthz({ model }); // in-memory
const filed = createDefaultAuthz({ model, file: './authz.json' }); // on disk
```

The choice is deliberately not automatic from the environment: whether
authorization state should be durable is a decision about your application, not
something a library should infer from whether a file happens to exist.

Anything with a real database behind it should call `createAuthz` with the
store you already have instead — this package exists so the common case is one
call, not so configuration can hide.

## Requirements

ESM only. Node `>=22`.

## License

[Apache-2.0](./LICENSE)
