// biome-ignore-all lint/performance/noDynamicNamespaceImportAccess: enumerating the export surface by name is the point of this test
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('public API surface', () => {
  it('exports memoryStore', () => {
    expect(api.memoryStore).toBeTypeOf('function');
  });

  it('exports memoryCache', () => {
    expect(api.memoryCache).toBeTypeOf('function');
  });

  it('produces an isolated store per call', async () => {
    const a = api.memoryStore();
    const b = api.memoryStore();
    await a.write({
      tuples: [{ subject: 'user:alice', relation: 'viewer', resource: 'document:1' }],
    });
    expect((await a.read()).items.length).toBe(1);
    expect((await b.read()).items.length).toBe(0);
  });

  it('seeds from options', async () => {
    const store = api.memoryStore({
      tuples: [{ subject: 'user:alice', relation: 'viewer', resource: 'document:1' }],
    });
    expect(store.size()).toBe(1);
    expect(store.snapshot()).toHaveLength(1);
  });
});
