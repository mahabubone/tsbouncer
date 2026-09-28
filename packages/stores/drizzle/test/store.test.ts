import type { Tuple } from '@tsbouncer/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  drizzleStore,
  mysqlTsbouncerTuples,
  pgTsbouncerTuples,
  sqliteTsbouncerTuples,
} from '../src/index.js';
import { createDb, type Handle } from './db.js';

const T = (subject: string, relation: string, resource: string): Tuple => ({
  subject,
  relation,
  resource,
});

let handle: Handle;

beforeEach(() => {
  handle = createDb();
});

afterEach(() => {
  handle.destroy();
});

const store = () => drizzleStore(handle.db, handle.tuples);

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

  it('distinguishes a userset from a direct subject with the same name', async () => {
    const s = store();
    await s.write({
      tuples: [
        T('team:eng', 'viewer', 'document:1'),
        T('team:eng#member', 'viewer', 'document:1'),
      ],
    });
    expect((await s.read({ subject: 'team:eng' })).items).toHaveLength(1);
    expect((await s.read({ subject: 'team:eng#member' })).items).toHaveLength(1);
  });
});

describe('sync driver support', () => {
  it('runs an atomic replace on a synchronous driver', async () => {
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

  it('deletes everything for an unfiltered delete', async () => {
    const s = store();
    await s.write({
      tuples: [
        T('user:alice', 'viewer', 'document:1'),
        T('user:bob', 'viewer', 'document:2'),
      ],
    });
    await s.delete({ kind: 'filter', query: {} });
    expect((await s.read()).items).toHaveLength(0);
  });

  it('replaces everything for an unfiltered replace', async () => {
    const s = store();
    await s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    await s.delete({
      kind: 'replace',
      query: {},
      tuples: [T('user:carol', 'viewer', 'document:9')],
    });
    expect((await s.read()).items.map((t) => t.subject)).toEqual(['user:carol']);
  });
});

describe('transactions', () => {
  it('enlists a write in a caller-owned transaction', async () => {
    const s = store();
    // better-sqlite3 is a *synchronous* driver, and drizzle rejects a
    // promise-returning transaction callback outright. So the promise must not
    // be returned — but the write itself is issued synchronously, because
    // `.run()` fires before `write`'s first `await`. On an async driver you can
    // simply `await` inside the callback instead.
    let issued: Promise<unknown> | undefined;
    handle.db.transaction((tx) => {
      issued = drizzleStore(tx, handle.tuples).write({
        tuples: [T('user:alice', 'viewer', 'document:1')],
      });
    });
    await issued;
    expect((await s.read()).items).toHaveLength(1);
  });

  it('rolls back with the surrounding transaction', async () => {
    const s = store();
    expect(() =>
      handle.db.transaction((tx) => {
        void drizzleStore(tx, handle.tuples).write({
          tuples: [T('user:alice', 'viewer', 'document:1')],
        });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect((await s.read()).items).toHaveLength(0);
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

  it('replaces context through the dialect conflict clause', async () => {
    const s = store();
    const base = { ...T('user:a', 'viewer', 'document:1'), condition: 'inRegion' };
    await s.write({ tuples: [{ ...base, context: { region: 'eu' } }] });
    await s.write({ tuples: [{ ...base, context: { region: 'us' } }], mode: 'upsert' });
    const found = await s.read();
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.context).toEqual({ region: 'us' });
  });
});

describe('batching', () => {
  it('splits writes larger than batchSize', async () => {
    const s = drizzleStore(handle.db, handle.tuples, { batchSize: 2 });
    await s.write({
      tuples: Array.from({ length: 5 }, (_, i) =>
        T(`user:u${i}`, 'viewer', 'document:1'),
      ),
    });
    expect((await s.read()).items).toHaveLength(5);
  });
});

describe('table factories', () => {
  it('produces an independent object per call', () => {
    const a = sqliteTsbouncerTuples();
    const b = sqliteTsbouncerTuples();
    expect(a).not.toBe(b);
    expect(a.subjectType.name).toBe('subject_type');
  });

  it.each([
    ['sqlite', () => sqliteTsbouncerTuples()],
    ['pg', () => pgTsbouncerTuples()],
    ['mysql', () => mysqlTsbouncerTuples()],
  ] as const)('declares the same column names for %s', (_name, make) => {
    const table = make() as unknown as Record<string, { name?: string } | undefined>;
    for (const [field, column] of Object.entries({
      subjectType: 'subject_type',
      subjectId: 'subject_id',
      subjectRelation: 'subject_relation',
      relation: 'relation',
      resourceType: 'resource_type',
      resourceId: 'resource_id',
      condition: 'condition',
      context: 'context',
    })) {
      expect(table[field]?.name, field).toBe(column);
    }
  });

  it('makes every key column NOT NULL so the unique constraint fires', () => {
    for (const make of [
      () => sqliteTsbouncerTuples(),
      () => pgTsbouncerTuples(),
      () => mysqlTsbouncerTuples(),
    ]) {
      const table = make() as unknown as Record<string, { notNull: boolean }>;
      for (const field of [
        'subjectType',
        'subjectId',
        'subjectRelation',
        'relation',
        'resourceType',
        'resourceId',
        'condition',
      ] as const) {
        expect(table[field]?.notNull, `${field} must be NOT NULL`).toBe(true);
      }
      expect(table.context?.notNull).toBe(false);
    }
  });
});

describe('driver detection', () => {
  it('accepts an explicit driverKind when the client is unreachable', async () => {
    // A client with no `$client` and no `session` cannot be probed, so the store
    // must refuse rather than guess — guessing wrong loses data silently.
    const opaque = {
      select: () => ({
        from: () => ({ limit: () => ({ all: () => [], execute: async () => [] }) }),
      }),
    };
    expect(() => drizzleStore(opaque, handle.tuples)).toThrow(
      /could not reach the database client/,
    );
  });

  it('accepts an explicit driverKind as an override', async () => {
    const s = drizzleStore(handle.db, handle.tuples, { driverKind: 'sync' });
    await s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    expect((await s.read()).items).toHaveLength(1);
  });

  it('rejects a client it cannot classify', () => {
    const opaque = { $client: { somethingElse: true } };
    expect(() => drizzleStore(opaque, handle.tuples)).toThrow(
      /unrecognised database client/,
    );
  });
});

describe('error surfaces', () => {
  it('surfaces unparseable stored context instead of returning a broken tuple', async () => {
    const s = store();
    await s.write({ tuples: [T('user:a', 'viewer', 'document:1')] });
    handle.raw
      .prepare('UPDATE tsbouncer_tuples SET context = ? WHERE subject_id = ?')
      .run('{not json', 'a');
    await expect(s.read()).rejects.toThrow(/unparseable context/);
  });

  it('reports an upsert failure distinctly from a duplicate insert', async () => {
    const s = store();
    await expect(
      s.write({ tuples: [T('user:a', 'viewer', 'document:1')], mode: 'upsert' }),
    ).resolves.toBeUndefined();
  });
});
