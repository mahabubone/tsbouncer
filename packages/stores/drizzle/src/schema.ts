import {
  index as myIndex,
  mysqlTable,
  text as myText,
  uniqueIndex as myUniqueIndex,
  varchar as myVarchar,
} from 'drizzle-orm/mysql-core';
import {
  index as pgIndex,
  pgTable,
  text as pgText,
  uniqueIndex as pgUniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const TABLE = 'tsbouncer_tuples';
export const NULL_ABSENT = '';

/**
 * Table factories for all three dialects.
 *
 * These are factories rather than exported constants on purpose: a Drizzle
 * schema is a module you build, and a table has to be declared *inside* it for
 * `drizzle-kit` to pick it up and generate the migration. Export the one your
 * schema uses:
 *
 *   // schema.ts
 *   import { sqliteTsbouncerTuples } from '@tsbouncer/drizzle';
 *   export const tsbouncerTuples = sqliteTsbouncerTuples();
 *
 * Then pass the same instance to `drizzleStore(db, tsbouncerTuples)`. The store
 * and the schema must agree on one object, or Drizzle has no column metadata to
 * build SQL from.
 *
 * The column set is the one `@tsbouncer/kysely` and `@tsbouncer/prisma` expect —
 * same names, same order, same `''`-for-absent rule — so an application can move
 * between adapters without migrating its data. Only MySQL's declared *widths*
 * differ, because InnoDB refuses to create the unique index over anything wider
 * (see `mysqlTsbouncerTuples`). Absent values are `''`, never NULL — see
 * `NULL_ABSENT` in `@tsbouncer/kysely` for why.
 */
export function sqliteTsbouncerTuples() {
  return sqliteTable(
    TABLE,
    {
      subjectType: text('subject_type', { length: 255 }).notNull(),
      subjectId: text('subject_id').notNull(),
      subjectRelation: text('subject_relation', { length: 255 }).notNull(),
      relation: text('relation', { length: 255 }).notNull(),
      resourceType: text('resource_type', { length: 255 }).notNull(),
      resourceId: text('resource_id').notNull(),
      condition: text('condition', { length: 255 }).notNull(),
      context: text('context'),
    },
    (t) => [
      uniqueIndex('tsbouncer_tuples_key').on(
        t.subjectType,
        t.subjectId,
        t.subjectRelation,
        t.relation,
        t.resourceType,
        t.resourceId,
        t.condition,
      ),
      index('tsbouncer_tuples_subject').on(t.subjectType, t.subjectId, t.relation),
      index('tsbouncer_tuples_ttu').on(t.relation, t.resourceType, t.resourceId),
      index('tsbouncer_tuples_list').on(t.resourceType, t.resourceId),
    ],
  );
}

export function pgTsbouncerTuples() {
  return pgTable(
    TABLE,
    {
      subjectType: pgText('subject_type').notNull(),
      subjectId: pgText('subject_id').notNull(),
      subjectRelation: varchar('subject_relation', { length: 255 }).notNull(),
      relation: varchar('relation', { length: 255 }).notNull(),
      resourceType: varchar('resource_type', { length: 255 }).notNull(),
      resourceId: pgText('resource_id').notNull(),
      condition: varchar('condition', { length: 255 }).notNull(),
      context: pgText('context'),
    },
    (t) => [
      pgUniqueIndex('tsbouncer_tuples_key').on(
        t.subjectType,
        t.subjectId,
        t.subjectRelation,
        t.relation,
        t.resourceType,
        t.resourceId,
        t.condition,
      ),
      pgIndex('tsbouncer_tuples_subject').on(t.subjectType, t.subjectId, t.relation),
      pgIndex('tsbouncer_tuples_ttu').on(t.relation, t.resourceType, t.resourceId),
      pgIndex('tsbouncer_tuples_list').on(t.resourceType, t.resourceId),
    ],
  );
}

export function mysqlTsbouncerTuples() {
  // MySQL is the only dialect that checks the index size when the table is
  // *created*: InnoDB caps a key at 3072 bytes, and the seven key columns as
  // `VARCHAR(255)` / `TEXT` in utf8mb4 come to ~9196 bytes — so `CREATE TABLE`
  // fails with ERROR 1071 (or 1170 for the `TEXT` columns, which need a prefix
  // length) before a row can be written. Narrowing the columns is the fix that
  // keeps uniqueness exact: a prefix length would compare only the first N
  // characters and start rejecting two distinct ids that happen to share them.
  // SQLite and Postgres have no DDL-time limit, so they keep their wider types.
  return mysqlTable(
    TABLE,
    {
      subjectType: myVarchar('subject_type', { length: 64 }).notNull(),
      subjectId: myVarchar('subject_id', { length: 191 }).notNull(),
      subjectRelation: myVarchar('subject_relation', { length: 64 }).notNull(),
      relation: myVarchar('relation', { length: 64 }).notNull(),
      resourceType: myVarchar('resource_type', { length: 64 }).notNull(),
      resourceId: myVarchar('resource_id', { length: 191 }).notNull(),
      condition: myVarchar('condition', { length: 64 }).notNull(),
      context: myText('context'),
    },
    (t) => [
      myUniqueIndex('tsbouncer_tuples_key').on(
        t.subjectType,
        t.subjectId,
        t.subjectRelation,
        t.relation,
        t.resourceType,
        t.resourceId,
        t.condition,
      ),
      myIndex('tsbouncer_tuples_subject').on(t.subjectType, t.subjectId, t.relation),
      myIndex('tsbouncer_tuples_ttu').on(t.relation, t.resourceType, t.resourceId),
      myIndex('tsbouncer_tuples_list').on(t.resourceType, t.resourceId),
    ],
  );
}

export type AnyTsbouncerTable =
  | ReturnType<typeof sqliteTsbouncerTuples>
  | ReturnType<typeof pgTsbouncerTuples>
  | ReturnType<typeof mysqlTsbouncerTuples>;

/** Row shape every dialect's table produces. */
export interface TupleRow {
  subjectType: string;
  subjectId: string;
  subjectRelation: string;
  relation: string;
  resourceType: string;
  resourceId: string;
  condition: string;
  context: string | null;
}
