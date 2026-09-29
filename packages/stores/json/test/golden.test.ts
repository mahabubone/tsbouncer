import { assertGolden, runGolden } from '@tsbouncer/testkit';
import { afterAll, expect, it } from 'vitest';
import { cleanup, freshStore } from './helpers.js';

afterAll(cleanup);

it('answers the shared dataset as every other store does', async () => {
  assertGolden(await runGolden(freshStore()));
});

it('answers identically after reopening the file', async () => {
  const first = await runGolden(freshStore());
  expect(await runGolden(freshStore())).toEqual(first);
});
