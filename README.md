# tsbouncer

**The bouncer for TypeScript/JS ESM-only apps.**

Define authorization data, relationships, and policies. `tsbouncer` evaluates access
— over pluggable storage, inside your application.

> **Status: pre-alpha.** Nothing is published yet. The design is settled and locked in
> [PLAN.md](./PLAN.md); the implementation is being built milestone by milestone. The
> snippets below describe the intended API and are not yet runnable.

## Why

Authorization logic tends to end up scattered: a check in a route handler, a different
check in a worker, a third in a cron job. They drift. Nobody can answer "who has access
to this document?" without reading all of them.

`tsbouncer` gives you one model, one set of tuples, and one evaluator — and then stays
out of the way.

```ts
const decision = await authz.check({
  subject: "user:alice",
  permission: "document.read",
  resource: "document:123",
});
```

You do whatever you want with the result. Throw, return 403, branch, log it.

## What it is not

This is the part that matters more than the feature list.

`tsbouncer` does **not** provide:

- Express / Hono / Fastify / Nest middleware, or any HTTP layer
- authentication, sessions, or identity verification
- JWT, OAuth, or any credential handling
- a CLI, a control plane, or a hosted service

Your application owns the request lifecycle, the transaction, and the business logic.
`tsbouncer` owns authorization semantics and access to authorization data.

## Model

A model is types, relations, permissions, and conditions — code, validated at runtime.

```ts
const model = defineModel({
  types: {
    user: defineType({}),
    team: defineType({
      relations: { member: relation(["user"]) },
    }),
    document: defineType({
      relations: {
        owner: relation(["user"]),
        editor: relation("user").or(relation("team", { through: "member" })),
        parent: relation("folder"),
      },
      permissions: {
        read: permission.or(["owner", "editor", "viewer"]),
        write: permission.allOf(["owner", "editor"]).except("banned"),
      },
    }),
  },
});
```

Model and data stay separate. The model is code; the data is tuples.

## Data

```ts
await authz.grant({
  subject: "user:alice",
  relation: "owner",
  resource: "document:123",
});

await authz.grant({
  subject: "team:engineering#member",
  relation: "editor",
  resource: "document:123",
});
```

References are opaque strings. `tsbouncer` never resolves `user:alice` to a row in
your `users` table, and never needs a foreign key into your domain schema.

## Storage

One primitive is mandatory: a filtered tuple read. Everything else — reverse walks,
`expand`, `listResources` — is derived by the engine. Stores stay dumb; they move
tuples, they don't decide anything.

```ts
import { createKeyman } from '@tsbouncer/core';
import { memoryStore } from '@tsbouncer/memory';

const authz = createKeyman({ model, store: memoryStore() });
```

Because the contract is that small, it also runs on JSON on disk, Redis, or a SQL
database via Kysely, Drizzle, or Prisma.

## Explain

Every decision can tell you why, citing the tuples that produced it.

```ts
const result = await authz.explain({
  subject: "user:alice",
  permission: "document.read",
  resource: "document:123",
});

format(result); // "ALLOWED  user:alice -> document:123#read ..."
```

## Fails closed

A condition that throws, a missing context key, an unresolvable reference, or an
exhausted evaluation budget all resolve to **not allowed**. Never allowed, never thrown
through to the caller. If `tsbouncer` is confused, it says no.

## Install

Not published yet. When it is:

```bash
npm i tsbouncer                    # batteries-included
npm i @tsbouncer/core              # kernel only, zero dependencies
```

## Requirements

ESM only. No CommonJS build, no dual package, no `require()`. Node `>=20.11`.

## Design notes

The reasoning behind the API — why filtered reads are the only mandatory store
primitive, why there's no optional `check()` fast path, why conditions are functions —
lives in [PLAN.md](./PLAN.md). [IDEA.md](./IDEA.md) is the original pitch;
[AGENTS.md](./AGENTS.md) has the working rules.

## License

[MIT](./LICENSE)
