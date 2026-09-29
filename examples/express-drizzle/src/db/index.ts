import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TupleStore } from '@tsbouncer/core';
import { drizzleStore } from '@tsbouncer/drizzle';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  documents,
  folders,
  organizations,
  projects,
  tsbouncerTuples,
  users,
} from './schema.js';

/**
 * Opening the database.
 *
 * Two handles come out of this and they are not interchangeable:
 *
 *   `db`    — the Drizzle client the application queries with. TypeScript knows
 *             every table, so `db.select().from(documents)` is checked.
 *   `store` — the tuple store, which knows about exactly one table and answers
 *             filtered reads. It takes no part in the application's own queries.
 *
 * Keeping them separate is the point of the adapter contract: the application
 * brings its own ORM, and authorization needs one filtered-read primitive rather
 * than a rewrite of the whole data layer.
 */

/** Every table, so `db.select().from(users)` is typed. */
const schema = { documents, folders, organizations, projects, tsbouncerTuples, users };

function createClient(raw: Database.Database) {
  return drizzle(raw, { schema });
}

export type Db = ReturnType<typeof createClient>;

export interface Handle {
  readonly db: Db;
  readonly store: TupleStore;
  close(): void;
}

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
);

/**
 * Apply any migration this database has not seen.
 *
 * Small, and small on purpose: a table recording what has run, then each file in
 * order. The alternative — running the SQL unconditionally — is not a shortcut,
 * it is a bug, and the first thing that finds it is the second process to open the
 * file. That is why the suite has a test that boots two servers over one file.
 */
function migrate(raw: Database.Database): void {
  raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL)');
  const applied = raw.prepare('SELECT name FROM _migrations');
  const done = new Set(applied.all().map((row) => (row as { name: string }).name));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name: string) => name.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (done.has(file)) continue;
    raw.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    raw.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  }
}

/**
 * Open (or create) a database file and bring the schema up to date.
 *
 * `better-sqlite3` is a *synchronous* driver, and the store works that out for
 * itself by inspecting the client rather than by probing a query builder — builders
 * expose `run`/`all`/`execute` on both sync and async drivers, so probing would
 * classify every async driver as sync and quietly commit transactions before their
 * work landed. For a client it does not recognise it refuses to start; the escape
 * hatch is `drizzleStore(db, tsbouncerTuples, { driverKind: 'async' })`.
 */
export function openDatabase(file: string): Handle {
  const raw = new Database(file);
  migrate(raw);

  const db = createClient(raw);
  return { db, store: drizzleStore(db, tsbouncerTuples), close: () => raw.close() };
}
