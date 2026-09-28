import type {
  DeleteInput,
  KeymanStore,
  KeymanStoreCapabilities,
  Page,
  ReadTupleQuery,
  Tuple,
  WriteInput,
} from '@tsbouncer/core';
import { formatRef, parseRef, StoreError } from '@tsbouncer/core';
import { DEFAULT_MODEL, KEY_FIELDS, NULL_ABSENT } from './schema.js';

export { DEFAULT_MODEL, KEY_FIELDS, MODEL_DDL, NULL_ABSENT } from './schema.js';

/**
 * Prisma's generated client is typed per-model, and the caller picks the model
 * name, so there is no single accurate type to target for a dynamic delegate.
 * These aliases stay private to this module; every value crossing the database
 * boundary remains typed as `TupleRow`.
 */
// biome-ignore lint/suspicious/noExplicitAny: see the note above
type PrismaClient = any;

/** Where-clause fragment. Prisma composes these with `AND` by default. */
type Filter = Record<string, unknown>;

export interface PrismaStoreOptions {
  /** Your Prisma model name. Defaults to `TsbouncerTuple`. */
  readonly model?: string;
  /**
   * The name of the compound unique input used in `where`.
   *
   * Prisma exposes an unnamed `@@unique([...])` under a snake_case join of the
   * field names (`subjectType_subjectId_…_condition`) — note this differs from
   * the CamelCase name of the underlying index in the database. Override it if
   * you gave the constraint an explicit `map:` name in your schema.
   */
  readonly uniqueKeyName?: string;
  /** Caps rows per `createMany` so a large batch cannot exceed a driver limit. */
  readonly batchSize?: number;
}

const DEFAULT_BATCH = 500;

const CAPABILITIES: KeymanStoreCapabilities = Object.freeze({
  atomicWrite: true,
  persistent: true,
  atomicReplace: true,
  pagination: false,
  transaction: true,
  watch: false,
});

/**
 * A `KeymanStore` over an application-owned Prisma client.
 *
 * Pass the same `PrismaClient` your app already uses — Prisma 7 takes a driver
 * adapter in its constructor, and the store reuses whatever connection you built.
 * To enlist a write in an existing transaction, pass that transaction client
 * instead (`tx` from `$transaction`).
 */
export function prismaStore(
  prisma: PrismaClient,
  options: PrismaStoreOptions = {},
): KeymanStore {
  const model = options.model ?? DEFAULT_MODEL;
  const delegate = (client: PrismaClient): PrismaClient => client[model];
  const uniqueKeyName = options.uniqueKeyName ?? KEY_FIELDS.join('_');
  const batchSize = options.batchSize ?? DEFAULT_BATCH;

  async function read(query: ReadTupleQuery = {}): Promise<Page<Tuple>> {
    const where: Filter = { AND: filtersFor(query) };
    const rows = (await delegate(prisma).findMany({
      where,
      take: query.limit,
    })) as TupleRow[];
    return Object.freeze({ items: Object.freeze(rows.map(rowToTuple)) });
  }

  async function write(input: WriteInput): Promise<void> {
    if (input.tuples.length === 0) return;
    const mode = input.mode ?? 'insert';
    const rows = input.tuples.map(tupleToRow);

    for (const batch of chunked(rows, batchSize)) {
      try {
        if (mode === 'insert') {
          // `skipDuplicates: false` is the default, so a key collision raises
          // and the whole createMany fails. That is what `insert` mode means.
          await delegate(prisma).createMany({ data: batch });
        } else {
          await upsertEach(prisma, delegate, batch, uniqueKeyName);
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
        await delegate(prisma).deleteMany({
          where: { OR: batch.map((row) => keyFilter(row)) },
        });
      }
      return;
    }

    if (input.kind === 'filter') {
      await delegate(prisma).deleteMany({ where: { AND: filtersFor(input.query) } });
      return;
    }

    // Prisma has no interactive-transaction callback that both drivers accept
    // the same way, so the replace is a sequence inside `$transaction`, which is
    // atomic by contract and portable across every provider.
    const rows = input.tuples.map(tupleToRow);
    await prisma.$transaction(async (tx: PrismaClient) => {
      await delegate(tx).deleteMany({ where: { AND: filtersFor(input.query) } });
      for (const batch of chunked(rows, batchSize)) {
        await delegate(tx).createMany({ data: batch });
      }
    });
  }

  return Object.freeze({ capabilities: CAPABILITIES, read, write, delete: remove });
}

/**
 * Prisma's `upsert` is portable across providers, unlike the raw conflict
 * clauses Kysely and Drizzle expose, so it is used directly. It takes a single
 * row, hence the loop.
 */
async function upsertEach(
  prisma: PrismaClient,
  delegate: (client: PrismaClient) => PrismaClient,
  rows: readonly TupleRow[],
  uniqueKeyName: string,
): Promise<void> {
  for (const row of rows) {
    const where = keyFilter(row);
    await delegate(prisma).upsert({
      where: { [uniqueKeyName]: where },
      create: row,
      update: { context: row.context },
    });
  }
}

// ---------------------------------------------------------------------------
// Row <-> Tuple
// ---------------------------------------------------------------------------

export interface TupleRow {
  subjectType: string;
  subjectId: string;
  subjectRelation: string;
  relation: string;
  resourceType: string;
  resourceId: string;
  condition: string;
  context: string | null;
}

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
 * A reference spans three fields, so a set of references is an OR of
 * per-reference conjunctions. Independent `in` filters per field would match a
 * row pairing one reference's type with another's id.
 */
function refFilter(
  filter: string | readonly string[],
  prefix: 'subject' | 'resource',
): Filter {
  const values = typeof filter === 'string' ? [filter] : filter;
  const position = prefix === 'subject' ? 'subject' : 'object';

  return {
    OR: values.map((value) => {
      const ref = parseRef(value, position);
      const terms: Filter = {
        [`${prefix}Type`]: ref.type,
        [`${prefix}Id`]: ref.id,
      };
      if (prefix === 'subject') terms.subjectRelation = ref.relation ?? NULL_ABSENT;
      return terms;
    }),
  };
}

function filtersFor(query: ReadTupleQuery): Filter[] {
  const terms: Filter[] = [];
  if (query.subject !== undefined) terms.push(refFilter(query.subject, 'subject'));
  if (query.relation !== undefined) {
    const values = typeof query.relation === 'string' ? [query.relation] : query.relation;
    terms.push({ relation: { in: [...values] } });
  }
  if (query.resource !== undefined) terms.push(refFilter(query.resource, 'resource'));
  return terms;
}

function keyFilter(row: TupleRow): Filter {
  const where: Filter = {};
  for (const field of KEY_FIELDS) where[field] = row[field];
  return where;
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
