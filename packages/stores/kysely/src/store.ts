import type {
  DeleteInput,
  Page,
  ReadTupleQuery,
  Tuple,
  TupleStore,
  TupleStoreCapabilities,
  WriteInput,
} from '@tsbouncer/core';
import { formatRef, parseRef, StoreError } from '@tsbouncer/core';
import type { Kysely } from 'kysely';
import { COLUMNS, KEY_COLUMNS, NULL_ABSENT, TABLE, type TupleRow } from './schema.js';

export type { Dialect } from './schema.js';
export { createTupleTableSql, dropTupleTableSql, TABLE } from './schema.js';

/**
 * Internal escape hatch for Kysely's query-builder types, which are generic
 * over the caller's dialect schema. A store spanning SQLite, Postgres, and
 * MySQL has no single accurate type to target.
 *
 * The public signature is still `Kysely<DB>`, so only a real Kysely instance can
 * be passed. This alias never leaves the module, and every value crossing the
 * database boundary stays typed as `TupleRow`.
 */
// biome-ignore lint/suspicious/noExplicitAny: see the note above
type QueryBuilder = any;

export interface KyselyStoreOptions {
  /** Defaults to `tsbouncer_tuples`. */
  readonly table?: string;
  /** Caps rows per INSERT so a large `replace` cannot exceed a driver limit. */
  readonly batchSize?: number;
}

const DEFAULT_BATCH = 500;

const CAPABILITIES: TupleStoreCapabilities = Object.freeze({
  atomicWrite: true,
  persistent: true,
  atomicReplace: true,
  pagination: false,
  transaction: true,
  watch: false,
});

type Where = (eb: QueryBuilder) => unknown;

const eq =
  (column: string, value: unknown): Where =>
  (eb) =>
    eb(column, '=', value);
const inList = (column: string, values: readonly unknown[]): Where =>
  values.length === 1 ? eq(column, values[0]) : (eb) => eb(column, 'in', [...values]);

/**
 * A `TupleStore` over an application-owned Kysely instance.
 *
 * Pass the same Kysely instance your app already uses. To enlist a write in an
 * existing transaction, pass that transaction handle instead — the store has no
 * opinion about transaction scope, which is the entire point.
 */
export function kyselyStore<DB>(
  db: Kysely<DB>,
  options: KyselyStoreOptions = {},
): TupleStore {
  const table = options.table ?? TABLE;
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const k = db as unknown as QueryBuilder;

  async function read(query: ReadTupleQuery = {}): Promise<Page<Tuple>> {
    let builder = k.selectFrom(table).select([...COLUMNS]);
    for (const where of whereFor(query)) {
      builder = builder.where(where);
    }
    if (query.limit !== undefined) builder = builder.limit(query.limit);

    const rows = (await builder.execute()) as TupleRow[];
    return Object.freeze({ items: Object.freeze(rows.map(rowToTuple)) });
  }

  async function write(input: WriteInput): Promise<void> {
    if (input.tuples.length === 0) return;
    const mode = input.mode ?? 'insert';
    const rows = input.tuples.map(tupleToRow);

    for (const batch of chunked(rows, batchSize)) {
      try {
        if (mode === 'insert') {
          await k.insertInto(table).values(batch).execute();
        } else {
          await replaceKeys(k, table, batch);
        }
      } catch (cause) {
        throw new StoreError(describeFailure(mode), { cause });
      }
    }
  }

  async function remove(input: DeleteInput): Promise<void> {
    if (input.kind === 'tuples') {
      const rows = input.tuples.map(tupleToRow);
      for (const batch of chunked(rows, batchSize)) {
        const where = anyOf(batch.map(keyPredicate));
        await k.deleteFrom(table).where(where).execute();
      }
      return;
    }

    if (input.kind === 'filter') {
      let builder = k.deleteFrom(table);
      for (const where of whereFor(input.query)) builder = builder.where(where);
      await builder.execute();
      return;
    }

    await k.transaction().execute(async (trx: QueryBuilder) => {
      let builder = trx.deleteFrom(table);
      for (const where of whereFor(input.query)) builder = builder.where(where);
      await builder.execute();

      const rows = input.tuples.map(tupleToRow);
      for (const batch of chunked(rows, batchSize)) {
        await trx.insertInto(table).values(batch).execute();
      }
    });
  }

  return Object.freeze({ capabilities: CAPABILITIES, read, write, delete: remove });
}

