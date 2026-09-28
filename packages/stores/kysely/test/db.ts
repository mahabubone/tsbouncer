import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { createTupleTableSql, dropTupleTableSql } from '../src/index.js';

export type TestDb = Kysely<unknown>;

export interface Handle {
  db: TestDb;
  raw: Database.Database;
  destroy(): Promise<void>;
}

/** A fresh in-memory SQLite database with the tuples table applied. */
export function createDb(): Handle {
  const raw = new Database(':memory:');
  raw.exec(createTupleTableSql('sqlite'));
  const db = new Kysely<unknown>({ dialect: new SqliteDialect({ database: raw }) });

  return {
    db,
    raw,
    async destroy() {
      await db.destroy();
    },
  };
}

export function recreateTable(handle: Handle): void {
  handle.raw.exec(dropTupleTableSql('sqlite'));
  handle.raw.exec(createTupleTableSql('sqlite'));
}
