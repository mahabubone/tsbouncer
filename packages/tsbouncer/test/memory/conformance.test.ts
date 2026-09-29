import { storeConformance } from '@tsbouncer/testkit';
import { memoryStore } from '../../src/memory/index.js';

storeConformance({ name: 'memoryStore', create: () => memoryStore() });
