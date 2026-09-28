import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTsbouncerTuples } from '../src/index.js';

type Tuples = ReturnType<typeof sqliteTsbouncerTuples>;
type Schema = { tsbouncerTuples: Tuples };

export interface Handle {
  db: ReturnType<typeof drizzle<Schema>>;
  raw: Database.Database;
  tuples: Tuples;
  destroy(): void;
}

/**
 * A fresh in-memory SQLite database with the tuples table created from the same
 * factory users put in their schema — so the store is exercised against real
 * Drizzle column metadata rather than a hand-rolled mock.
 */
export function createDb(): Handle {
  const raw = new Database(':memory:');
  const tuples = sqliteTsbouncerTuples();
  const db = drizzle(raw, { schema: { tsbouncerTuples: tuples } });
  raw.exec(CREATE_DDL);
  return { db, raw, tuples, destroy: () => raw.close() };
}

const CREATE_DDL = `CREATE TABLE tsbouncer_tuples (
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_relation TEXT NOT NULL,
  relation TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  condition TEXT NOT NULL,
  context TEXT
);
CREATE UNIQUE INDEX tsbouncer_tuples_key ON tsbouncer_tuples
  (subject_type, subject_id, subject_relation, relation, resource_type, resource_id, condition);
CREATE INDEX tsbouncer_tuples_subject ON tsbouncer_tuples (subject_type, subject_id, relation);
CREATE INDEX tsbouncer_tuples_ttu ON tsbouncer_tuples (relation, resource_type, resource_id);
CREATE INDEX tsbouncer_tuples_list ON tsbouncer_tuples (resource_type, resource_id);
`;
