import { assertGolden, runGolden } from '@tsbouncer/testkit';
import { expect, it } from 'vitest';
import { prismaStore } from '../src/index.js';
import { createDb, ensureTable, type Handle, truncate } from './db.js';

it('answers the shared dataset as every other store does', async () => {
  const handle: Handle = createDb();
  await ensureTable(handle);
  assertGolden(await runGolden(prismaStore(handle.prisma)));
  await truncate(handle);
  await handle.destroy();
});

it('answers identically against a truncated table', async () => {
  const handle: Handle = createDb();
  await ensureTable(handle);

  const first = await runGolden(prismaStore(handle.prisma));
  await truncate(handle);
  expect(await runGolden(prismaStore(handle.prisma))).toEqual(first);

  await handle.destroy();
});
