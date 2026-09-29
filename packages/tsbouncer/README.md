# tsbouncer

**The bouncer for TypeScript/JS ESM-only apps.**

Authorization graph SDK with pluggable storage. The root entry is the kernel and
nothing else — model, evaluator, queries, and the store contract — so importing
it never loads a backend you did not ask for:

```ts
import { createAuthz, defineModel, defineType, permission, relation } from 'tsbouncer';

const model = defineModel({
  types: {
    user: defineType({}),
    document: defineType({
      relations: { owner: relation(['user']) },
      permissions: { read: permission.or('owner') },
    }),
  },
});
```

Reach further only on purpose:

```ts
import { memoryStore } from 'tsbouncer/memory'; // process-local, for tests
import { jsonStore } from 'tsbouncer/json'; // a git-diffable file, for tools
import { createDefaultAuthz } from 'tsbouncer/defaults'; // picks one for you
```

If your app already has Kysely, Drizzle, or Prisma, wire the matching plugin
package (`@tsbouncer/kysely`, `@tsbouncer/drizzle`, `@tsbouncer/prisma`) and skip
`tsbouncer`'s stores entirely. `@tsbouncer/testkit` holds the conformance suite
every store must pass. This package deliberately depends on none of them, and
neither should your install graph because you read a README.

## What it is not

No Express / Hono / Fastify / Nest middleware, no HTTP layer, no authentication, no
sessions, no JWT/OAuth, no CLI, no control plane. Your application owns the request
lifecycle; `tsbouncer` owns authorization semantics. See
[What it is not](https://github.com/mahabubone/tsbouncer#what-it-is-not) in the root
README.

## Install

```bash
npm i tsbouncer
```

## Requirements

ESM only. No CommonJS build, no dual package, no `require()`. Node `>=22`.

## Links

- [Root README](https://github.com/mahabubone/tsbouncer#readme)
- [PLAN.md](https://github.com/mahabubone/tsbouncer/blob/main/PLAN.md) — design reasoning
- [Examples](https://github.com/mahabubone/tsbouncer/tree/main/examples) — two runnable apps

## License

[Apache-2.0](./LICENSE)
