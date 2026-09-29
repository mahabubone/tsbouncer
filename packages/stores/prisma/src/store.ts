import type {
  DeleteInput,
  Page,
  ReadTupleQuery,
  Tuple,
  TupleStore,
  TupleStoreCapabilities,
  WriteInput,
} from 'tsbouncer';
import { formatRef, parseRef, StoreError } from 'tsbouncer';
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

const CAPABILITIES: TupleStoreCapabilities = Object.freeze({
  atomicWrite: true,
  persistent: true,
  atomicReplace: true,
  pagination: false,
  transaction: true,
  watch: false,
});

/**
 * A `TupleStore` over an application-owned Prisma client.
 *
 * Pass the same `PrismaClient` your app already uses — Prisma 7 takes a driver
 * adapter in its constructor, and the store reuses whatever connection you built.
 * To enlist a write in an existing transaction, pass that transaction client
 * instead (`tx` from `$transaction`).
 */
export function prismaStore(
  prisma: PrismaClient,
  options: PrismaStoreOptions = {},
): TupleStore {
  if (prisma === undefined || prisma === null) {
    throw new TypeError('prismaStore: the first argument is your Prisma client.');
  }

  const model = options.model ?? DEFAULT_MODEL;
  // Prisma answers an unknown model with `TypeError: Cannot read properties of
  // undefined (reading 'findMany')` from somewhere deep inside the first query.
  // The delegate is either there or it is not, so the caller can be told now.
  if (prisma[model] === undefined || prisma[model] === null) {
    throw new TypeError(
      `prismaStore: this Prisma client has no model "${model}". Pass \`model\` in the options if yours is named differently.`,
    );
  }
  const delegate = (client: PrismaClient): PrismaClient => client[model];
  const uniqueKeyName = options.uniqueKeyName ?? KEY_FIELDS.join('_');
  const batchSize = options.batchSize ?? DEFAULT_BATCH;

  async function read(query: ReadTupleQuery = {}): Promise<Page<Tuple>> {
    // `take: 0` and `take: -1` are both nonsense, and the providers disagree
    // about what they mean. An empty page is the only answer that needs no
    // interpretation.
    if (query.limit !== undefined && query.limit <= 0) {
      return Object.freeze({ items: Object.freeze([] as Tuple[]) });
    }

    try {
      const where: Filter = { AND: filtersFor(query) };
      const rows = (await delegate(prisma).findMany({
        where,
        take: query.limit,
      })) as TupleRow[];
      return Object.freeze({ items: Object.freeze(rows.map(rowToTuple)) });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError('read failed', { cause });
    }
  }

  async function write(input: WriteInput): Promise<void> {
    if (input.tuples.length === 0) return;
    const mode = input.mode ?? 'insert';
    const batches = [...chunked(input.tuples.map(tupleToRow), batchSize)];

    const apply = async (
      client: PrismaClient,
      batch: readonly TupleRow[],
    ): Promise<void> => {
      if (mode === 'insert') {
        // `skipDuplicates: false` is the default, so a key collision raises
        // and the whole createMany fails. That is what `insert` mode means.
        await delegate(client).createMany({ data: batch });
        return;
      }
      await upsertEach(client, delegate, batch, uniqueKeyName);
    };

    try {
      // `createMany` is atomic for one batch; `upsert` is one statement per row.
      // Past a single statement, issuing them in sequence with nothing between
      // them means a failure partway leaves the earlier ones committed — for
      // `replace` and multi-batch writes, the caller sees an error and has no
      // way to know what landed.
      const statements = mode === 'insert' ? batches.length : input.tuples.length;
      if (statements <= 1) {
        await apply(prisma, batches[0] as readonly TupleRow[]);
        return;
      }
      await prisma.$transaction(async (tx: PrismaClient) => {
        for (const batch of batches) await apply(tx, batch);
      });
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError(describeFailure(mode, cause), { cause });
    }
  }

  async function remove(input: DeleteInput): Promise<void> {
    try {
      if (input.kind === 'tuples') {
        const batches = [...chunked(input.tuples.map(tupleToRow), batchSize)];
        const apply = async (
          client: PrismaClient,
          batch: readonly TupleRow[],
        ): Promise<void> => {
          await delegate(client).deleteMany({
            where: { OR: batch.map((row) => keyFilter(row)) },
          });
        };
        if (batches.length === 1) {
          await apply(prisma, batches[0] as readonly TupleRow[]);
          return;
        }
        await prisma.$transaction(async (tx: PrismaClient) => {
          for (const batch of batches) await apply(tx, batch);
        });
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
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError('delete failed', { cause });
    }
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
  // `subject_relation` and `condition` are `''` when absent *by contract*. A row
  // written by a schema that allowed NULL would otherwise be rendered
  // `user:alice#null`, a reference that matches no filter and cannot be deleted
  // by one — so `null` is read as absent rather than as a relation name.
  const subject = formatRef({
    type: row.subjectType,
    id: row.subjectId,
    relation:
      row.subjectRelation == null || row.subjectRelation === NULL_ABSENT
        ? undefined
        : row.subjectRelation,
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
    condition:
      row.condition == null || row.condition === NULL_ABSENT ? undefined : row.condition,
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
 *
 * An **empty** set has to be written out: Prisma reads `OR: []` as "no
 * condition", so `read({ subject: [] })` matched every row and
 * `delete({ subject: [] })` emptied the table. `in: []` matches nothing on
 * every provider.
 */
function refFilter(
  filter: string | readonly string[],
  prefix: 'subject' | 'resource',
): Filter {
  const values = typeof filter === 'string' ? [filter] : filter;
  if (values.length === 0) return { [`${prefix}Type`]: { in: [] } };
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
    if (values.length === 0) terms.push({ relation: { in: [] } });
    else terms.push({ relation: { in: [...values] } });
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

/**
 * The message for a failed write.
 *
 * It used to claim a unique constraint on every insert failure, so a connection
 * that dropped mid-batch was reported as "a tuple with this key already exists".
 * The claim is made only when the driver actually reported one — Prisma `P2002`,
 * SQLite `UNIQUE constraint failed`, Postgres `23505`, MySQL `ER_DUP_ENTRY` —
 * and the original error stays on `cause` either way.
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
