import { assertGolden, runGolden } from '@tsbouncer/testkit';
import { expect, it } from 'vitest';
import { drizzleStore } from '../src/index.js';
import { createDb, type Handle } from './db.js';

it('answers the shared dataset as every other store does', async () => {
  const handle: Handle = createDb();
  assertGolden(await runGolden(drizzleStore(handle.db, handle.tuples)));
  handle.destroy();
});

it('answers identically against a fresh database', async () => {
  const first = createDb();
  const outcome = await runGolden(drizzleStore(first.db, first.tuples));

  const second = createDb();
  expect(await runGolden(drizzleStore(second.db, second.tuples))).toEqual(outcome);

  first.destroy();
  second.destroy();
});
