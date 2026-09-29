import { type Authz, createAuthz } from '@tsbouncer/core';
import { jsonStore } from '@tsbouncer/json';
import { createTupleTableSql, kyselyStore } from '@tsbouncer/kysely';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { model } from './model.js';

export type StoreName = 'json' | 'sqlite';

export interface AppContext {
  readonly authz: Authz;
  close(): Promise<void>;
}

/**
 * Two backends, one client.
 *
 * Nothing in `createApp` knows which one it got. That is the whole argument for
 * keeping filtered reads as the only mandatory primitive: swapping a file for a
 * database is a one-line change here and zero changes everywhere else.
 */
export async function createContext(store: StoreName, file: string): Promise<AppContext> {
  if (store === 'json') {
    return {
      authz: createAuthz({ model, store: jsonStore({ file }) }),
      close: async () => {},
    };
  }

  // SQLite needs the table, and the adapter ships the DDL so an app's migration
  // and its authorization schema cannot drift apart.
  const raw = new Database(file);
  raw.exec(createTupleTableSql('sqlite'));
  const db = new Kysely<unknown>({ dialect: new SqliteDialect({ database: raw }) });

  return {
    authz: createAuthz({ model, store: kyselyStore(db) }),
    async close() {
      await db.destroy();
      raw.close();
    },
  };
}
