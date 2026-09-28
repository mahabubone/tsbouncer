# @tsbouncer/prisma

A [`KeymanStore`](../../core) over an application-owned Prisma client.

**Requires Prisma 7 or later.** Prisma 7 moved `datasource.url` out of the schema
file and requires a driver adapter on the client, and the `latest` tag of the
`prisma` CLI is currently an 8.0 release candidate with a different,
platform-oriented command set — pin to a matching stable pair.

```bash
npm i @tsbouncer/prisma @prisma/client
```

## Setup

Copy the model into your schema. `MODEL_DDL` exports the same text.

```prisma
// schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"   // no `url` — that moved to prisma.config.ts
}

model TsbouncerTuple {
  id               Int    @id @default(autoincrement())
  subjectType      String
  subjectId        String
  subjectRelation  String
  relation         String
  resourceType     String
  resourceId       String
  condition        String
  context          String?

  @@unique([subjectType, subjectId, subjectRelation, relation, resourceType, resourceId, condition])
  @@index([subjectType, subjectId, relation])
  @@index([relation, resourceType, resourceId])
  @@index([resourceType, resourceId])
}
```

Then generate a migration and the client, and pass the client you already have:

```ts
import { prismaStore } from '@tsbouncer/prisma';

const store = prismaStore(prisma);
```

Prisma 7 constructs its client with a driver adapter:

```ts
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
```

## The schema

Identical to the Kysely and Drizzle adapters, so you can switch adapters without a
data migration. `subjectRelation` and `condition` are `''` when absent.

### Why absent values are `''` and not `NULL`

The `@@unique` over the seven key fields is what makes `write({ mode: 'insert' })`
reject duplicates. In Postgres, `NULL`s compare as distinct, so a unique constraint
over a `NULL`-containing column never fires and `insert` silently stops rejecting
duplicates. An empty string makes the constraint mean the same thing on every
provider.

### The compound unique name

`write({ mode: 'upsert' })` needs the name of the compound unique. Prisma exposes an
unnamed `@@unique([...])` under a **snake_case join of the field names**:

```
subjectType_subjectId_subjectRelation_relation_resourceType_resourceId_condition
```

That is the default, and it is *not* the same as the CamelCase name of the
underlying index in the database. If you named the constraint explicitly, pass it:

```ts
prismaStore(prisma, { model: 'MyTuple', uniqueKeyName: 'my_tuple_key' });
```

Both `model` and `uniqueKeyName` exist because the model name is yours to choose.

## Transactions

Pass a transaction client to enlist a write in the caller's transaction:

```ts
await prisma.$transaction(async (tx) => {
  await updateDocument(tx);
  await prismaStore(tx).write({ tuples: [tuple] });
});
```

Unlike the Drizzle adapter there is no sync-driver caveat: `$transaction` with an
async callback is the normal Prisma 7 shape.

## Notes

- `pagination` is reported `false`: `read` honours `limit` but returns no cursor.
- `delete({ kind: 'replace' })` runs inside `$transaction`, so it is atomic.
- `createMany` is used for `insert`; a key collision fails the whole batch.

## License

MIT
