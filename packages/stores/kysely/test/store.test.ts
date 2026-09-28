import type { Tuple } from '@tsbouncer/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTupleTableSql,
  dropTupleTableSql,
  isDialect,
  kyselyStore,
} from '../src/index.js';
import { createDb, type Handle, recreateTable } from './db.js';

const T = (subject: string, relation: string, resource: string): Tuple => ({
  subject,
  relation,
  resource,
});

let handle: Handle;

beforeEach(() => {
  handle = createDb();
});

afterEach(async () => {
  await handle.destroy();
});

function store() {
  return kyselyStore(handle.db);
}

describe('multi-value filters', () => {
  it('matches either reference, not the cross product', async () => {
    const s = store();
    await s.write({
      tuples: [
        T('user:alice', 'viewer', 'document:1'),
        T('user:bob', 'viewer', 'document:1'),
        T('user:carol', 'viewer', 'document:1'),
        T('team:eng#member', 'viewer', 'document:1'),
      ],
    });

    const found = await s.read({ subject: ['user:alice', 'user:bob'] });
    expect(found.items.map((t) => t.subject).sort()).toEqual(['user:alice', 'user:bob']);
  });

  it('never pairs one reference type with another reference id', async () => {
    const s = store();
    // Only a userset row exists. A naive `type IN (...) AND id IN (...)` would
    // match it once a direct user of the same type is also requested.
    await s.write({
      tuples: [
        T('user:eng#member', 'viewer', 'document:1'),
        T('user:alice', 'viewer', 'document:1'),
      ],
    });

    const found = await s.read({ subject: ['user:alice', 'user:eng#member'] });
    expect(found.items).toHaveLength(2);
  });

  it('distinguishes a userset from a direct subject of the same name', async () => {
    const s = store();
    await s.write({
      tuples: [
        T('team:eng', 'viewer', 'document:1'),
        T('team:eng#member', 'viewer', 'document:1'),
      ],
    });

    expect((await s.read({ subject: 'team:eng' })).items).toHaveLength(1);
    expect((await s.read({ subject: 'team:eng#member' })).items).toHaveLength(1);
    expect((await s.read()).items).toHaveLength(2);
  });

  it('applies relation and resource filters alongside subject', async () => {
    const s = store();
    await s.write({
      tuples: [
        T('user:alice', 'viewer', 'document:1'),
        T('user:alice', 'editor', 'document:1'),
        T('user:alice', 'viewer', 'document:2'),
      ],
    });
    const found = await s.read({
      subject: 'user:alice',
      relation: 'viewer',
      resource: 'document:1',
    });
    expect(found.items).toHaveLength(1);
  });
});

describe('unique constraint', () => {
  it('rejects a duplicate key rather than silently upserting', async () => {
    const s = store();
    await s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    await expect(
      s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] }),
    ).rejects.toThrow(/unique constraint/);
  });

  it('keeps a conditioned tuple distinct from its unconditioned twin', async () => {
    const s = store();
    await s.write({
      tuples: [
        T('user:alice', 'viewer', 'document:1'),
        {
          ...T('user:alice', 'viewer', 'document:1'),
          condition: 'inRegion',
          context: { r: 'eu' },
        },
      ],
    });
    expect((await s.read()).items).toHaveLength(2);
  });

  it('rolls back the whole batch when one tuple is a duplicate', async () => {
    const s = store();
    await s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    await expect(
      s.write({
        tuples: [
          T('user:bob', 'viewer', 'document:1'),
          T('user:alice', 'viewer', 'document:1'),
        ],
      }),
    ).rejects.toThrow();
    expect((await s.read()).items.map((t) => t.subject)).toEqual(['user:alice']);
  });
});

describe('upsert', () => {
  it('replaces context on an existing key', async () => {
    const s = store();
    const base = { ...T('user:alice', 'viewer', 'document:1'), condition: 'inRegion' };
    await s.write({ tuples: [{ ...base, context: { region: 'eu' } }] });
    await s.write({
      tuples: [{ ...base, context: { region: 'us' } }],
      mode: 'upsert',
    });
    const found = await s.read();
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.context).toEqual({ region: 'us' });
  });

  it('inserts when the key is absent', async () => {
    const s = store();
    await s.write({ tuples: [T('user:alice', 'viewer', 'document:1')], mode: 'upsert' });
    expect((await s.read()).items).toHaveLength(1);
  });
});

