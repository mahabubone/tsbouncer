# @tsbouncer/kysely

A [`TupleStore`](../../core) over an application-owned [Kysely](https://kysely.dev) instance.

Pass the same Kysely instance your app already uses. `tsbouncer` does not own your
connection, your pool, or your transaction lifecycle.

```bash
npm i @tsbouncer/kysely kysely
```

## Setup

Run the DDL in a migration. Do not run it on every boot.

```ts
import { createTupleTableSql } from '@tsbouncer/kysely';

export const up = (db: Kysely<unknown>) => db.executeRaw(createTupleTableSql('postgres'));
```

```ts
import { kyselyStore } from '@tsbouncer/kysely';

const store = kyselyStore(db);
```

## The schema

One table, `tsbouncer_tuples`. References are split across `subject_type` /
`subject_id` / `subject_relation` (and the `resource_` pair) rather than stored as
one string, because `read()` is conjunctive equality and each filter needs to be an
indexable predicate.

| column | meaning |
| --- | --- |
| `subject_type`, `subject_id`, `subject_relation` | the subject, split. `subject_relation` is `''` for a direct subject |
| `relation` | the edge name |
| `resource_type`, `resource_id` | the resource, split. always a direct reference |
| `condition` | condition name, or `''` |
| `context` | condition parameters as JSON, or `NULL` |

The three indexes are not decoration — each backs a query the evaluator issues:
`(subject_type, subject_id, relation)` for reverse walks, `(relation,
resource_type, resource_id)` for tuple-to-userset traversal, and
`(resource_type, resource_id)` for `listResources` / `expand`.

### Why absent values are `''` and not `NULL`

A unique constraint over the seven key columns is how `write({ mode: 'insert' })`
detects duplicates. In Postgres `NULL`s compare as distinct, so a unique index
containing a `NULL` column never fires — every unconditioned tuple would sail past
the constraint and `insert` would silently stop rejecting duplicates. MySQL and
SQLite each have their own `NULL`-in-unique behaviour. An empty string makes the
constraint mean the same thing everywhere.

This is a storage detail. The `Tuple` type you pass and receive still uses
`undefined`.

## Transactions

Pass a transaction handle to enlist a write in the caller's transaction:

```ts
await db.transaction().execute(async (trx) => {
  await updateDocument(trx);
  await kyselyStore(trx).write({ tuples: [tuple] });
});
```

## Upsert

`write({ mode: 'upsert' })` deletes the keys and re-inserts, inside a transaction.

`ON CONFLICT` covers SQLite and Postgres, but MySQL spells the same idea `ON
DUPLICATE KEY UPDATE`, which Kysely's `onConflict` does not emit. Detecting the
dialect from a Kysely instance is guesswork when a pooler sits between the driver
and the server, so the portable path is used instead. Authorization writes are
low-volume; if throughput ever becomes the problem, branch per driver.

## Notes

- `pagination` is reported `false`: `read` honours `limit` but returns no cursor.
- Pass `batchSize` (default 500) to cap rows per `INSERT` if your driver has a
  parameter limit below `8 × batchSize`.

## License

MIT
