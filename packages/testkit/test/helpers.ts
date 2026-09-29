import {
  type DeleteInput,
  matchesQuery,
  NO_CAPABILITIES,
  type Tuple,
  type TupleStore,
  type WriteInput,
} from '@tsbouncer/core';

/**
 * A minimal, honest store: an array and `matchesQuery`.
 *
 * This exists so the golden suite can be pointed at something whose behaviour is
 * obvious by inspection. `testkit` depends on `@tsbouncer/core` and nothing else,
 * so without it the suite has no store of its own to test against — and a
 * conformance suite that has never been executed is not a gate, it is a file.
 */
export function arrayStore(
  seed: readonly Tuple[] = [],
  overrides: Partial<TupleStore> = {},
): TupleStore {
  const rows: Tuple[] = [...seed];
  return {
    capabilities: { ...NO_CAPABILITIES, atomicWrite: true, ...overrides.capabilities },
    async read(query) {
      return { items: rows.filter((row) => matchesQuery(row, query)) };
    },
    async write(input: WriteInput) {
      rows.length = 0;
      rows.push(...input.tuples);
    },
    async delete(_input: DeleteInput) {
      rows.length = 0;
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
