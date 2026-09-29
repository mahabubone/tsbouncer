import type { Tuple } from 'tsbouncer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEY_FIELDS, MODEL_DDL, prismaStore, rowToTuple } from '../src/index.js';
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
  it('reports a clear error when the model name is wrong', () => {
    expect(() => prismaStore(handle.prisma, { model: 'NoSuchModel' })).toThrow(
      /has no model "NoSuchModel"/,
    );
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

describe('a write spanning several batches', () => {
  it('names the one-param-set rule when a re-binding collides', async () => {
    const s = store();
    const base = {
      ...T('user:alice', 'viewer', 'document:1'),
      condition: 'inRegion',
    };
    await s.write({ tuples: [{ ...base, context: { region: 'eu' } }] });
    await expect(
      s.write({ tuples: [{ ...base, context: { region: 'us' } }] }),
    ).rejects.toThrow(/one param-set/);
  });

  it('commits none of its batches when one fails', async () => {
    const s = prismaStore(handle.prisma, { batchSize: 1 });
    await s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });

    await expect(
      s.write({
        tuples: [
          T('user:d1', 'viewer', 'document:1'),
          T('user:d2', 'viewer', 'document:1'),
          T('user:alice', 'viewer', 'document:1'),
        ],
      }),
    ).rejects.toThrow(/unique/);

    expect((await s.read()).items.map((t) => t.subject).sort()).toEqual(['user:alice']);
  });

  it('commits no upsert when a later row fails', async () => {
    const s = prismaStore(handle.prisma, { batchSize: 1 });
    const bad = prismaStore(handle.prisma, {
      uniqueKeyName: 'not_a_real_unique_input',
    });
    await expect(
      bad.write({
        tuples: [
          T('user:x', 'viewer', 'document:1'),
          T('user:y', 'viewer', 'document:1'),
        ],
        mode: 'upsert',
      }),
    ).rejects.toThrow();
    expect((await s.read()).items).toHaveLength(0);
  });
});

describe('limits that cannot be honoured', () => {
  it('returns an empty page rather than an arbitrary slice', async () => {
    const s = store();
    await s.write({
      tuples: [
        T('user:a', 'viewer', 'document:1'),
        T('user:b', 'viewer', 'document:1'),
        T('user:c', 'viewer', 'document:1'),
      ],
    });

    expect((await s.read({ limit: 0 })).items).toHaveLength(0);
    expect((await s.read({ limit: -1 })).items).toHaveLength(0);
  });
});

describe('failure messages', () => {
  it('does not blame a constraint for an unrelated failure', async () => {
    const s = prismaStore(handle.prisma, { uniqueKeyName: 'not_a_real_unique_input' });
    await expect(
      s.write({ tuples: [T('user:a', 'viewer', 'document:1')], mode: 'upsert' }),
    ).rejects.toThrow(/upsert failed/);
  });

  it('wraps a driver error from read in a StoreError', async () => {
    const s = store();
    await handle.prisma.$executeRawUnsafe('DROP TABLE "TsbouncerTuple"');

    await expect(s.read()).rejects.toThrow(/read failed/);
  });
});

// The table contract stores `''` for an absent optional column, and only the
// contract's own DDL guarantees it. Against a schema that allowed NULL the row
// would decode as `user:alice#null` — a reference no subject filter matches and
// no delete-by-subject reaches, so the row would be permanent and invisible.
describe('row decoding', () => {
  it('reads a NULL optional column as absent rather than as a relation name', () => {
    const fields = {
      subjectType: 'user',
      subjectId: 'alice',
      subjectRelation: null as unknown as string,
      relation: 'viewer',
      resourceType: 'document',
      resourceId: '1',
      condition: null as unknown as string,
      context: null,
    };
    expect(rowToTuple(fields as never)).toEqual({
      subject: 'user:alice',
      relation: 'viewer',
      resource: 'document:1',
      condition: undefined,
      context: undefined,
    });
  });
});
