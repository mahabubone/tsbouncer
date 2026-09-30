import { assertGolden, type GoldenOutcome, runGolden } from '@tsbouncer/testkit';
import { describe, expect, it } from 'vitest';
import { kyselyStore } from '../src/index.js';
import { createPgDb, type PgHandle } from './db.pg.js';

/**
 * The shared golden dataset against real PostgreSQL. Same skip rule as
 * `conformance-pg.test.ts`: no `TSBUNCER_PG_URL`, no run, CI unaffected.
 */
const PG_URL = process.env.TSBUNCER_PG_URL;

describe.skipIf(!PG_URL)('golden (postgres)', () => {
  let handle: PgHandle | undefined;

  it('answers the shared dataset as every other store does', async () => {
    handle = await createPgDb(PG_URL as string);
    try {
      assertGolden(await runGolden(kyselyStore(handle.db, { table: handle.table })));
    } finally {
      await handle.destroy();
      handle = undefined;
    }
  });

  it('answers identically against a recreated table', async () => {
    handle = await createPgDb(PG_URL as string);
    let first: GoldenOutcome | undefined;
    try {
      first = await runGolden(kyselyStore(handle.db, { table: handle.table }));
    } finally {
      await handle.destroy();
      handle = undefined;
    }

    handle = await createPgDb(PG_URL as string);
    try {
      expect(await runGolden(kyselyStore(handle.db, { table: handle.table }))).toEqual(
        first,
      );
    } finally {
      await handle.destroy();
      handle = undefined;
    }
  });
});
