import { assertGolden, type GoldenOutcome, runGolden } from '@tsbouncer/testkit';
import { describe, expect, it } from 'vitest';
import { createDb, type Handle, REDIS_URL } from './db.js';

describe.skipIf(!REDIS_URL)('golden (redis)', () => {
  let handle: Handle | undefined;

  it('answers the shared dataset as every other store does', async () => {
    handle = await createDb();
    try {
      assertGolden(await runGolden(handle.store));
    } finally {
      await handle.destroy();
      handle = undefined;
    }
  });

  it('answers identically against a recreated namespace', async () => {
    handle = await createDb();
    let first: GoldenOutcome | undefined;
    try {
      first = await runGolden(handle.store);
    } finally {
      await handle.destroy();
      handle = undefined;
    }

    handle = await createDb();
    try {
      expect(await runGolden(handle.store)).toEqual(first);
    } finally {
      await handle.destroy();
      handle = undefined;
    }
  });
});
