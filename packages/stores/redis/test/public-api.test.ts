// biome-ignore-all lint/performance/noDynamicNamespaceImportAccess: enumerating the export surface by name is the point of this test
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('public API surface', () => {
  it('exports both ports', () => {
    expect(api.redisStore).toBeTypeOf('function');
    expect(api.redisCache).toBeTypeOf('function');
  });
});
