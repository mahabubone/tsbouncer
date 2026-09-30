import type {
  DeleteInput,
  Page,
  ReadTupleQuery,
  Tuple,
  TupleStore,
  TupleStoreCapabilities,
  WriteInput,
} from '@tsbouncer/tsbouncer';
import {
  duplicateTupleMessage,
  matchesQuery,
  StoreError,
  tupleKey,
} from '@tsbouncer/tsbouncer';

export interface MemoryStore extends TupleStore {
  /** Every tuple currently held, in insertion order. */
  snapshot(): readonly Tuple[];
  /** Number of tuples currently held. */
  size(): number;
}

const CAPABILITIES: TupleStoreCapabilities = Object.freeze({
  atomicWrite: true,
  persistent: false,
  atomicReplace: true,
  pagination: true,
  transaction: false,
  watch: false,
});

export interface MemoryStoreOptions {
  readonly tuples?: readonly Tuple[];
}

/**
 * Process-local store. Nothing is persisted; the contents die with the process.
 * That is exactly what makes it useful for tests — every instance is a clean
 * slate, with no fixture cleanup and no shared state between cases.
 */
export function memoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const tuples = new Map<string, Tuple>();

  for (const tuple of options.tuples ?? []) {
    tuples.set(tupleKey(tuple), Object.freeze({ ...tuple }));
  }

  async function read(query: ReadTupleQuery = {}): Promise<Page<Tuple>> {
    const matched: Tuple[] = [];
    for (const tuple of tuples.values()) {
      if (matchesQuery(tuple, query)) matched.push(tuple);
    }

    const offset = decodeCursor(query.cursor);
    // A non-positive limit asks for a page that cannot exist. The SQL stores
    // answer this with an empty result rather than letting `slice`'s negative
    // index walk backwards from the end of the table.
    const limited =
      query.limit === undefined
        ? matched.slice(offset)
        : query.limit <= 0
          ? []
          : matched.slice(offset, offset + query.limit);

    const lastIndex = offset + limited.length;
    const hasMore =
      query.limit !== undefined && query.limit <= 0 ? false : lastIndex < matched.length;

    return Object.freeze({
      items: Object.freeze(limited),
      cursor: hasMore ? String(lastIndex) : undefined,
    });
  }

  async function write(input: WriteInput): Promise<void> {
    const mode = input.mode ?? 'insert';
    if (mode === 'insert') {
      // Both the stored keys *and* the rest of the batch. Checking only what is
      // already stored lets one call insert the same key twice and keep the
      // later row, which is not what `insert` means on any SQL store.
      const seen = new Set<string>();
      for (const tuple of input.tuples) {
        const key = tupleKey(tuple);
        if (tuples.has(key) || seen.has(key)) {
          throw new StoreError(duplicateTupleMessage(tuple));
        }
        seen.add(key);
      }
    }
    for (const tuple of input.tuples) {
      tuples.set(tupleKey(tuple), Object.freeze({ ...tuple }));
    }
  }

  async function remove(input: DeleteInput): Promise<void> {
    if (input.kind === 'tuples') {
      for (const tuple of input.tuples) tuples.delete(tupleKey(tuple));
      return;
    }

    if (input.kind === 'filter') {
      for (const [key, tuple] of tuples) {
        if (matchesQuery(tuple, input.query)) tuples.delete(key);
      }
      return;
    }

    const next = new Map(tuples);
    for (const [key, tuple] of next) {
      if (matchesQuery(tuple, input.query)) next.delete(key);
    }
    for (const tuple of input.tuples) {
      next.set(tupleKey(tuple), Object.freeze({ ...tuple }));
    }
    tuples.clear();
    for (const [key, tuple] of next) tuples.set(key, tuple);
  }

  return Object.freeze({
    capabilities: CAPABILITIES,
    read,
    write,
    delete: remove,
    snapshot: () => Object.freeze([...tuples.values()]),
    size: () => tuples.size,
  });
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(cursor)) {
    throw new StoreError(`invalid cursor ${JSON.stringify(cursor)}`);
  }
  return Number(cursor);
}
