import { describe, expect, it } from 'vitest';
import { memoryStore } from '../src/index.js';

const TUPLE = {
  subject: 'user:alice',
  relation: 'viewer',
  resource: 'document:1',
} as const;

describe('pagination cursors', () => {
  it('rejects a cursor that is not a non-negative integer', async () => {
    const store = memoryStore({ tuples: [TUPLE] });
    for (const cursor of ['abc', '-1', '1.5', 'NaN', '']) {
      await expect(store.read({ cursor })).rejects.toThrow(/cursor/);
    }
  });

  it('treats an absent cursor as the first page', async () => {
    const store = memoryStore({ tuples: [TUPLE] });
    expect((await store.read()).items).toHaveLength(1);
  });

  it('returns nothing past the end', async () => {
    const store = memoryStore({ tuples: [TUPLE] });
    const page = await store.read({ cursor: '99' });
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeUndefined();
  });
});

describe('snapshot', () => {
  it('reflects writes and deletes', async () => {
    const store = memoryStore();
    expect(store.snapshot()).toEqual([]);
    await store.write({ tuples: [TUPLE] });
    expect(store.size()).toBe(1);
    await store.delete({ kind: 'tuples', tuples: [TUPLE] });
    expect(store.size()).toBe(0);
  });

  it('is a frozen copy that does not alias internal state', async () => {
    const store = memoryStore({ tuples: [TUPLE] });
    const first = store.snapshot();
    expect(Object.isFrozen(first)).toBe(true);
    await store.write({ tuples: [{ ...TUPLE, resource: 'document:2' }] });
    expect(first).toHaveLength(1);
    expect(store.snapshot()).toHaveLength(2);
  });
});
