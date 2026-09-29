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
import { and, eq, or, sql } from 'drizzle-orm';
import { type AnyTsbouncerTable, NULL_ABSENT, type TupleRow } from './schema.js';

export type { AnyTsbouncerTable, TupleRow } from './schema.js';
export {
  mysqlTsbouncerTuples,
  pgTsbouncerTuples,
  sqliteTsbouncerTuples,
  TABLE,
} from './schema.js';

/**
 * Drizzle's types are generic over the caller's entire schema object, and a
 * store that must accept a table from any of three dialects has no single
 * accurate type to target. The aliases below stay private to this module, and
 * every value crossing the database boundary remains typed as `TupleRow`.
 */
// biome-ignore lint/suspicious/noExplicitAny: see the note above
type DrizzleDb = any;
// biome-ignore lint/suspicious/noExplicitAny: see the note above
type DrizzleTable = any;

type SelectQuery = { all(): unknown; execute(): Promise<unknown> };
type MutationQuery = { run(): unknown; execute(): Promise<unknown> };
type ConflictBuilder = {
  onConflictDoUpdate(config: {
    target: readonly unknown[];
    set: Record<string, unknown>;
  }): SelectQuery | MutationQuery | Promise<unknown>;
};
type DuplicateBuilder = {
  onDuplicateKeyUpdate(config: {
    set: Record<string, unknown>;
  }): SelectQuery | MutationQuery | Promise<unknown>;
};
type Condition = ReturnType<typeof eq> | ReturnType<typeof and> | ReturnType<typeof or>;

/**
 * A unit of work inside a transaction.
 *
 * Drizzle's transaction helper is deliberately strict in both directions: a
 * **sync** driver (better-sqlite3, bun:sqlite) throws
 * `"Transaction function cannot return a promise"` if the callback is async, and
 * an **async** driver commits before an async callback finishes. So a single
 * transaction body cannot serve both — but a *list of steps* can, because the
 * runner executes each step synchronously or awaits it, per driver.
 */
type Step =
  | { readonly kind: 'deleteWhere'; readonly condition: Condition }
  | { readonly kind: 'insert'; readonly rows: readonly TupleRow[] };

export interface DrizzleStoreOptions {
  readonly batchSize?: number;
  /**
   * Override driver detection. Only needed for an unrecognised client; see
   * `resolveDriverKind` for why this is not guessed.
   */
  readonly driverKind?: DriverKind;
}

export type DriverKind = 'sync' | 'async';

const DEFAULT_BATCH = 500;

/**
 * Whether the underlying driver is synchronous.
 *
 * This decides how a transaction body is written, and getting it wrong is
 * silent and corrupting:
 *
 *  - on a **sync** driver, drizzle throws if the transaction callback returns a
 *    promise, and a body that awaits never reaches the COMMIT;
 *  - on an **async** driver, a body that does not await lets drizzle commit
 *    *before* the work finishes — a `replace` could delete and never insert.
 *
 * Drizzle exposes no documented flag for this, and the obvious probe is a trap:
 * `select().limit(1)` exposes `run()`, `all()` **and** `execute()` on both a
 * sync and an async builder, so checking the builder classifies every async
 * driver as sync. The underlying client is the stable thing to inspect instead —
 * `prepare()` exists on the synchronous SQLite clients (better-sqlite3,
 * bun:sqlite) and not on libsql, pg, or mysql2.
 *
 * If neither shape matches — or the client cannot be reached at all — the store
 * refuses to start rather than guessing. A wrong guess here loses data
 * silently, which is far worse than an error the caller can fix with one option.
 */
function resolveDriverKind(db: DrizzleDb, override: DriverKind | undefined): DriverKind {
  if (override !== undefined) return override;

  // A transaction handle has no `$client` of its own, so fall back to the
  // session, which is the same client scoped to the transaction. This is what
  // makes `drizzleStore(tx, table)` work.
  const client =
    (db?.$client as { prepare?: unknown; execute?: unknown } | undefined) ??
    (db?.session?.client as { prepare?: unknown; execute?: unknown } | undefined);

  if (client === undefined || client === null) {
    throw new TypeError(
      'drizzleStore: could not reach the database client. Pass `driverKind: "sync" | "async"` to declare it.',
    );
  }
  if (typeof client.prepare === 'function') return 'sync';
  if (typeof client.execute === 'function') return 'async';
  throw new TypeError(
    'drizzleStore: unrecognised database client. Pass `driverKind: "sync" | "async"` to declare it.',
  );
}

