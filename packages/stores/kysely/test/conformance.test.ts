import { storeConformance } from '@tsbouncer/testkit';
import { kyselyStore } from '../src/index.js';
import { createDb, type Handle } from './db.js';

let handle: Handle | undefined;

storeConformance({
  name: 'kyselyStore (sqlite)',
  skip: ['pagination'],
  async create() {
    handle = createDb();
    return kyselyStore(handle.db);
  },
  async teardown() {
    await handle?.destroy();
    handle = undefined;
  },
});
