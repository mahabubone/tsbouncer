# Keyman - Nextgen authorization tool for modern apps

> **This is the original pitch, kept as a record. It is not the spec.**
>
> The project was renamed `Keyman` -> `tsbouncer`, and the name is retained here
> only so the history reads honestly. Three things in this document were
> deliberately reversed and are **wrong**:
>
> 1. **Naming** (§17, §18) — `@Keyman/*` became `@tsbouncer/*`, and `KeymanStore`
>    is now `TupleStore`.
> 2. **The store contract** (§12) — this proposes an *optional* `check?` fast path
>    per adapter. That was rejected: it is the most likely route to a subtly-wrong
>    authorization library, since wildcard, rewrite, tuple-to-userset, and exclusion
>    semantics would have to be reimplemented per store. Filtered reads are the
>    only mandatory primitive.
> 3. **The CLI** (§16, §19) — there will not be one. testkit is the quality gate.
>
> [PLAN.md](./PLAN.md) records the locked decisions; [AGENTS.md](./AGENTS.md) has
> the working rules. Where this document and those disagree, they are right.

## Revised positioning

> **Keyman is a TypeScript-native authorization graph SDK for defining authorization data, relationships, policies, and evaluating access — backed by pluggable storage.**

```text
┌──────────────────────────────────────────────────────┐
│                    Application                       │
│                                                      │
│ Express / Hono / Nest / Fastify / Expo / Worker / CLI│
│                                                      │
│      YOUR OWN middleware / handler / service logic   │
└─────────────────────────┬────────────────────────────┘
                          │
                    authz.can()
                    authz.check()
                    authz.assert()
                    authz.explain()
                          │
┌─────────────────────────▼────────────────────────────┐
│                     Keyman                      │
│                                                      │
│  Model Definition                                    │
│  Relationship Definition                             │
│  Permission Definition                               │
│  Tuple / Authorization Data                          │
│  ReBAC / RBAC / ABAC Evaluation                     │
│  Conditions                                          │
│  Graph Resolution                                    │
│  Query / Access Layer                                │
│  Validation / Limits / Explainability                │
└─────────────────────────┬────────────────────────────┘
                          │
                    Store Interface
                          │
       ┌──────────────────┼───────────────────┐
       │                  │                   │
       ▼                  ▼                   ▼
   JSON / Memory       Redis             Database
                                      /      |       \
                                  Kysely  Drizzle   Prisma
                                              \
                                             TypeORM
       │
       └──────────── MongoDB / other community adapters
```

That's a much stronger architecture.

---

# 1. No framework tooling

This becomes a hard project rule:

```text
Keyman does NOT provide:

❌ Express middleware
❌ Hono middleware
❌ Fastify plugins
❌ Nest decorators
❌ Nest guards
❌ HTTP middleware
❌ framework-specific request adapters
❌ authentication
❌ session management
❌ JWT handling
❌ OAuth
```

Instead:

```ts
const decision = await authz.check({
  subject: "user:alice",
  permission: "document.read",
  resource: "document:123",
});
```

The application does whatever it wants with that result.

For example:

```ts
const allowed = await authz.can(
  "user:alice",
  "document.read",
  "document:123",
);

if (!allowed) {
  throw new Error("Forbidden");
}
```

Or:

```ts
const decision = await authz.check(...);

return decision.allowed
  ? doSomething()
  : fallback();
```

That keeps Keyman useful in:

```text
API servers
background workers
CLI applications
GraphQL resolvers
REST handlers
event consumers
cron jobs
desktop apps
React Native / Expo
frontend UI capability checks
serverless functions
```

without Keyman knowing anything about those environments.

---

# 2. I would separate "model" from "authorization data"

This is very important.

There are really two different things:

```text
MODEL
 ├─ types
 ├─ relations
 ├─ permissions
 ├─ conditions
 └─ evaluation rules

DATA
 ├─ tuples
 ├─ attributes
 └─ authorization state
```

So:

```ts
const model = defineModel({
  ...
});
```

is one concern.

While:

```ts
await authz.grant(...);
await authz.revoke(...);
await authz.check(...);
```

operates against authorization data.

This means the same model can be backed by:

```text
JSON
Redis
PostgreSQL
MySQL
MongoDB
SQLite
```

without changing the application's authorization model.

