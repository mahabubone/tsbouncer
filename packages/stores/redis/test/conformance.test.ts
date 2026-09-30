import { storeConformance } from '@tsbouncer/testkit';
import { describe } from 'vitest';
import { createDb, type Handle, REDIS_URL } from './db.js';

/**
 * The full conformance suite against live Redis. Skipped without
 * `TSBUNCER_REDIS_URL` — CI never sets it, on purpose. Each case gets a
 * uuid-namespaced store, so parallel runs cannot see each other.
 */
describe.skipIf(!REDIS_URL)('redisStore', () => {
  let handle: Handle | undefined;

  storeConformance({
    name: 'redisStore',
    async create() {
      handle = await createDb();
      return handle.store;
    },
    async teardown() {
      await handle?.destroy();
      handle = undefined;
    },
  });
});
