import { storeConformance } from '@tsbouncer/testkit';
import { drizzleStore } from '../src/index.js';
import { createDb, type Handle } from './db.js';

let handle: Handle | undefined;

storeConformance({
  name: 'drizzleStore (sqlite)',
  skip: ['pagination'],
  create() {
    handle = createDb();
    return drizzleStore(handle.db, handle.tuples);
  },
  teardown() {
    handle?.destroy();
    handle = undefined;
  },
});
