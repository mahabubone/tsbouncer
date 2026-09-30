# @tsbouncer/json-file

A `TupleStore` over a single JSON file. The whole access graph, human-readable,
git-diffable, and portable.

```ts
import { jsonStore } from '@tsbouncer/json-file';

const authz = createAuthz({ model, store: jsonStore({ file: './authz.json' }) });
```

The file is rewritten atomically on every mutation, so a reader never observes
a half-written file and a crash mid-write leaves the previous state intact.
Mutations serialize through a promise chain, and the file is re-read when
anything else touches it — without that, a second instance's next write would
silently delete the first instance's grants.

This is the right shape for local development, fixtures, tests, examples, and
small tools. It is not a database: every mutation rewrites the whole file, so
it should not be pointed at a large graph. One writer at a time.

## Capabilities

`atomicWrite`, `persistent`, and `atomicReplace` are true; `pagination`,
`transaction`, and `watch` are false.

## Requirements

ESM only. Node `>=22`. No dependencies — only `node:fs`, which ships with the
runtime.

## License

[Apache-2.0](./LICENSE)