const CAPABILITIES: TupleStoreCapabilities = Object.freeze({
  atomicWrite: true,
  persistent: true,
  atomicReplace: true,
  pagination: false,
  transaction: true,
  watch: false,
});

/**
 * A `TupleStore` over an application-owned Drizzle instance.
 *
 * Pass the same `db` your app already uses, plus the exact table object you
 * declared in your schema — Drizzle builds SQL from a table's column metadata,
 * so the store and the schema must share one instance.
 *
 * To enlist a write in an existing transaction, pass that transaction handle as
 * `db`. The store has no opinion about transaction scope.
 */
export function drizzleStore(
  db: DrizzleDb,
  table: AnyTsbouncerTable,
  options: DrizzleStoreOptions = {},
): TupleStore {
  const t = table as DrizzleTable;
  const batchSize = options.batchSize ?? DEFAULT_BATCH;

  const sync = resolveDriverKind(db, options.driverKind) === 'sync';

  // A sync builder's `all()` is select-only and throws on INSERT/DELETE;
  // mutations must go through `run()`. Async drivers expose `execute()` for both.
  const select = (query: SelectQuery): Promise<unknown> =>
    sync ? Promise.resolve(query.all()) : query.execute();
  const mutate = (query: MutationQuery): Promise<unknown> =>
    sync ? Promise.resolve(query.run()) : query.execute();

  async function read(query: ReadTupleQuery = {}): Promise<Page<Tuple>> {
    let builder = db.select().from(t);
    const conditions = whereFor(t, query);
    if (conditions.length > 0) builder = builder.where(and(...conditions));
    if (query.limit !== undefined) builder = builder.limit(query.limit);

    const rows = (await select(builder as SelectQuery)) as TupleRow[];
    return Object.freeze({ items: Object.freeze(rows.map(rowToTuple)) });
  }

  async function write(input: WriteInput): Promise<void> {
    if (input.tuples.length === 0) return;
    const mode = input.mode ?? 'insert';
    const rows = input.tuples.map(tupleToRow);

    for (const batch of chunked(rows, batchSize)) {
      try {
        if (mode === 'insert') {
          await mutate(db.insert(t).values(batch) as MutationQuery);
        } else {
          await upsert(db, t, batch);
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
        await mutate(
          db
            .delete(t)
            .where(or(...batch.map((row) => keyCondition(t, row)))) as MutationQuery,
        );
      }
      return;
    }

    const steps: Step[] = [
      { kind: 'deleteWhere', condition: filterCondition(t, input.query) },
      ...Array.from(
        chunked(input.kind === 'replace' ? input.tuples.map(tupleToRow) : [], batchSize),
        (rows): Step => ({ kind: 'insert', rows }),
      ),
    ];
    await atomic(db, t, steps, sync);
  }

  return Object.freeze({ capabilities: CAPABILITIES, read, write, delete: remove });
}

/**
 * Upsert via the dialect's own conflict clause, chosen by asking the builder
 * which one it has. SQLite and Postgres builders carry `onConflictDoUpdate`,
 * MySQL builders carry `onDuplicateKeyUpdate`, and neither is a superset of the
 * other — so this is a capability check, not a dialect guess. Both builders are
 * awaitable, which is why upsert needs no transaction on either driver kind.
 */
async function upsert(
  db: DrizzleDb,
  table: DrizzleTable,
  rows: readonly TupleRow[],
): Promise<void> {
  const builder = db.insert(table).values(rows);
  const set = { context: rows[0]?.context ?? null };

  if (typeof (builder as Partial<ConflictBuilder>).onConflictDoUpdate === 'function') {
    await (builder as ConflictBuilder).onConflictDoUpdate({
      target: [
        table.subjectType,
        table.subjectId,
        table.subjectRelation,
        table.relation,
        table.resourceType,
        table.resourceId,
        table.condition,
      ],
      set,
    });
    return;
  }
  await (builder as DuplicateBuilder).onDuplicateKeyUpdate({ set });
}

async function atomic(
  db: DrizzleDb,
  table: DrizzleTable,
  steps: readonly Step[],
  sync: boolean,
): Promise<void> {
  if (sync) {
    // Each step runs to completion before the next; nothing is awaited, so the
    // sync driver's COMMIT sees the finished work.
    db.transaction((tx: DrizzleDb) => {
      for (const step of steps) runStepSync(tx, table, step);
    });
    return;
  }
  await db.transaction(async (tx: DrizzleDb) => {
    for (const step of steps) await runStepAsync(tx, table, step);
  });
}

function runStepSync(tx: DrizzleDb, table: DrizzleTable, step: Step): void {
  if (step.kind === 'deleteWhere') {
    tx.delete(table).where(step.condition).run();
    return;
  }
  tx.insert(table).values(step.rows).run();
}

async function runStepAsync(
  tx: DrizzleDb,
  table: DrizzleTable,
  step: Step,
): Promise<void> {
  if (step.kind === 'deleteWhere') {
    await tx.delete(table).where(step.condition);
    return;
  }
  await tx.insert(table).values(step.rows);
}

// ---------------------------------------------------------------------------
// Row <-> Tuple
// ---------------------------------------------------------------------------

export function tupleToRow(tuple: Tuple): TupleRow {
  const subject = parseRef(tuple.subject, 'subject');
  const resource = parseRef(tuple.resource, 'object');

  return {
    subjectType: subject.type,
    subjectId: subject.id,
    subjectRelation: subject.relation ?? NULL_ABSENT,
    relation: tuple.relation,
    resourceType: resource.type,
    resourceId: resource.id,
    condition: tuple.condition ?? NULL_ABSENT,
    context: tuple.context === undefined ? null : JSON.stringify(tuple.context),
  };
}

export function rowToTuple(row: TupleRow): Tuple {
  const subject = formatRef({
    type: row.subjectType,
    id: row.subjectId,
    relation: row.subjectRelation === NULL_ABSENT ? undefined : row.subjectRelation,
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
    resource: formatRef({ type: row.resourceType, id: row.resourceId }),
    condition: row.condition === NULL_ABSENT ? undefined : row.condition,
    context,
  });
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/**
 * A reference spans three columns, so a set of references is an OR of
 * per-reference ANDs. Independent equality tests per column would match a row
 * pairing one reference's type with another's id.
 */
function refCondition(
  table: DrizzleTable,
  filter: string | readonly string[],
  prefix: 'subject' | 'resource',
): Condition {
  const values = typeof filter === 'string' ? [filter] : filter;
  const position = prefix === 'subject' ? 'subject' : 'object';

  return or(
    ...values.map((value) => {
      const ref = parseRef(value, position);
      const terms: Condition[] = [
        eq(table[`${prefix}Type`], ref.type),
        eq(table[`${prefix}Id`], ref.id),
      ];
      if (prefix === 'subject') {
        terms.push(eq(table.subjectRelation, ref.relation ?? NULL_ABSENT));
      }
      return and(...terms);
    }),
  );
}

function whereFor(table: DrizzleTable, query: ReadTupleQuery): Condition[] {
  const terms: Condition[] = [];
  if (query.subject !== undefined)
    terms.push(refCondition(table, query.subject, 'subject'));
  if (query.relation !== undefined) {
    const values = typeof query.relation === 'string' ? [query.relation] : query.relation;
    terms.push(or(...values.map((v) => eq(table.relation, v))));
  }
  if (query.resource !== undefined) {
    terms.push(refCondition(table, query.resource, 'resource'));
  }
  return terms;
}

/**
 * `delete({ kind: 'filter' })` with no filters means "delete everything", and
 * Drizzle's `delete()` needs *some* predicate.
 *
 * An earlier version used `relation = ''` here, reasoning that a relation name
 * can never be empty. That is backwards: it matched only rows whose relation was
 * the empty string, so an unfiltered delete silently removed **zero** rows and
 * still reported success. `1 = 1` is the portable always-true predicate.
 */
function filterCondition(table: DrizzleTable, query: ReadTupleQuery): Condition {
  const terms = whereFor(table, query);
  if (terms.length === 0) return sql`1 = 1`;
  return and(...terms);
}

function keyCondition(table: DrizzleTable, row: TupleRow): Condition {
  return and(
    eq(table.subjectType, row.subjectType),
    eq(table.subjectId, row.subjectId),
    eq(table.subjectRelation, row.subjectRelation),
    eq(table.relation, row.relation),
    eq(table.resourceType, row.resourceType),
    eq(table.resourceId, row.resourceId),
    eq(table.condition, row.condition),
  );
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
