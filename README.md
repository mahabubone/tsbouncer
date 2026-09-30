# tsbouncer

**The bouncer for TypeScript/JS ESM-only apps.**

Define authorization data, relationships, and policies. `tsbouncer` evaluates access
— over pluggable storage, inside your application.

> **Status: preview.** Nothing is published yet — `1.0.0-preview.1` is
> staged. One `@tsbouncer/tsbouncer` kernel package, eight `@tsbouncer/*` adapter
> and conformance packages, a complete check engine, and the three graph queries
> are built and tested. See
> [PLAN.md](./PLAN.md) for the breakdown.

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
        viewer: relation(["user"]),
        banned: relation(["user"]),
      },
      permissions: {
        read: permission.or("owner", "editor", "viewer"),
        write: permission.allOf("owner", "editor").except("banned"),
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

## Types

`can()` takes three plain `string`s, because the store is schemaless and the model is
built at runtime. The model is still known statically, so the legal values are
derivable:

```ts
import type { ModelShapeOf, ObjectRefOf, PermissionOf, SubjectRefOf } from '@tsbouncer/tsbouncer';
import { model } from './model.js';

type Shape = ModelShapeOf<typeof model>;

type AnySubject = SubjectRefOf<Shape>;     // 'user:…' | 'team:…#member' | …
type AnyResource = ObjectRefOf<Shape>;    // 'user:…' | 'document:…' | …
type AnyPermission = PermissionOf<Shape>; // 'document.read' | 'team.read' | …
```

The permission union is exact, and it is the string you retype most. A typo is a
build failure, not a test failure:

```
error TS2820: Type '"document.riad"' is not assignable to type 'DocumentPermission'.
  Did you mean '"document.read"'?
```

Reference unions are looser than they look — `` `user:${string}` `` also matches
`user:x#member`, since `${string}` swallows the `#`. Closing that needs a branded id
type. This is "pragmatic typing" on purpose: the model carries the names, the store
carries no schema, and nothing pretends otherwise.

## Storage

One primitive is mandatory: a filtered tuple read. Everything else — reverse walks,
`expand`, `listResources` — is derived by the engine. Stores stay dumb; they move
tuples, they don't decide anything.

## Graph queries

`expand`, `listResources`, and `listSubjects` are the three reads that answer a
question about a whole graph rather than one edge.

```ts
const { resources, truncated } = await authz.listResources({
  subject: 'user:alice',
  permission: 'document.read',
});
```

Every list carries a `truncated` flag, and it is not decoration. One node budget is
shared by the *whole request* — the candidate walk, its fan-out, and every evaluation
it triggers — so `maxNodes` bounds what the call can cost rather than what each
branch can cost. A query that runs out part-way returns a partial answer; a bare
array cannot say "these are some of them", so the list would be indistinguishable
from a small one and a caller treating it as authoritative would under-grant
silently. The same applies to
`listSubjects`, whose `SubjectSet` reports truncation on the set itself.

`listSubjects` is the one query that is deliberately *not* concrete. When a grant
covers a class of subjects — `user:*`, or a whole relation on another type — the
answer is symbolic, because inventing a member list would be a guess:

```ts
const { allOfTypes, members, excluded } = await authz.listSubjects({
  permission: 'document.read',
  resource: 'document:1',
});
// allOfTypes: ['user']  — "any user", not a list of users
// members:     ['user:alice', 'team:eng#member']
// excluded:    ['user:mallory']  — the `except` side, not flattened away
```

```ts
import { defineModel, defineType, permission, relation } from '@tsbouncer/tsbouncer';
import { createDefaultAuthz } from '@tsbouncer/defaults';

const authz = createDefaultAuthz({ model });        // in-memory
// or: createDefaultAuthz({ model, file: './tsbouncer.json' })

await authz.grant({ subject: 'user:alice', relation: 'owner', resource: 'document:123' });
await authz.can('user:alice', 'document.read', 'document:123'); // true
```

`tsbouncer` is the kernel and two ports — `TupleStore` for the durable record
of grants, `Cache` for the fast losable layer in front of repeated questions.
Backends are separate plugin packages, one per port they implement:

| package | implements | takes |
| --- | --- | --- |
| `@tsbouncer/in-memory` | store + cache | nothing — process-local |
| `@tsbouncer/json-file` | store | a file path |
| `@tsbouncer/redis` | store + cache | your Redis `client` |
| `@tsbouncer/kysely` | store | your `Kysely` instance |
| `@tsbouncer/drizzle` | store | your `db` and table object |
| `@tsbouncer/prisma` | store | your `PrismaClient` |
| `@tsbouncer/defaults` | neither — it chooses | nothing, or a file path |

Every port implementation is verified by the same conformance suite in
`@tsbouncer/testkit`. An adapter that does not pass is not finished — and a
community adapter for TypeORM, MikroORM, Sequelize, or Mongoose plugs into the
same two ports, no kernel changes required.

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
ALLOWED  user:alice -> document:123#document.read
  + union
    + owner
      + direct
        user:alice#owner@document:123
  (1 read)
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

Not published yet — `1.0.0-preview.1` is staged in this repo, not shipped.
When it is:

```bash
npm i @tsbouncer/tsbouncer @tsbouncer/in-memory   # kernel plus the process-local backend
```

## Examples

[`examples/`](./examples) holds two runnable applications with assertions — not
snippets. Each starts from a situation you are probably in, listens on a real socket,
and answers real requests. They run in CI, so they cannot rot into fiction:

```bash
pnpm examples
```

[`hono-rbac`](./examples/hono-rbac) is the one to start with. [Hono](https://hono.dev)
routes and the whole access graph in a JSON file you can read and commit, with one
idea: a document never names a person, it names a role, and the role names its
holders. 19 live requests.

[`express-drizzle`](./examples/express-drizzle) is the one to read if you are wiring
this into something you already have. A real documents API over Express, Drizzle ORM
and SQLite, carrying RBAC, ReBAC and three ABAC conditions on one model, plus a
transactional move that rewrites the access path atomically. 50 live requests.

Both are the source of truth for the [guides](https://tsbouncer.dev/docs/guides), and a
test in this repository fails if a guide's link to one of their files stops
resolving.

## What this library guarantees

Every claim below is a clause in a contract, checked against a real store on every
CI run, and the report is uploaded as an artifact. It is a list you can read
without opening the evaluator.

```
contract summary
  ✓ engine guarantees  21/21
  ✓ store guarantees  4/4
```

- A direct grant allows the subject that holds it, and nobody else.
- Naming a group grants the group object, not the people in it.
- `user:*` reaches every subject of that type, including ones that do not exist yet.
- An exclusion removes an access its own base granted, and short-circuiting is the
  bug this shape exists to prevent.
- Declaring a wildcard edge is not a grant: it matches a stored `user:*` and nothing
  else, so an empty ban list bans nobody.
- Permission flows from an ancestor to its descendants, and not upward.
- A tuple's bound parameters are authoritative. A request cannot rewrite the
  constraint the grant was written with.
- A missing key, a mistyped key, an undeclared condition, and a predicate that
  throws all deny.
- A cycle terminates and denies.
- `listResources`, `listSubjects`, and `expand` never contradict `check` —
  including for conditional grants, which is where they used to.
- A budget that runs out denies, and says so: `truncated` on every answer shape,
  so a partial answer is never mistaken for a whole one.
- A store that over-matches, or that drops condition bindings, is rejected by the
  golden dataset rather than passing its own suite.

## Requirements

ESM only. No CommonJS build, no dual package, no `require()`. Node `>=22`.

## Design notes

The reasoning behind the API — why filtered reads are the only mandatory store
primitive, why there's no optional `check()` fast path, why conditions are functions —
lives in [PLAN.md](./PLAN.md). [IDEA.md](./IDEA.md) is the original pitch;
[AGENTS.md](./AGENTS.md) has the working rules.

How it sits next to Zanzibar and OpenFGA — including the rows where it is the
worse answer — is the [comparison catalog](https://tsbouncer.dev/docs/reference/comparison).

## License

[Apache-2.0](./LICENSE)