describe('context', () => {
  it('round-trips a context object', async () => {
    const s = store();
    await s.write({
      tuples: [
        { ...T('user:a', 'viewer', 'document:1'), context: { tier: 'pro', seats: 3 } },
      ],
    });
    expect((await s.read()).items[0]?.context).toEqual({ tier: 'pro', seats: 3 });
  });

  it('round-trips an empty context object rather than dropping it', async () => {
    const s = store();
    await s.write({ tuples: [{ ...T('user:a', 'viewer', 'document:1'), context: {} }] });
    expect((await s.read()).items[0]?.context).toEqual({});
  });

  it('surfaces unparseable stored context instead of returning a broken tuple', async () => {
    const s = store();
    await s.write({ tuples: [T('user:a', 'viewer', 'document:1')] });
    handle.raw
      .prepare('UPDATE tsbouncer_tuples SET context = ? WHERE subject_id = ?')
      .run('{not json', 'a');
    await expect(s.read()).rejects.toThrow(/unparseable context/);
  });
});

describe('limits and batching', () => {
  it('honours limit', async () => {
    const s = store();
    await s.write({
      tuples: Array.from({ length: 5 }, (_, i) =>
        T(`user:u${i}`, 'viewer', 'document:1'),
      ),
    });
    expect((await s.read({ limit: 2 })).items).toHaveLength(2);
  });

  it('splits writes larger than batchSize', async () => {
    const s = kyselyStore(handle.db, { batchSize: 2 });
    const tuples = Array.from({ length: 5 }, (_, i) =>
      T(`user:u${i}`, 'viewer', 'document:1'),
    );
    await s.write({ tuples });
    expect((await s.read()).items).toHaveLength(5);
  });

  it('treats an empty write as a no-op', async () => {
    const s = store();
    await s.write({ tuples: [] });
    expect((await s.read()).items).toHaveLength(0);
  });
});

describe('transaction participation', () => {
  it('enlists a write in a caller-owned transaction', async () => {
    const s = store();
    await handle.db.transaction().execute(async (trx) => {
      const scoped = kyselyStore(trx);
      await scoped.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
      // Visible inside the transaction...
      expect((await scoped.read()).items).toHaveLength(1);
      // ...and committed once it resolves.
    });
    expect((await s.read()).items).toHaveLength(1);
  });

  it('does not commit a write from a rolled-back transaction', async () => {
    const s = store();
    await expect(
      handle.db.transaction().execute(async (trx) => {
        await kyselyStore(trx).write({
          tuples: [T('user:alice', 'viewer', 'document:1')],
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await s.read()).items).toHaveLength(0);
  });
});

describe('schema', () => {
  it('generates DDL for every supported dialect', () => {
    for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
      const sql = createTupleTableSql(dialect);
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS tsbouncer_tuples');
      expect(sql).toContain('subject_type');
      expect(sql).toContain('context');
      expect(sql).toContain('UNIQUE');
    }
  });

  it('uses TEXT for postgres and VARCHAR elsewhere', () => {
    expect(createTupleTableSql('postgres')).toContain('subject_id TEXT');
    expect(createTupleTableSql('sqlite')).toContain('subject_id VARCHAR(512)');
    expect(createTupleTableSql('mysql')).toContain('subject_id VARCHAR(512)');
  });

  it('generates a drop statement for every dialect', () => {
    for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
      expect(dropTupleTableSql(dialect)).toContain(
        'DROP TABLE IF EXISTS tsbouncer_tuples',
      );
    }
  });

  it('recognises valid dialects only', () => {
    expect(isDialect('sqlite')).toBe(true);
    expect(isDialect('oracle')).toBe(false);
  });

  it('round-trips through drop and recreate', async () => {
    const s = store();
    await s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    recreateTable(handle);
    expect((await s.read()).items).toHaveLength(0);
  });
});
