import type { ConditionContext } from './model.js';

/**
 * One authorization edge.
 *
 * `subject` and `resource` are opaque reference strings (`user:alice`,
 * `team:engineering#member`, `user:*`). The store never resolves them.
 *
 * `condition` and `context` are the data half of a condition: the *name* and the
 * parameter bindings. The predicate itself lives in the model as code. Keeping
 * them apart is what lets a tuple serialize to JSON or a database column while
 * the model stays a program.
 */
export interface Tuple {
  readonly subject: string;
  readonly relation: string;
  readonly resource: string;
  readonly condition?: string | undefined;
  readonly context?: ConditionContext | undefined;
}

/** Canonical identity of a tuple. Two tuples with the same key are the same edge. */
export function tupleKey(tuple: Tuple): string {
  return [tuple.subject, tuple.relation, tuple.resource, tuple.condition ?? ''].join('|');
}

export type FilterValue = string | readonly string[];

export interface ReadTupleQuery {
  /** Match subjects exactly. `'user:*'` matches any user. Omit to match all. */
  readonly subject?: FilterValue | undefined;
  readonly relation?: FilterValue | undefined;
  readonly resource?: FilterValue | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor?: string | undefined;
}

export type WriteMode =
  /** Reject the write if any tuple already exists. The default. */
  | 'insert'
  /** Replace existing tuples that share a key. */
  | 'upsert';

export interface WriteInput {
  readonly tuples: readonly Tuple[];
  readonly mode?: WriteMode | undefined;
}

export type DeleteInput =
  | { readonly kind: 'tuples'; readonly tuples: readonly Tuple[] }
  | { readonly kind: 'filter'; readonly query: ReadTupleQuery }
  | {
      readonly kind: 'replace';
      readonly query: ReadTupleQuery;
      readonly tuples: readonly Tuple[];
    };

export interface KeymanStoreCapabilities {
  /** Writes are applied as one all-or-nothing unit. */
  readonly atomicWrite: boolean;
  /** State survives process exit. */
  readonly persistent: boolean;
  /** `replace` deletes are atomic with their subsequent write. */
  readonly atomicReplace: boolean;
  /** `read` honours `limit` and returns a `cursor`. */
  readonly pagination: boolean;
  /** A transaction handle can be produced by `store.transact?`. */
  readonly transaction: boolean;
  /** Invalidations are emitted on change. */
  readonly watch: boolean;
}

export const NO_CAPABILITIES: KeymanStoreCapabilities = Object.freeze({
  atomicWrite: false,
  persistent: false,
  atomicReplace: false,
  pagination: false,
  transaction: false,
  watch: false,
});

/**
 * The entire contract a store must satisfy.
 *
 * `read` is the only primitive everything else derives from — reverse walks,
 * `expand`, and `listResources` are all built on top of it by the engine. There
 * is deliberately no optional `check()` fast path: pushing permission evaluation
 * into a store means reimplementing wildcard, rewrite, TTU, and exclusion
 * semantics per-adapter, which is the most likely way this library would ship
 * an authorization decision that is subtly wrong.
 *
 * Stores move tuples. They do not evaluate conditions, resolve permissions, or
 * decide anything.
 */
export interface KeymanStore {
  readonly capabilities: KeymanStoreCapabilities;
  read(query?: ReadTupleQuery): Promise<Page<Tuple>>;
  write(input: WriteInput): Promise<void>;
  delete(input: DeleteInput): Promise<void>;
}

export function assertStoreShape(value: unknown): asserts value is KeymanStore {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('store must be an object');
  }
  const store = value as Partial<KeymanStore>;
  for (const method of ['read', 'write', 'delete'] as const) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`store is missing required method ${method}()`);
    }
  }
  if (typeof store.capabilities !== 'object' || store.capabilities === null) {
    throw new TypeError('store must declare a `capabilities` object');
  }
}

export function matchesQuery(tuple: Tuple, query: ReadTupleQuery = {}): boolean {
  return (
    matchesField(tuple.subject, query.subject) &&
    matchesField(tuple.relation, query.relation) &&
    matchesField(tuple.resource, query.resource)
  );
}

function matchesField(value: string, filter: FilterValue | undefined): boolean {
  if (filter === undefined) return true;
  return typeof filter === 'string' ? value === filter : filter.includes(value);
}
