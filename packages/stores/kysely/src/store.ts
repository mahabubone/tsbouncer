import type {
  DeleteInput,
  Page,
  ReadTupleQuery,
  Tuple,
  TupleStore,
  TupleStoreCapabilities,
  WriteInput,
} from '@tsbouncer/tsbouncer';
import { formatRef, parseRef, StoreError } from '@tsbouncer/tsbouncer';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
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

/**
 * The predicate an empty set compiles to.
 *
 * `eb.or([])` and `column IN ()` are not "matches nothing" — the second is a
 * syntax error on SQLite and Postgres, and the first depends on what the
 * dialect does with an empty disjunction. Neither is a result the caller can
 * reason about, so an empty set is written out explicitly.
 */
const NO_MATCH: Where = () => sql<boolean>`1 = 0`;

const eq =
  (column: string, value: unknown): Where =>
  (eb) =>
    eb(column, '=', value);
const inList = (column: string, values: readonly unknown[]): Where =>
  values.length === 0
    ? NO_MATCH
    : values.length === 1
      ? eq(column, values[0])
      : (eb) => eb(column, 'in', [...values]);

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
    const batches = [...chunked(input.tuples.map(tupleToRow), batchSize)];

    const apply = async (db: QueryBuilder, batch: readonly TupleRow[]): Promise<void> => {
      if (mode === 'insert') {
        await db.insertInto(table).values(batch).execute();
        return;
      }
      await replaceKeysIn(db, table, batch);
    };

    try {
      // A single INSERT is atomic on its own, and a transaction for it would
      // cost a round trip on every grant. Anything else — an upsert's
      // delete-then-insert, or a write split across batches — is two or more
      // statements, and issuing them with nothing between them means a failure
      // partway leaves the earlier batches committed and the later ones absent.
      const needsTransaction = batches.length > 1 || mode !== 'insert';
      if (!needsTransaction) {
        await apply(k, batches[0] as readonly TupleRow[]);
        return;
      }
      await within(k, async (db: QueryBuilder) => {
        for (const batch of batches) await apply(db, batch);
      });
    } catch (cause) {
      throw new StoreError(describeFailure(mode, cause), { cause });
    }
  }

  async function remove(input: DeleteInput): Promise<void> {
    if (input.kind === 'tuples') {
      const batches = [...chunked(input.tuples.map(tupleToRow), batchSize)];
      const apply = async (
        db: QueryBuilder,
        batch: readonly TupleRow[],
      ): Promise<void> => {
        await db
          .deleteFrom(table)
          .where(anyOf(batch.map(keyPredicate)))
          .execute();
      };
      if (batches.length === 1) {
        await apply(k, batches[0] as readonly TupleRow[]);
        return;
      }
      await within(k, async (db: QueryBuilder) => {
        for (const batch of batches) await apply(db, batch);
      });
      return;
    }

    if (input.kind === 'filter') {
      let builder = k.deleteFrom(table);
      for (const where of whereFor(input.query)) builder = builder.where(where);
      await builder.execute();
      return;
    }

    await within(k, async (trx: QueryBuilder) => {
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
 * Run `body` with a transaction, unless `db` already *is* one.
 *
 * Kysely refuses to nest — `transaction()` on a `Transaction` throws — and the
 * store is documented as taking either a Kysely instance or a handle the caller
 * owns. Opening one unconditionally would make `kyselyStore(trx).delete(...)`
 * fail; opening none would leave a multi-batch write non-atomic when the caller
 * did not wrap it either. `isTransaction` is how the two are told apart, so the
 * caller's transaction supplies the atomicity in the second case.
 */
async function within<T>(
  db: QueryBuilder,
  body: (db: QueryBuilder) => Promise<T>,
): Promise<T> {
  if (db?.isTransaction === true) return body(db);
  return db.transaction().execute(body);
}

/**
 * The delete-then-insert pair itself, against a connection it does not open.
 *
 * `ON CONFLICT` covers SQLite and Postgres, but MySQL spells the same idea
 * `ON DUPLICATE KEY UPDATE` and Kysely's `onConflict` does not emit it. Branching
 * on a detected dialect is guesswork when a pooler or proxy sits between the
 * driver and the server, so this takes the portable route — which is why it is
 * two statements, and why the caller must put them in one transaction.
 *
 * A batch can carry the same key twice. Handing both to one INSERT is a unique
 * violation, and Postgres refuses outright ("cannot affect row a second time"),
 * so the same `upsert` that succeeds on `memoryStore` would throw here. `upsert`
 * is last-wins, so the batch is collapsed to its last row per key first.
 *
 * Authorization writes are low-volume and this is correct everywhere. If write
 * throughput becomes the bottleneck, swap in the dialect-native path per driver.
 */
async function replaceKeysIn(
  db: QueryBuilder,
  table: string,
  rows: readonly TupleRow[],
): Promise<void> {
  const where = anyOf(rows.map(keyPredicate));
  await db.deleteFrom(table).where(where).execute();
  await db.insertInto(table).values(lastPerKey(rows)).execute();
}

function lastPerKey(rows: readonly TupleRow[]): TupleRow[] {
  const byKey = new Map<string, TupleRow>();
  for (const row of rows) {
    byKey.set(JSON.stringify(KEY_COLUMNS.map((column) => row[column])), row);
  }
  return [...byKey.values()];
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
  // `subject_relation` and `condition` are `''` when absent *by contract*. A row
  // written by a schema that allowed NULL would otherwise be rendered
  // `user:alice#null`, a reference that matches no filter and cannot be deleted
  // by one — so `null` is read as absent rather than as a relation name.
  const subject = formatRef({
    type: row.subject_type,
    id: row.subject_id,
    relation:
      row.subject_relation == null || row.subject_relation === NULL_ABSENT
        ? undefined
        : row.subject_relation,
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
    condition:
      row.condition == null || row.condition === NULL_ABSENT ? undefined : row.condition,
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
  if (branches.length === 0) return NO_MATCH;
  return (eb) => eb.or(branches.map((branch) => branch(eb)));
}

/** Every call site passes a fixed non-empty list, so an empty one is a bug. */
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

/**
 * The message for a failed write.
 *
 * It used to claim a unique constraint on every insert failure, so a connection
 * that dropped mid-batch was reported to the caller as "a tuple with this key
 * already exists" — a diagnosis that sends them to look for a duplicate that is
 * not there. The claim is now made only when the driver actually reported one;
 * the original error stays on `cause` either way.
 */
function describeFailure(mode: string, cause: unknown): string {
  if (isUniqueViolation(cause)) {
    return (
      'write rejected by a unique constraint — a tuple with this key already exists. ' +
      "One edge holds one param-set per condition: re-binding the same edge and condition needs mode 'upsert'."
    );
  }
  return mode === 'insert' ? 'write failed' : 'upsert failed';
}

/** SQLite `UNIQUE constraint failed`, Postgres `23505`, MySQL `ER_DUP_ENTRY`. */
function isUniqueViolation(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth++) {
    const error = current as { code?: unknown; errno?: unknown; message?: unknown };
    const haystack =
      `${error.code ?? ''} ${error.errno ?? ''} ${error.message ?? ''}`.toLowerCase();
    if (/p2002|unique constraint|dup_entry|duplicate (key|entry)|23505/.test(haystack))
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
