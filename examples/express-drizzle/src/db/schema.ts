import { sqliteTsbouncerTuples } from '@tsbouncer/drizzle';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The application's own tables.
 *
 * This is the important structural decision in the whole example, and it is the
 * one to copy: **domain rows here, access edges in the tuple table.** A
 * `documents` table knows a document's title and its folder. It does not know who
 * may read it, and there is no `owner_id` column to migrate every time the access
 * rules change.
 *
 * The two halves share opaque ids — `document:5` means the row with `id = 5` — and
 * that is all the coupling there is. The engine never resolves a reference to a
 * row; it evaluates edges. Swapping SQLite for Postgres means rewriting these
 * declarations and nothing else in the access layer.
 */

/**
 * The authorization table, built by the store's factory.
 *
 * It is a *factory* rather than an exported constant so that the table is declared
 * here, in the module `drizzle-kit` reads — and so the store and the schema are
 * guaranteed to be the same object. `drizzleStore(db, tsbouncerTuples)` has to be
 * handed this exact instance, because Drizzle builds its SQL from the column
 * metadata on it.
 *
 * Two contract details, both load-bearing and both owned by the package rather
 * than by this example: every key column is `NOT NULL` with `''` meaning absent
 * (a `NULL` in a unique index never fires, so `insert` would stop rejecting
 * duplicates), and there is a unique index over the seven key columns.
 */
export const tsbouncerTuples = sqliteTsbouncerTuples();

export const organizations = sqliteTable('organizations', {
  id: text('id').notNull().primaryKey(),
  name: text('name').notNull(),
  plan: text('plan', { enum: ['free', 'pro', 'enterprise'] }).notNull(),
  /**
   * Where this tenant's data lives, and how much of its seat allowance is used.
   *
   * Both are read by the API and handed to the evaluator as request context. They
   * are *not* part of any grant: a grant never says "the caller is in the EU", it
   * says "this grant requires the request to say the caller is in the EU" — and the
   * request only says it because the application looked it up here, in its own
   * database, and not from anything the client sent.
   */
  region: text('region', { enum: ['eu', 'us'] }).notNull(),
  seatsUsed: integer('seats_used').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').notNull().primaryKey(),
  name: text('name').notNull(),
  /**
   * The caller's own attributes, stored on the user row.
   *
   * They are here to be *read* by the API and handed to the evaluator as request
   * context. They are not part of any grant: a grant never says "this user is
   * suspended", it says "this grant requires the request to say the caller is not".
   */
  region: text('region', { enum: ['eu', 'us'] }).notNull(),
  suspended: integer('suspended', { mode: 'boolean' }).notNull().default(false),
});

export const projects = sqliteTable('projects', {
  id: text('id').notNull().primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  name: text('name').notNull(),
});

export const folders = sqliteTable('folders', {
  id: text('id').notNull().primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  parentId: text('parent_id'),
  name: text('name').notNull(),
});

export const documents = sqliteTable('documents', {
  id: text('id').notNull().primaryKey(),
  folderId: text('folder_id')
    .notNull()
    .references(() => folders.id),
  title: text('title').notNull(),
  region: text('region', { enum: ['eu', 'us'] }).notNull(),
  /** Set while a document is under legal hold: readable, not writable. */
  onHold: integer('on_hold', { mode: 'boolean' }).notNull().default(false),
});
