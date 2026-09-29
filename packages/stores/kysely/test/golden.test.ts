import { assertGolden, runGolden } from '@tsbouncer/testkit';
import { expect, it } from 'vitest';
import { kyselyStore } from '../src/index.js';
import { createDb, type Handle, recreateTable } from './db.js';

let handle: Handle | undefined;

it('answers the shared dataset as every other store does', async () => {
  handle = createDb();
  assertGolden(await runGolden(kyselyStore(handle.db)));
  await handle.destroy();
  handle = undefined;
});

it('answers identically against a recreated table', async () => {
  handle = createDb();
  const first = await runGolden(kyselyStore(handle.db));

  recreateTable(handle);
  expect(await runGolden(kyselyStore(handle.db))).toEqual(first);

  await handle.destroy();
  handle = undefined;
});
