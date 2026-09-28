import { storeConformance } from '@tsbouncer/testkit';
import { drizzleStore } from '../src/index.js';
import { createAsyncDb, ensureTable, type Handle } from './async-db.js';

let handle: Handle | undefined;

/**
 * The same suite, against a real async driver. A store that only satisfies it on
 * a synchronous driver satisfies it on the wrong half of its users.
 */
storeConformance({
  name: 'drizzleStore (libsql, async driver)',
  skip: ['pagination'],
  async create() {
    handle = createAsyncDb();
    await ensureTable(handle);
    return drizzleStore(handle.db, handle.tuples);
  },
  async teardown() {
    await handle?.destroy();
    handle = undefined;
  },
});