/**
 * Delete-then-insert, in a transaction.
 *
 * `ON CONFLICT` covers SQLite and Postgres, but MySQL spells the same idea
 * `ON DUPLICATE KEY UPDATE` and Kysely's `onConflict` does not emit it. Branching
 * on a detected dialect is guesswork when a pooler or proxy sits between the
 * driver and the server, so this takes the portable route.
 *
 * Authorization writes are low-volume and this is correct everywhere. If write
 * throughput becomes the bottleneck, swap in the dialect-native path per driver.
 */
async function replaceKeys(
  k: QueryBuilder,
  table: string,
  rows: readonly TupleRow[],
): Promise<void> {
  await k.transaction().execute(async (trx: QueryBuilder) => {
    const where = anyOf(rows.map(keyPredicate));
    await trx.deleteFrom(table).where(where).execute();
    await trx.insertInto(table).values(rows).execute();
  });
}

// ---------------------------------------------------------------------------
// Row <-> Tuple
// ---------------------------------------------------------------------------

export function tupleToRow(tuple: Tuple): TupleRow {
  const subject = parseRef(tuple.subject, 'subject');
  const resource = parseRef(tuple.resource, 'object');

  return {
    subject_type: subject.type,
    subject_id: subject.id,
    subject_relation: subject.relation ?? NULL_ABSENT,
    relation: tuple.relation,
    resource_type: resource.type,
    resource_id: resource.id,
    condition: tuple.condition ?? NULL_ABSENT,
    context: tuple.context === undefined ? null : JSON.stringify(tuple.context),
  };
}

export function rowToTuple(row: TupleRow): Tuple {
  const subject = formatRef({
    type: row.subject_type,
    id: row.subject_id,
    relation: row.subject_relation === NULL_ABSENT ? undefined : row.subject_relation,
  });

  let context: Record<string, unknown> | undefined;
  if (row.context !== null && row.context !== NULL_ABSENT) {
    try {
      context = JSON.parse(row.context) as Record<string, unknown>;
    } catch (cause) {
      throw new StoreError(`tuple ${subject} has unparseable context JSON`, { cause });
    }
  }

  return Object.freeze({
    subject,
    relation: row.relation,
    resource: formatRef({ type: row.resource_type, id: row.resource_id }),
    condition: row.condition === NULL_ABSENT ? undefined : row.condition,
    context,
  });
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/**
 * Each store filter is a set of *exact* values on one logical field, but a
 * reference spans three columns. So a reference set is an OR of per-reference
 * ANDs — never independent IN clauses per column, which would happily match a
 * row pairing one subject's type with another subject's id.
 */
function anyOf(branches: readonly Where[]): Where {
  return (eb) => eb.or(branches.map((branch) => branch(eb)));
}

function allOf(terms: readonly Where[]): Where {
  return (eb) => eb.and(terms.map((term) => term(eb)));
}

function refWhere(
  filter: string | readonly string[],
  prefix: 'subject' | 'resource',
): Where {
  const values = typeof filter === 'string' ? [filter] : filter;
  const position = prefix === 'subject' ? 'subject' : 'object';
  const refs = values.map((v) => parseRef(v, position));

  return anyOf(
    refs.map((ref) =>
      allOf(
        prefix === 'subject'
          ? [
              eq(`${prefix}_type`, ref.type),
              eq(`${prefix}_id`, ref.id),
              eq('subject_relation', ref.relation ?? NULL_ABSENT),
            ]
          : [eq(`${prefix}_type`, ref.type), eq(`${prefix}_id`, ref.id)],
      ),
    ),
  );
}

function namesWhere(filter: string | readonly string[]): Where {
  return inList('relation', typeof filter === 'string' ? [filter] : filter);
}

function whereFor(query: ReadTupleQuery): Where[] {
  const terms: Where[] = [];
  if (query.subject !== undefined) terms.push(refWhere(query.subject, 'subject'));
  if (query.relation !== undefined) terms.push(namesWhere(query.relation));
  if (query.resource !== undefined) terms.push(refWhere(query.resource, 'resource'));
  return terms;
}

function keyPredicate(row: TupleRow): Where {
  return allOf(KEY_COLUMNS.map((column) => eq(column, row[column])));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

function describeFailure(mode: string): string {
  return mode === 'insert'
    ? 'write rejected by a unique constraint — a tuple with this key already exists'
    : 'upsert failed';
}
