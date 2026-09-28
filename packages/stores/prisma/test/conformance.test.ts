import { storeConformance } from '@tsbouncer/testkit';
import { prismaStore } from '../src/index.js';
import { createDb, ensureTable, type Handle, truncate } from './db.js';

let handle: Handle | undefined;

storeConformance({
  name: 'prismaStore (sqlite)',
  skip: ['pagination'],
  async create() {
    handle = createDb();
    await ensureTable(handle);
    return prismaStore(handle.prisma);
  },
  async teardown() {
    if (handle) {
      await truncate(handle);
      await handle.destroy();
    }
    handle = undefined;
  },
});
