import type { Tuple } from '@tsbouncer/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEY_FIELDS, MODEL_DDL, prismaStore } from '../src/index.js';
import { createDb, ensureTable, type Handle, truncate } from './db.js';

const T = (subject: string, relation: string, resource: string): Tuple => ({
  subject,
  relation,
  resource,
});

let handle: Handle;

beforeEach(async () => {
  handle = createDb();
  await ensureTable(handle);
});

afterEach(async () => {
  await handle.destroy();
});

const store = () => prismaStore(handle.prisma);

describe('multi-value filters', () => {
  it('matches either reference, not the cross product', async () => {
    const s = store();
    await s.write({
      tuples: [
        T('user:alice', 'viewer', 'document:1'),
        T('user:bob', 'viewer', 'document:1'),
        T('user:carol', 'viewer', 'document:1'),
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
    expect((await s.read()).items).toHaveLength(2);
  });
});

describe('transactions', () => {
  it('enlists a write in a caller-owned transaction', async () => {
    const s = store();
    await handle.prisma.$transaction(async (tx) => {
      await prismaStore(tx).write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    });
    expect((await s.read()).items).toHaveLength(1);
  });

  it('does not commit a write from a rolled-back transaction', async () => {
    const s = store();
    await expect(
      handle.prisma.$transaction(async (tx) => {
        await prismaStore(tx).write({
          tuples: [T('user:alice', 'viewer', 'document:1')],
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow();
    expect((await s.read()).items).toHaveLength(0);
  });
});

describe('batching', () => {
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
    const s = prismaStore(handle.prisma, { batchSize: 2 });
    await s.write({
      tuples: Array.from({ length: 5 }, (_, i) =>
        T(`user:u${i}`, 'viewer', 'document:1'),
      ),
    });
    expect((await s.read()).items).toHaveLength(5);
  });
});

describe('schema constants', () => {
  it('derives the default compound unique name as a snake_case join', () => {
    expect(KEY_FIELDS.join('_')).toBe(
      'subjectType_subjectId_subjectRelation_relation_resourceType_resourceId_condition',
    );
  });

  it('ships a model definition matching the key fields', () => {
    for (const field of KEY_FIELDS) expect(MODEL_DDL).toContain(field);
    expect(MODEL_DDL).toContain('@@unique');
    expect(MODEL_DDL).toContain('@@index');
  });

  it('threads uniqueKeyName through to Prisma', async () => {
    // A name Prisma does not know about must be rejected, which proves the
    // option reaches the client rather than being ignored. The default
    // snake_case join is exercised by the conformance suite.
    const s = prismaStore(handle.prisma, { uniqueKeyName: 'not_a_real_unique_input' });
    await expect(
      s.write({ tuples: [T('user:alice', 'viewer', 'document:1')], mode: 'upsert' }),
    ).rejects.toThrow(/upsert failed/);
  });
});

describe('model naming', () => {
  it('reports a clear error when the model name is wrong', async () => {
    const s = prismaStore(handle.prisma, { model: 'NoSuchModel' });
    await expect(s.read()).rejects.toThrow();
  });
});

describe('replace is atomic', () => {
  it('swaps the set and keeps the rest', async () => {
    const s = store();
    await s.write({
      tuples: [
        T('user:alice', 'viewer', 'document:1'),
        T('user:bob', 'viewer', 'document:2'),
      ],
    });
    await truncate(handle);
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
});
