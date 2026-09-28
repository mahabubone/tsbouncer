import type { Tuple } from '@tsbouncer/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drizzleStore } from '../src/index.js';
import { createAsyncDb, ensureTable, type Handle } from './async-db.js';

/**
 * Paths that only exist on an asynchronous driver. better-sqlite3 cannot reach
 * them — drizzle rejects a promise-returning transaction callback on it — so
 * these are the branch every Postgres and MySQL deployment actually takes.
 */

const T = (subject: string, relation: string, resource: string): Tuple => ({
  subject,
  relation,
  resource,
});

let handle: Handle;

beforeEach(async () => {
  handle = createAsyncDb();
  await ensureTable(handle);
});

afterEach(async () => {
  await handle.destroy();
});

const store = () => drizzleStore(handle.db, handle.tuples);

describe('async transactions', () => {
  it('accepts an awaited write inside a transaction', async () => {
    const s = store();
    await handle.db.transaction(async (tx) => {
      await drizzleStore(tx, handle.tuples).write({
        tuples: [T('user:alice', 'viewer', 'document:1')],
      });
      // Visible inside the transaction, before it commits.
      expect((await drizzleStore(tx, handle.tuples).read()).items).toHaveLength(1);
    });
    expect((await s.read()).items).toHaveLength(1);
  });

  it('commits an awaited replace', async () => {
    const s = store();
    await s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    await s.delete({
      kind: 'replace',
      query: { resource: 'document:1' },
      tuples: [T('user:carol', 'viewer', 'document:1')],
    });
    expect(
      (await s.read({ resource: 'document:1' })).items.map((t) => t.subject),
    ).toEqual(['user:carol']);
  });

  it('rolls back a replace with the surrounding transaction', async () => {
    const s = store();
    await s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    await expect(
      handle.db.transaction(async (tx) => {
        await drizzleStore(tx, handle.tuples).delete({
          kind: 'filter',
          query: { resource: 'document:1' },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await s.read()).items).toHaveLength(1);
  });
});

describe('async upsert', () => {
  it('replaces context through the conflict clause', async () => {
    const s = store();
    const base = { ...T('user:a', 'viewer', 'document:1'), condition: 'inRegion' };
    await s.write({ tuples: [{ ...base, context: { region: 'eu' } }] });
    await s.write({ tuples: [{ ...base, context: { region: 'us' } }], mode: 'upsert' });
    const found = await s.read();
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.context).toEqual({ region: 'us' });
  });

  it('rejects a duplicate in insert mode', async () => {
    const s = store();
    await s.write({ tuples: [T('user:a', 'viewer', 'document:1')] });
    await expect(
      s.write({ tuples: [T('user:a', 'viewer', 'document:1')] }),
    ).rejects.toThrow(/unique constraint/);
  });
});

describe('async reads', () => {
  it('applies filters', async () => {
    const s = store();
    await s.write({
      tuples: [
        T('user:alice', 'viewer', 'document:1'),
        T('user:bob', 'editor', 'document:2'),
        T('team:eng#member', 'viewer', 'document:1'),
      ],
    });
    expect((await s.read({ subject: 'user:alice' })).items).toHaveLength(1);
    expect((await s.read({ relation: 'viewer' })).items).toHaveLength(2);
    expect((await s.read({ resource: 'document:1' })).items).toHaveLength(2);
    expect((await s.read({ subject: ['user:alice', 'user:bob'] })).items).toHaveLength(2);
  });

  it('deletes a batch of tuples by key', async () => {
    const s = store();
    await s.write({
      tuples: [
        T('user:alice', 'viewer', 'document:1'),
        T('user:bob', 'viewer', 'document:1'),
      ],
    });
    await s.delete({
      kind: 'tuples',
      tuples: [T('user:alice', 'viewer', 'document:1')],
    });
    expect((await s.read()).items.map((t) => t.subject)).toEqual(['user:bob']);
  });

  it('honours limit', async () => {
    const s = store();
    await s.write({
      tuples: Array.from({ length: 4 }, (_, i) =>
        T(`user:u${i}`, 'viewer', 'document:1'),
      ),
    });
    expect((await s.read({ limit: 2 })).items).toHaveLength(2);
  });
});
