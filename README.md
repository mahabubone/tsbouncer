# tsbouncer

**The bouncer for TypeScript/JS ESM-only apps.**

Define authorization data, relationships, and policies. `tsbouncer` evaluates access
— over pluggable storage, inside your application.

> **Status: pre-alpha.** Nothing is published yet. The model, the store contract, five
> stores, and a complete check engine are built and tested. `expand`, `listResources`,
> and `listSubjects` are not implemented. See [PLAN.md](./PLAN.md) for the breakdown.

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
import { createAuthz } from '@tsbouncer/core';
import { memoryStore } from '@tsbouncer/memory';

const authz = createAuthz({ model, store: memoryStore() });

await authz.grant({ subject: 'user:alice', relation: 'owner', resource: 'document:123' });
await authz.can('user:alice', 'document.read', 'document:123'); // true
```

Because the contract is that small, it also runs on JSON on disk, or on a SQL database
through whichever query builder you already use:

| package | takes | tested against |
| --- | --- | --- |
| `@tsbouncer/memory` | nothing — process-local | in-process |
| `@tsbouncer/json` | a file path | on disk |
| `@tsbouncer/kysely` | your `Kysely` instance | SQLite |
| `@tsbouncer/drizzle` | your `db` and table object | SQLite (sync) and libsql (async) |
| `@tsbouncer/prisma` | your `PrismaClient` | SQLite via Prisma 7 |

Every store is verified by the same conformance suite. A store that does not pass it
is not finished.

## Explain

Every decision can tell you why, citing the tuples that produced it.

```ts
const result = await authz.explain({
  subject: 'user:alice',
  permission: 'document.read',
  resource: 'document:123',
});

formatExplain(result);
```

```
ALLOWED  user:alice -> document:123#read
  + union
    + owner
      user:alice#owner@document:123
```

Every leaf either cites the tuples that produced it or the query that came back empty,
and the whole thing is a plain JSON-serializable tree — the text is a view of the
structure, not a separate code path, so the two cannot disagree.

## Conditions

A condition is a predicate in the model. Only its *name* and a few bound parameters live
on the tuple, so tuples still serialize cleanly and a store never evaluates anything.

```ts
defineCondition(
  'inRegion',
  (ctx) => ctx.userTier === 'pro' && ctx.resourceRegion === 'eu',
  { params: { resourceRegion: 'string' } },
);

await authz.grant({
  subject: 'user:alice',
  relation: 'owner',
  resource: 'document:123',
  condition: 'inRegion',
  context: { resourceRegion: 'eu' },   // bound by the writer
});

await authz.check(
  { subject: 'user:alice', permission: 'document.read', resource: 'document:123' },
  { context: { userTier: 'pro' } },   // known only by the caller
);
```

The tuple's parameters are **authoritative**. If the request could override
`resourceRegion`, a caller could rewrite the constraint the grant was written with, and
the condition would be theatre.

The optional `params` schema governs what a *tuple* may bind, not everything the
predicate reads. Its real job is making a missing key detectable: a predicate reading an
absent key just gets `undefined` and quietly returns false, which is
indistinguishable from a genuine denial. Declaring params turns that silence into a
reason. Unknown or mistyped bound parameters are rejected at `grant` time, where a typo
is still cheap to fix.

## Fails closed

A condition that throws, a missing or mistyped context key, a condition the model no
longer declares, an unresolvable reference, or an exhausted depth/node/deadline budget
all resolve to **not allowed**. Never allowed, never thrown through to the caller. If
`tsbouncer` is confused, it says no.

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
