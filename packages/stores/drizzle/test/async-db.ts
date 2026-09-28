import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTsbouncerTuples } from '../src/index.js';

type Tuples = ReturnType<typeof sqliteTsbouncerTuples>;
type Schema = { tsbouncerTuples: Tuples };

export interface Handle {
  db: ReturnType<typeof drizzle<Schema>>;
  client: Client;
  tuples: Tuples;
  destroy(): Promise<void>;
}

/**
 * A **real asynchronous** driver, backed by libsql over a temp file.
 *
 * better-sqlite3 is synchronous, and drizzle refuses a promise-returning
 * transaction callback on it, so it can only exercise one half of the adapter.
 * libsql is promise-based, which means this handle is the only way to cover the
 * `execute()`/`$transaction` branch that every Postgres and MySQL deployment
 * takes. A hand-rolled double would have tested the shape of the code rather
 * than its behaviour; this tests the behaviour.
 */
export function createAsyncDb(): Handle {
  const path = `/tmp/tsbouncer-drizzle-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
  const client = createClient({ url: `file:${path}` });
  const tuples = sqliteTsbouncerTuples();
  const db = drizzle(client, { schema: { tsbouncerTuples: tuples } });

  return {
    db,
    client,
    tuples,
    async destroy() {
      client.close();
    },
  };
}

const CREATE_DDL = `CREATE TABLE IF NOT EXISTS tsbouncer_tuples (
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, subject_relation TEXT NOT NULL,
  relation TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
  condition TEXT NOT NULL, context TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS tsbouncer_tuples_key ON tsbouncer_tuples
  (subject_type, subject_id, subject_relation, relation, resource_type, resource_id, condition);
CREATE INDEX IF NOT EXISTS tsbouncer_tuples_subject ON tsbouncer_tuples (subject_type, subject_id, relation);
CREATE INDEX IF NOT EXISTS tsbouncer_tuples_ttu ON tsbouncer_tuples (relation, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS tsbouncer_tuples_list ON tsbouncer_tuples (resource_type, resource_id);
`;

export async function ensureTable(handle: Handle): Promise<void> {
  for (const statement of CREATE_DDL.split(';\n')) {
    const sql = statement.trim();
    if (sql.length > 0) await handle.client.execute(sql);
  }
}
