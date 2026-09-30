import { storeConformance } from '@tsbouncer/testkit';
import { describe } from 'vitest';
import { kyselyStore } from '../src/index.js';
import { createPgDb, type PgHandle } from './db.pg.js';

/**
 * The same conformance suite the SQLite run executes, against real PostgreSQL.
 *
 * Skipped without `TSBUNCER_PG_URL` — CI never sets it, on purpose. See
 * `db.pg.ts` for the one-command local database.
 */
const PG_URL = process.env.TSBUNCER_PG_URL;

describe.skipIf(!PG_URL)('kyselyStore (postgres)', () => {
  let handle: PgHandle | undefined;

  storeConformance({
    name: 'kyselyStore (postgres)',
    skip: ['pagination'],
    async create() {
      handle = await createPgDb(PG_URL as string);
      return kyselyStore(handle.db, { table: handle.table });
    },
    async teardown() {
      await handle?.destroy();
      handle = undefined;
    },
  });
});
