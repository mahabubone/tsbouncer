import { cacheConformance } from '@tsbouncer/testkit';
import { memoryCache } from '../src/index.js';

cacheConformance({ name: 'memoryCache', create: () => memoryCache() });
