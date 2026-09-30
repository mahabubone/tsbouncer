import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { createTupleTableSql, dropTupleTableSql } from '../src/index.js';

/**
 * Local QA against real PostgreSQL. Never runs in CI — CI is SQLite-only by
 * decision — and only runs at all when `TSBUNCER_PG_URL` is set, e.g.:
 *
 *   docker run -d --name tsbouncer-qa-pg -e POSTGRES_PASSWORD=tsbouncer-qa \
 *     -e POSTGRES_USER=tsbouncer -e POSTGRES_DB=tsbouncer \
 *     -p 5544:5432 postgres:16-alpine
 *   TSBUNCER_PG_URL=postgresql://tsbouncer:tsbouncer-qa@127.0.0.1:5544/tsbouncer \
 *     pnpm --filter @tsbouncer/kysely test test/conformance-pg.test.ts
 *
 * A dedicated table keeps QA clear of anything else in the database, and it is
 * dropped on teardown so repeated runs start identical.
 */
export const QA_TABLE_PREFIX = 'tsbouncer_tuples_qa';

export type PgHandle = {
  db: Kysely<unknown>;
  table: string;
  destroy(): Promise<void>;
};

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Every handle gets its own table. Test files run in parallel workers, so a
 * single shared name turns CREATE/DROP into a race on the catalog — Postgres
 * answers with `pg_type_typname_nsp_index` violations and missing relations,
 * and both look like store bugs when they are test bugs.
 */
export async function createPgDb(url: string): Promise<PgHandle> {
  const pool = new Pool({ connectionString: url });
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  const table = `${QA_TABLE_PREFIX}_${shortId()}`;
  await sql.raw(createTupleTableSql('postgres', table)).execute(db);
  return {
    db,
    table,
    async destroy() {
      try {
        await sql.raw(dropTupleTableSql('postgres', table)).execute(db);
      } finally {
        await db.destroy();
      }
    },
  };
}
