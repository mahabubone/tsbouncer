import { storeConformance } from '@tsbouncer/testkit';
import { memoryStore } from '../src/index.js';

storeConformance({ name: 'memoryStore', create: () => memoryStore() });
