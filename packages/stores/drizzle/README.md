# @tsbouncer/drizzle

A [`TupleStore`](../../core) over an application-owned [Drizzle](https://orm.drizzle.team) instance.

Pass the same `db` your app already uses, plus the exact table object you declared
in your schema. Drizzle builds SQL from a table's column metadata, so the store and
the schema must share one instance.

```bash
npm i @tsbouncer/drizzle drizzle-orm
```

## Setup

Export a table from the schema module so `drizzle-kit` sees it and generates the
migration:

```ts
// schema.ts
import { sqliteTsbouncerTuples } from '@tsbouncer/drizzle';
export const tsbouncerTuples = sqliteTsbouncerTuples();
```

```ts
// app.ts
import { drizzleStore } from '@tsbouncer/drizzle';
import { tsbouncerTuples } from './schema.js';

const store = drizzleStore(db, tsbouncerTuples);
```

Factories exist for all three dialects: `sqliteTsbouncerTuples`,
`pgTsbouncerTuples`, `mysqlTsbouncerTuples`. All three produce the same columns, so
moving between databases does not mean moving data.

## The schema

Identical to the Kysely and Prisma adapters, so you can switch adapters without a
data migration. `subjectRelation` and `condition` are `''` when absent and are
`NOT NULL` — see the note below. `context` is a JSON string or `NULL`.

### Why absent values are `''` and not `NULL`

A unique index over the seven key columns is what makes `write({ mode: 'insert' })`
reject duplicates. In Postgres, `NULL`s compare as distinct, so a unique index
containing a `NULL` never fires and `insert` silently stops rejecting duplicates.
Every key column is therefore `NOT NULL` with `''` meaning absent.

## Driver sync or async

Drizzle's transaction helper is strict in both directions:

- a **synchronous** driver (better-sqlite3, bun:sqlite) throws
  `Transaction function cannot return a promise` if the callback returns a promise;
- an **asynchronous** driver commits as soon as the callback returns, so a body
  that does not `await` lets the COMMIT happen before the work is finished.

So the store has to know which it is, and it detects rather than assumes. It
inspects the underlying client's `prepare` (present on the sync SQLite clients,
absent on libsql/pg/mysql2). **It does not** check the query builder: `select()` and
`insert()` builders expose `run`, `all`, and `execute` on *both* kinds, so that
check classifies every async driver as sync — which silently commits transactions
early.

If your client is unrecognised the store **refuses to start** rather than guessing:

```ts
drizzleStore(db, tsbouncerTuples, { driverKind: 'async' });
```

This matters for transaction-scoped stores. A Drizzle transaction handle has no
`$client` of its own, so the store looks through `tx.session.client` to find the
same client.

## Transactions

```ts
await db.transaction(async (tx) => {
  await updateDocument(tx);
  await drizzleStore(tx, tsbouncerTuples).write({ tuples: [tuple] });
});
```

On a *synchronous* driver the callback must not be async, so issue the write without
returning its promise and await afterwards. The write itself is applied
synchronously, before the first `await` inside `write`.

## Upsert

`write({ mode: 'upsert' })` uses the dialect's own conflict clause, chosen by asking
the builder which one it exposes: `onConflictDoUpdate` (SQLite, Postgres) or
`onDuplicateKeyUpdate` (MySQL). Both are awaitable, so upsert needs no transaction
on either driver kind.

## Notes

- `pagination` is reported `false`: `read` honours `limit` but returns no cursor.
- `delete({ kind: 'filter', query: {} })` with no filters deletes **everything**,
  matching `read({})` returning everything.

## License

MIT
