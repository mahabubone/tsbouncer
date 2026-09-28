import type {
  DeleteInput,
  KeymanStore,
  Page,
  ReadTupleQuery,
  Tuple,
} from '../src/index.js';
import { matchesQuery, tupleKey } from '../src/index.js';

/**
 * A minimal in-memory store for the engine tests.
 *
 * `@tsbouncer/core` must have zero dependencies, so its tests cannot reach for
 * `@tsbouncer/memory` — that would make the package depend on its own consumer.
 * This double implements the store contract in a few lines using core's own
 * `matchesQuery`.
 *
 * The risk of a double is that it tests the engine against something no real
 * store behaves like. That risk is bounded from the other side: every real store
 * is verified against the same `storeConformance` suite, so a divergence here
 * shows up as a conformance failure rather than a silent engine bug.
 */
export function testStore(seed: readonly Tuple[] = []): KeymanStore {
  const rows = new Map<string, Tuple>();
  for (const tuple of seed) rows.set(tupleKey(tuple), Object.freeze({ ...tuple }));

  return Object.freeze({
    capabilities: Object.freeze({
      atomicWrite: true,
      persistent: false,
      atomicReplace: true,
      pagination: false,
      transaction: true,
      watch: false,
    }),

    async read(query: ReadTupleQuery = {}): Promise<Page<Tuple>> {
      const items = [...rows.values()].filter((t) => matchesQuery(t, query));
      return Object.freeze({
        items: Object.freeze(
          query.limit === undefined ? items : items.slice(0, query.limit),
        ),
      });
    },

    async write({
      tuples,
      mode = 'insert',
    }: {
      tuples: readonly Tuple[];
      mode?: 'insert' | 'upsert';
    }): Promise<void> {
      for (const tuple of tuples) {
        const key = tupleKey(tuple);
        if (mode === 'insert' && rows.has(key)) {
          throw new Error(`tuple already exists: ${tuple.subject}#${tuple.relation}`);
        }
        rows.set(key, Object.freeze({ ...tuple }));
      }
    },

    async delete(input: DeleteInput): Promise<void> {
      if (input.kind === 'tuples') {
        for (const tuple of input.tuples) rows.delete(tupleKey(tuple));
        return;
      }
      if (input.kind === 'filter') {
        for (const [key, tuple] of rows) {
          if (matchesQuery(tuple, input.query)) rows.delete(key);
        }
        return;
      }
      const next = new Map(rows);
      for (const [key, tuple] of next) {
        if (matchesQuery(tuple, input.query)) next.delete(key);
      }
      for (const tuple of input.tuples)
        next.set(tupleKey(tuple), Object.freeze({ ...tuple }));
      rows.clear();
      for (const [key, tuple] of next) rows.set(key, tuple);
    },
  });
}
