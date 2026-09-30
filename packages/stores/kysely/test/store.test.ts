import type { Tuple } from '@tsbouncer/tsbouncer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTupleTableSql,
  dropTupleTableSql,
  isDialect,
  kyselyStore,
  rowToTuple,
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

  it('uses TEXT for postgres and MySQL-safe widths for MySQL', () => {
    expect(createTupleTableSql('postgres')).toContain('subject_id TEXT');
    expect(createTupleTableSql('sqlite')).toContain('subject_id VARCHAR(512)');
    // See `columnDefinitions`: InnoDB refuses to create the unique index over
    // anything wider, so a MySQL install must get the narrow widths.
    expect(createTupleTableSql('mysql')).toContain('subject_id VARCHAR(191)');
    expect(createTupleTableSql('mysql')).toContain('subject_type VARCHAR(64)');
  });

  it('keeps the MySQL unique index inside InnoDB key limit', () => {
    const sql = createTupleTableSql('mysql');
    const keyColumns = [
      'subject_type',
      'subject_id',
      'subject_relation',
      'relation',
      'resource_type',
      'resource_id',
      'condition',
    ];

    const bytes = keyColumns.reduce((sum, column) => {
      const match = sql.match(new RegExp(`^\\s+${column} (\\w+)(?:\\((\\d+)\\))?`, 'm'));
      if (match === null) throw new Error(`no column definition for ${column}`);
      if (match[1] !== 'VARCHAR' || match[2] === undefined) {
        throw new Error(`${column} is not a bounded varchar; a MySQL key needs one`);
      }
      return sum + Number(match[2]);
    }, 0);

    // utf8mb4, the default and the worst case, is four bytes per character.
    expect(bytes * 4).toBeLessThanOrEqual(3072);
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

describe('a write spanning several batches', () => {
  it('commits none of its batches when one fails', async () => {
    const s = kyselyStore(handle.db, { batchSize: 1 });
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
});

describe('failure messages', () => {
  it('names a unique constraint only when there was one', async () => {
    const s = store();
    await s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });

    await expect(
      s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] }),
    ).rejects.toThrow(/unique constraint/);
  });

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

  it('does not blame a constraint for an unrelated failure', async () => {
    const s = kyselyStore(handle.db, { table: 'no_such_table' });

    await expect(
      s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] }),
    ).rejects.toThrow(/write failed/);
    await expect(
      s.write({ tuples: [T('user:alice', 'viewer', 'document:1')], mode: 'upsert' }),
    ).rejects.toThrow(/upsert failed/);
  });
});

describe('writing through a caller-owned transaction', () => {
  it('accepts an upsert without trying to open a nested transaction', async () => {
    const s = store();
    await handle.db.transaction().execute(async (trx) => {
      const scoped = kyselyStore(trx);
      await scoped.write({
        tuples: [{ ...T('user:a', 'viewer', 'document:1'), condition: 'inRegion' }],
        mode: 'upsert',
      });
      await scoped.write({
        tuples: [{ ...T('user:a', 'viewer', 'document:1'), condition: 'inRegion' }],
        mode: 'upsert',
      });
      expect((await scoped.read()).items).toHaveLength(1);
    });
    expect((await s.read()).items).toHaveLength(1);
  });

  it('accepts a multi-batch write', async () => {
    const s = store();
    await handle.db.transaction().execute(async (trx) => {
      const scoped = kyselyStore(trx, { batchSize: 1 });
      await scoped.write({
        tuples: [
          T('user:a', 'viewer', 'document:1'),
          T('user:b', 'viewer', 'document:1'),
          T('user:c', 'viewer', 'document:1'),
        ],
      });
      expect((await scoped.read()).items).toHaveLength(3);
    });
    expect((await s.read()).items).toHaveLength(3);
  });
});

describe('DDL for a custom table name', () => {
  it('creates and drops the table it was asked for', () => {
    const created = createTupleTableSql('postgres', 'my_tuples');
    expect(created).toContain('CREATE TABLE IF NOT EXISTS my_tuples');
    expect(created).toContain('CREATE INDEX IF NOT EXISTS my_tuples_subject');
    expect(created).not.toContain('tsbouncer_tuples');

    const dropped = dropTupleTableSql('postgres', 'my_tuples');
    expect(dropped).toContain('DROP TABLE IF EXISTS my_tuples');
    expect(dropped).not.toContain('tsbouncer_tuples');
  });

  it('creates a store that can actually use it', async () => {
    handle.raw.exec(createTupleTableSql('sqlite', 'my_tuples'));
    const s = kyselyStore(handle.db, { table: 'my_tuples' });
    await s.write({ tuples: [T('user:alice', 'viewer', 'document:1')] });
    expect((await s.read()).items).toHaveLength(1);
    handle.raw.exec(dropTupleTableSql('sqlite', 'my_tuples'));
  });
});

// The table contract stores `''` for an absent optional column, and only the
// contract's own DDL guarantees it. Against a schema that allowed NULL the row
// would decode as `user:alice#null` — a reference no subject filter matches and
// no delete-by-subject reaches, so the row would be permanent and invisible.
describe('row decoding', () => {
  it('reads a NULL optional column as absent rather than as a relation name', () => {
    const fields = {
      subject_type: 'user',
      subject_id: 'alice',
      subject_relation: null as unknown as string,
      relation: 'viewer',
      resource_type: 'document',
      resource_id: '1',
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
