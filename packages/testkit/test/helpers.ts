import {
  assertCacheSet,
  type Cache,
  type DeleteInput,
  matchesQuery,
  NO_CAPABILITIES,
  type Tuple,
  type TupleStore,
  tupleKey,
  type WriteInput,
} from '@tsbouncer/tsbouncer';

/**
 * A minimal, honest store: an array, a key, and `matchesQuery`.
 *
 * This exists so both the golden suite and `storeConformance` can be pointed at
 * something whose behaviour is obvious by inspection. `testkit` depends on
 * `tsbouncer` and nothing else, so without it the package would ship the
 * gate without ever running it — and a conformance suite that has never been
 * executed is not a gate, it is a file.
 *
 * The write and delete paths are deliberately not simplified. They implement
 * the contract exactly — insert rejects a key already stored *or repeated in the
 * batch*, upsert is last-wins in order, an empty value list matches nothing —
 * because the suite's job is to catch stores that get precisely those wrong, and
 * a reference that glosses over them would make the suite grade itself.
 */
export function arrayStore(
  seed: readonly Tuple[] = [],
  overrides: Partial<TupleStore> = {},
): TupleStore {
  let rows: Tuple[] = [...seed];
  return {
    capabilities: {
      ...NO_CAPABILITIES,
      atomicWrite: true,
      atomicReplace: true,
      pagination: true,
      ...overrides.capabilities,
    },
    async read(query = {}) {
      const matched = rows.filter((row) => matchesQuery(row, query));
      if (query.limit === undefined) return { items: matched };
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const items = matched.slice(start, start + query.limit);
      const more = start + items.length < matched.length;
      return more ? { items, cursor: String(start + items.length) } : { items };
    },
    async write(input: WriteInput) {
      const mode = input.mode ?? 'insert';
      if (mode === 'insert') {
        const stored = new Set(rows.map(tupleKey));
        const seen = new Set<string>();
        for (const tuple of input.tuples) {
          const key = tupleKey(tuple);
          if (stored.has(key) || seen.has(key)) {
            throw new Error(`duplicate tuple: ${key}`);
          }
          seen.add(key);
        }
      }
      const byKey = new Map(rows.map((row) => [tupleKey(row), row]));
      for (const tuple of input.tuples) byKey.set(tupleKey(tuple), tuple);
      rows = [...byKey.values()];
    },
    async delete(input: DeleteInput) {
      if (input.kind === 'tuples') {
        const keys = new Set(input.tuples.map(tupleKey));
        rows = rows.filter((row) => !keys.has(tupleKey(row)));
        return;
      }
      const doomed = new Set(rows.filter((row) => matchesQuery(row, input.query)));
      rows = rows.filter((row) => !doomed.has(row));
      if (input.kind === 'replace') rows.push(...input.tuples);
    },
    ...overrides,
  };
}

/**
 * The failure mode this whole design exists to prevent: a store whose filter is
 * slightly too permissive. It returns every row regardless of the query, so it
 * still *looks* like a store and still passes a naive smoke test — it just
 * answers a different question than the one it was asked.
 */
export function overMatchingStore(seed: readonly Tuple[] = []): TupleStore {
  return arrayStore(seed, {
    async read() {
      return { items: [...seed] };
    },
  });
}

/**
 * The other direction: a store that drops the condition name and bindings, so a
 * conditional grant silently becomes unconditional. That is fail-*open*, and it
 * is the one a "reimplement per adapter" approach produces.
 */
export function conditionStrippingStore(): TupleStore {
  return arrayStore([], {
    async write(input: WriteInput) {
      // Silently persists only the edge, dropping `condition` and `context`.
      void input;
    },
  });
}

/**
 * A minimal, honest cache: a map, an expiry timestamp, and the shared
 * validation. This exists so `cacheConformance` is executed by the package
 * that ships it, against a reference whose behaviour is obvious by
 * inspection — the same reason `arrayStore` exists for the store suite.
 */
export function objectCache(
  entries: readonly (readonly [string, unknown])[] = [],
): Cache {
  const held = new Map<string, { value: unknown; expiresAt?: number }>();
  for (const [key, value] of entries) {
    assertCacheSet(key, value, undefined, true);
    held.set(key, { value: structuredClone(value) });
  }
  const live = (key: string): unknown => {
    const entry = held.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      held.delete(key);
      return undefined;
    }
    return structuredClone(entry.value);
  };
  return {
    capabilities: { persistent: false, ttl: true },
    async get(key: string): Promise<unknown> {
      return live(key);
    },
    async set(key: string, value: unknown, options?: { ttlMs?: number }): Promise<void> {
      const ttlMs = options?.ttlMs;
      assertCacheSet(key, value, ttlMs, true);
      held.set(
        key,
        ttlMs === undefined
          ? { value: structuredClone(value) }
          : { value: structuredClone(value), expiresAt: Date.now() + ttlMs },
      );
    },
    async delete(key: string): Promise<void> {
      held.delete(key);
    },
    async clear(prefix: string): Promise<void> {
      for (const key of [...held.keys()]) {
        if (key.startsWith(prefix)) held.delete(key);
      }
    },
  };
}