---

# 3. The storage architecture should be slightly different from what we initially proposed

I would **not** call everything "in-memory".

Instead:

```text
KeymanStore
```

is the abstraction.

Then:

```text
                    KeymanStore
                        │
        ┌───────────────┼────────────────────┐
        │               │                    │
        ▼               ▼                    ▼
   InMemory          JSON File             Redis
   Store             Store                 Store
        │                                     │
        │                               remote/shared
        │
        └──── process-local ────┐
                                 │
                          ┌──────▼──────┐
                          │ loaded state │
                          └──────────────┘
```

And database adapters are another category:

```text
KeymanStore
   │
   ├── MemoryStore
   ├── JsonStore
   ├── RedisStore
   │
   ├── KyselyStore
   ├── DrizzleStore
   ├── PrismaStore
   ├── TypeORMStore
   │
   └── MongoStore
```

---

# 4. JSON should be first-class

I actually like your JSON idea much more than a purely ephemeral memory store for the default development experience.

Imagine:

```text
.Keyman/
├── model.json
└── tuples.json
```

or simply:

```text
Keyman.json
```

Then:

```ts
const authz = createKeyman({
  model,
  store: jsonStore({
    file: "./Keyman.json",
  }),
});
```

The implementation can:

```text
JSON file
   ↓
load
   ↓
in-memory indexed representation
   ↓
evaluate
   ↓
mutate
   ↓
atomic persistence
   ↓
JSON file
```

So the developer gets:

```text
simple
local
human-readable
git-friendly
persistent
zero database
```

That's fantastic for:

* demos
* prototypes
* tests
* local development
* documentation examples
* small applications
* CLI tools

---

# 5. But `memory` and `json` should still be two explicit stores

I'd expose both:

```ts
memoryStore()
```

and:

```ts
jsonStore({
  file: "./Keyman.json",
});
```

Because their semantics differ.

### Memory

```text
process starts
     ↓
empty store
     ↓
runtime
     ↓
process exits
     ↓
gone
```

### JSON

```text
process starts
     ↓
load JSON
     ↓
runtime
     ↓
write mutations
     ↓
process exits
     ↓
state remains
```

This distinction matters for tests.

```ts
const authz = createKeyman({
  model,
  store: memoryStore(),
});
```

gives perfectly isolated tests.

While:

```ts
const authz = createKeyman({
  model,
  store: jsonStore({
    file: "./dev/Keyman.json",
  }),
});
```

gives a persistent local authorization database without needing PostgreSQL.

---

# 6. Redis should be its own store

I wouldn't technically fuse Redis *inside* the in-memory store.

Redis is fundamentally different:

```text
MemoryStore
→ local process state

JsonStore
→ local durable state

RedisStore
→ external/shared state
```

So:

```ts
const authz = createKeyman({
  model,
  store: redisStore({
    url: "...",
  }),
});
```

That makes the semantics obvious.

Later you could provide a **hybrid cache layer**:

```text
Keyman
    │
    ▼
Cache
    │
    ▼
Redis
    │
    ▼
Database
```

But that should be a separate composition mechanism, not something that makes `RedisStore` conceptually fuzzy.

---

# 7. Database support: Kysely + Drizzle + Prisma from day one

I agree with your prioritization.

For the initial release:

```text
Tier 1
──────
Kysely
Drizzle
Prisma
```

Then:

```text
Tier 2
──────
TypeORM
MongoDB
```

Then community:

```text
Knex
MikroORM
Sequelize
Mongoose
Mongo native driver
other SQL/NoSQL
```

The key is that the **core doesn't depend on any ORM**.

---

# 8. Kysely adapter

```ts
import { createKeyman } from "Keyman";
import { kyselyStore } from "@Keyman/kysely";

const authz = createKeyman({
  model,
  store: kyselyStore(db),
});
```

Kysely becomes especially attractive for users who want complete control over their schema and SQL.

---

# 9. Drizzle adapter

```ts
import { drizzleStore } from "@Keyman/drizzle";

const authz = createKeyman({
  model,
  store: drizzleStore(db),
});
```

The Drizzle adapter should ideally consume the application's existing Drizzle database instance rather than forcing a separate database connection.

---

# 10. Prisma adapter

Absolutely worth having from day one.

