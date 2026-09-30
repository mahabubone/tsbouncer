import { storeConformance } from '@tsbouncer/testkit';
import { afterAll } from 'vitest';
import { cleanup, freshStore } from './helpers.js';

afterAll(cleanup);

storeConformance({
  name: 'jsonStore',
  skip: ['pagination'],
  create: () => freshStore(),
  teardown: cleanup,
});
