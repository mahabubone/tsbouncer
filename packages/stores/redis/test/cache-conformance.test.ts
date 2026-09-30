import { cacheConformance } from '@tsbouncer/testkit';
import { describe } from 'vitest';
import { redisCache } from '../src/index.js';
import { createDb, type Handle, REDIS_URL } from './db.js';

/**
 * The cache contract against live Redis. Same gating as the store suites:
 * without `TSBUNCER_REDIS_URL` this skips, and CI never sets it. A separate
 * client per case, so parallel runs cannot see each other — and teardown
 * deletes only the case's own prefix.
 */
describe.skipIf(!REDIS_URL)('redisCache', () => {
  let handle: Handle | undefined;

  cacheConformance({
    name: 'redisCache',
    async create() {
      handle = await createDb();
      return redisCache(handle.client, { prefix: handle.prefix });
    },
    async teardown() {
      await handle?.destroy();
      handle = undefined;
    },
  });
});