```ts
import { prismaStore } from "@Keyman/prisma";

const authz = createKeyman({
  model,
  store: prismaStore(prisma),
});
```

The developer shouldn't care that Keyman is internally graph-oriented.

They should simply bring their existing:

```text
PrismaClient
Drizzle instance
Kysely instance
```

and Keyman uses it.

---

# 11. TypeORM can wait

I'd deliberately avoid promising every ORM immediately.

Architecture:

```text
@Keyman/typeorm
```

can come later without touching the kernel.

Same for:

```text
@Keyman/mongodb
```

Mongo is actually an interesting adapter because the graph doesn't require relational semantics.

You could have:

```ts
const authz = createKeyman({
  model,
  store: mongoStore({
    db,
    collection: "Keyman_tuples",
  }),
});
```

---

# 12. The adapter contract is the most important API

Something along these lines:

```ts
interface KeymanStore {
  read(query: ReadTupleQuery): Promise<readonly Tuple[]>;

  write(input: WriteTupleInput): Promise<void>;

  delete(input: DeleteTupleInput): Promise<void>;

  check?(query: StoreCheckQuery): Promise<StoreCheckResult>;

  expand?(query: ExpandQuery): Promise<readonly SubjectSet[]>;

  list?(query: ListQuery): Promise<readonly Tuple[]>;
}
```

But I would **not prematurely make all of these mandatory**.

Start with the minimal capability model:

```ts
interface KeymanStore {
  read(...): Promise<...>;
  write(...): Promise<...>;
  delete(...): Promise<...>;
}
```

Then optional capabilities:

```ts
interface KeymanStoreCapabilities {
  batchWrite?: ...
  transaction?: ...
  streaming?: ...
  watch?: ...
}
```

That makes an in-memory store extremely easy to implement.

---

# 13. Capability detection is better than forcing everything into one interface

For example:

```text
Memory
✓ read
✓ write
✓ delete
✓ batch

JSON
✓ read
✓ write
✓ delete
✓ batch
✓ persistence

Redis
✓ read
✓ write
✓ delete
✓ batch
✓ atomic operations

Kysely
✓ read
✓ write
✓ delete
✓ transaction
✓ batch

Mongo
✓ read
✓ write
✓ delete
✓ batch
✓ transaction*
```

Then Keyman can optimize based on available capabilities.

---

# 14. Your application owns the transaction

This is especially relevant to your modular-monolith architecture.

Keyman should **not assume it owns the application's transaction lifecycle**.

Eventually:

```ts
await db.transaction().execute(async trx => {
  await updateDocument(trx);

  await authz.grant(
    {
      subject: "user:alice",
      relation: "editor",
      resource: "document:123",
    },
    { store: kyselyStore(trx) },
  );
});
```

Or an adapter may provide:

```ts
const scopedAuthz = authz.withStore(kyselyStore(trx));
```

That's extremely valuable.

Because then authorization relationship updates can participate in the application's transaction where the underlying adapter supports it.

---

# 15. This also works beautifully with your modular architecture

For example:

```text
PostgreSQL
│
├── identity schema
├── organization schema
├── document schema
├── billing schema
└── Keyman schema
```

Keyman owns only:

```text
Keyman schema
```

and contains:

```text
tuples
authorization metadata
possibly model snapshots
```

The application owns its business entities.

Keyman does **not** require:

```text
document FK → Keyman
user FK → Keyman
organization FK → Keyman
```

Instead:

```text
user:123
   │
   └── editor
          │
          ▼
document:456
```

The IDs/types remain opaque authorization references.

That fits your **no cross-module FK / no cross-schema JOIN** rule extremely well.

---

# 16. I would make the public API roughly this

```ts
const authz = createKeyman({
  model,
  store,
});
```

### Data operations

```ts
authz.grant(...)
authz.revoke(...)
authz.replace(...)
authz.write(...)
authz.delete(...)
```

### Decision operations

```ts
authz.can(...)
authz.check(...)
authz.assert(...)
authz.explain(...)
```

### Graph/query operations

```ts
authz.expand(...)
authz.listResources(...)
authz.listSubjects(...)
```

### Model operations

```ts
authz.model
authz.types
authz.permissions
authz.relations
```

No HTTP layer whatsoever.

---

# 17. Package layout I would now use

```text
Keyman/
│
├── packages/
│   │
│   ├── core/
│   │   └── @Keyman/core
│   │
│   ├── stores/
│   │   ├── memory/
│   │   │   └── @Keyman/memory
│   │   ├── json/
│   │   │   └── @Keyman/json
│   │   ├── redis/
│   │   │   └── @Keyman/redis
│   │   └── mongodb/
│   │       └── @Keyman/mongodb
│   │
│   ├── adapters/
│   │   ├── kysely/
│   │   │   └── @Keyman/kysely
│   │   ├── drizzle/
│   │   │   └── @Keyman/drizzle
│   │   ├── prisma/
│   │   │   └── @Keyman/prisma
│   │   └── typeorm/
│   │       └── @Keyman/typeorm
│   │
│   ├── testkit/
│   │   └── @Keyman/testkit
│   │
│   └── cli/
│       └── @Keyman/cli
│
├── examples/
│   ├── vanilla/
│   ├── json/
│   ├── kysely/
│   ├── drizzle/
│   ├── prisma/
│   ├── redis/
│   ├── mongodb/
│   ├── expo/
│   └── multi-tenant-saas/
│
├── docs/
│
└── pnpm-workspace.yaml
```

And importantly:

```text
NO @Keyman/express
NO @Keyman/hono
NO @Keyman/nest
NO @Keyman/fastify
```

---

# 18. One package could still make onboarding extremely easy

We could make:

```text
Keyman
```

the batteries-included entry point:

```ts
import {
  createKeyman,
  defineModel,
  defineType,
  subject,
  relation,
  permission,
} from "Keyman";
```

while advanced users install:

```text
@Keyman/core
@Keyman/kysely
```

separately.

So:

```text
simple user
      │
      ▼
   Keyman
      │
      └── core

advanced user
      │
      ├── @Keyman/core
      ├── @Keyman/kysely
      └── @Keyman/redis
```

---

# 19. JSON becomes more interesting than merely "dev mode"

We could make it a proper **portable authorization state format**.

Example:

```json
{
  "version": 1,
  "tuples": [
    {
      "subject": "user:alice",
      "relation": "owner",
      "resource": "document:123"
    },
    {
      "subject": "team:engineering#member",
      "relation": "viewer",
      "resource": "document:123"
    }
  ]
}
```

Then developers can:

```bash
Keyman export
Keyman import
Keyman validate
Keyman inspect
Keyman explain
```

That makes the JSON representation useful for:

* fixtures
* tests
* examples
* migrations
* debugging
* local development
* reproducible authorization state
* Git versioning

---

# 20. One thing I'd change from our previous design

I would **not call Keyman a "Zanzibar alternative" in the project itself**.

That creates the wrong expectation that we're trying to replace:

```text
SpiceDB
OpenFGA
Zanzibar infrastructure
```

feature-for-feature.

Instead:

> **Keyman — TypeScript-native authorization graph SDK**

Then in the README:

```text
Inspired by the ideas behind Zanzibar, ReBAC, RBAC and ABAC.

Unlike authorization servers such as OpenFGA or SpiceDB,
Keyman is designed to run directly inside your application
with pluggable authorization-data storage.
```

That's a much more defensible technical position.

---

## The final mental model

```text
                  Keyman
                       │
        ┌──────────────┴──────────────┐
        │                             │
   DEFINE LAYER                  ACCESS LAYER
        │                             │
        │                       check / can
        │                       assert / explain
        │                       expand / list
        │
   Types / Relations
   Permissions
   Conditions
   Model
        │
        └──────────────┬──────────────┘
                       │
                  ACCESS STORE
                       │
       ┌───────────────┼──────────────────┐
       │               │                  │
     Memory           JSON              Redis
       │
       └────────────────┬─────────────────
                        │
                   SQL / NoSQL
                        │
          ┌─────────────┼─────────────┐
          │             │             │
        Kysely       Drizzle       Prisma
                                      │
                                   TypeORM
                                      │
                                   MongoDB
```

This is much closer to the project I'd actually build.

**Core rule:** Keyman owns **authorization semantics and authorization data access**, while the application owns **HTTP, authentication, request lifecycle, enforcement, transactions, and business logic**.

That separation is what makes the library genuinely runtime-agnostic and composable rather than becoming another auth framework.

