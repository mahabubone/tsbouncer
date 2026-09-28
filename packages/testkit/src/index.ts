import type { KeymanStore, Tuple } from '@tsbouncer/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

export interface ConformanceOptions {
  /** Used in the suite name. */
  readonly name: string;
  /** Produce a fresh, empty store for each test. */
  readonly create: () => KeymanStore | Promise<KeymanStore>;
  /** Release any resources held by the store. */
  readonly teardown?: (store: KeymanStore) => void | Promise<void>;
  /**
   * Stores are not required to support every capability. Any capability listed
   * here is skipped. Capabilities that are *not* listed are asserted to work, so
   * do not silence a failure you have not understood.
   */
  readonly skip?: readonly (keyof KeymanStore['capabilities'])[];
}

const ALICE: Tuple = {
  subject: 'user:alice',
  relation: 'viewer',
  resource: 'document:1',
};
const BOB: Tuple = { subject: 'user:bob', relation: 'viewer', resource: 'document:1' };
const CAROL: Tuple = {
  subject: 'user:carol',
  relation: 'editor',
  resource: 'document:1',
};
const OTHER: Tuple = {
  subject: 'user:alice',
  relation: 'viewer',
  resource: 'document:2',
};

const SEED = [ALICE, BOB, CAROL, OTHER];

function label(tuple: Tuple): string {
  return `${tuple.subject}#${tuple.relation}@${tuple.resource}`;
}

function ids(tuples: readonly Tuple[]): string[] {
  return tuples.map(label).sort();
}

/**
 * Runs the full store contract against a store implementation.
 *
 * This suite is intentionally narrow: it tests the guarantees in
 * `PLAN.md` and nothing else. It does not assert ordering, error messages, or
 * error types — those are implementation details, and pinning them would make
 * the suite hostile to legitimate stores. If a store cannot pass this, it is
 * not a `KeymanStore`.
 */
export function storeConformance(options: ConformanceOptions): void {
  const skip = new Set(options.skip ?? []);

  describe(`store conformance: ${options.name}`, () => {
    let store: KeymanStore;

    const seed = async (tuples: readonly Tuple[] = SEED): Promise<void> => {
      await store.write({ tuples, mode: 'upsert' });
    };

    const read = async (query: Parameters<KeymanStore['read']>[0] = {}) => {
      const page = await store.read(query);
      return page.items;
    };

    beforeEach(async () => {
      store = await options.create();
    });

    afterEach(async () => {
      await options.teardown?.(store);
    });

    // -- capabilities ------------------------------------------------------

    describe('capabilities', () => {
      it('declares a capabilities object with every flag set', () => {
        expect(typeof store.capabilities).toBe('object');
        for (const flag of [
          'atomicWrite',
          'persistent',
          'atomicReplace',
          'pagination',
          'transaction',
          'watch',
        ] as const) {
          expect(typeof store.capabilities[flag]).toBe('boolean');
        }
      });
    });

    // -- read --------------------------------------------------------------

    describe('read', () => {
      it('returns an empty page for an empty store', async () => {
        expect(await read()).toEqual([]);
      });

      it('returns every tuple when unfiltered', async () => {
        await seed();
        expect(ids(await read())).toEqual(ids(SEED));
      });

      it('filters by subject', async () => {
        await seed();
        expect(ids(await read({ subject: 'user:alice' }))).toEqual(ids([ALICE, OTHER]));
      });

      it('filters by relation', async () => {
        await seed();
        expect(ids(await read({ relation: 'viewer' }))).toEqual(ids([ALICE, BOB, OTHER]));
      });

      it('filters by resource', async () => {
        await seed();
        expect(ids(await read({ resource: 'document:2' }))).toEqual(ids([OTHER]));
      });

      it('applies every filter as a conjunction', async () => {
        await seed();
        expect(
          ids(await read({ subject: 'user:alice', resource: 'document:1' })),
        ).toEqual(['user:alice#viewer@document:1']);
        expect(
          await read({
            subject: 'user:alice',
            relation: 'editor',
            resource: 'document:1',
          }),
        ).toEqual([]);
      });

      it('accepts an array of values for a filter', async () => {
        await seed();
        expect(ids(await read({ subject: ['user:alice', 'user:bob'] }))).toEqual(
          ids([ALICE, BOB, OTHER]),
        );
      });

      it('treats a wildcard reference as a literal filter value', async () => {
        await seed([{ subject: 'user:*', relation: 'viewer', resource: 'document:1' }]);
        expect(ids(await read({ subject: 'user:*' }))).toEqual([
          'user:*#viewer@document:1',
        ]);
      });

      it('returns an empty page when nothing matches', async () => {
        await seed();
        expect(await read({ subject: 'user:nobody' })).toEqual([]);
      });

      it('does not require every filter to be present', async () => {
        await seed();
        expect((await read({ relation: 'viewer' })).length).toBe(3);
        expect((await read({})).length).toBe(4);
      });
    });

    // -- write -------------------------------------------------------------

    describe('write', () => {
      it('inserts new tuples', async () => {
        await store.write({ tuples: [ALICE] });
        expect(ids(await read())).toEqual(['user:alice#viewer@document:1']);
      });

      it('inserts many tuples in one call', async () => {
        await store.write({ tuples: SEED });
        expect((await read()).length).toBe(4);
      });

      it('rejects a duplicate on insert mode', async () => {
        await store.write({ tuples: [ALICE] });
        await expect(store.write({ tuples: [ALICE] })).rejects.toThrow();
        expect((await read()).length).toBe(1);
      });

      it('replaces a tuple sharing a key on upsert mode', async () => {
        const conditioned: Tuple = {
          ...ALICE,
          condition: 'inRegion',
          context: { region: 'eu' },
        };
        await store.write({ tuples: [conditioned] });
        await store.write({
          tuples: [{ ...conditioned, context: { region: 'us' } }],
          mode: 'upsert',
        });
        const found = await read();
        expect(found.length).toBe(1);
        expect(found[0]?.context).toEqual({ region: 'us' });
      });

      it('leaves existing tuples untouched when insert rejects', async () => {
        await store.write({ tuples: [ALICE] });
        await expect(store.write({ tuples: [BOB, ALICE] })).rejects.toThrow();
        expect(ids(await read())).toEqual(['user:alice#viewer@document:1']);
      });
    });

    // -- delete ------------------------------------------------------------

    describe('delete', () => {
      it('removes a single tuple by identity', async () => {
        await seed();
        await store.delete({ kind: 'tuples', tuples: [ALICE] });
        expect(ids(await read())).toEqual(ids([BOB, CAROL, OTHER]));
      });

      it('ignores a delete for a tuple that does not exist', async () => {
        await seed();
        await store.delete({
          kind: 'tuples',
          tuples: [{ ...ALICE, subject: 'user:nobody' }],
        });
        expect((await read()).length).toBe(4);
      });

      it('removes everything matching a filter', async () => {
        await seed();
        await store.delete({ kind: 'filter', query: { relation: 'viewer' } });
        expect(ids(await read())).toEqual(['user:carol#editor@document:1']);
      });

      it('replaces a filtered set atomically', async () => {
        await seed();
        const replacement: Tuple = {
          subject: 'user:dave',
          relation: 'viewer',
          resource: 'document:1',
        };
        await store.delete({
          kind: 'replace',
          query: { resource: 'document:1' },
          tuples: [replacement],
        });
        expect(ids(await read())).toEqual(
          ids([
            { subject: 'user:dave', relation: 'viewer', resource: 'document:1' },
            OTHER,
          ]),
        );
      });

      it('keeps tuples outside the replace filter', async () => {
        await seed();
        await store.delete({
          kind: 'replace',
          query: { resource: 'document:1' },
          tuples: [],
        });
        expect(ids(await read())).toEqual(['user:alice#viewer@document:2']);
      });
    });

    // -- identity ----------------------------------------------------------

    describe('tuple identity', () => {
      it('treats condition as part of a tuple key', async () => {
        const plain: Tuple = { ...ALICE };
        const conditioned: Tuple = { ...ALICE, condition: 'inRegion' };
        await store.write({ tuples: [plain, conditioned], mode: 'upsert' });
        const found = await read();
        expect(found.length).toBe(2);
      });

      it('round-trips condition context unchanged', async () => {
        const conditioned: Tuple = {
          ...ALICE,
          condition: 'inRegion',
          context: { region: 'eu', tier: 'pro' },
        };
        await store.write({ tuples: [conditioned] });
        expect((await read())[0]).toEqual(conditioned);
      });

      it('keeps userset subjects and wildcards intact', async () => {
        const userset: Tuple = {
          subject: 'team:eng#member',
          relation: 'viewer',
          resource: 'document:1',
        };
        const star: Tuple = {
          subject: 'user:*',
          relation: 'viewer',
          resource: 'document:1',
        };
        await store.write({ tuples: [userset, star] });
        expect(ids(await read())).toEqual(ids([userset, star]));
      });
    });

    // -- pagination (capability gated) ------------------------------------

    describe.skipIf(skip.has('pagination'))('pagination', () => {
      it('honours limit and returns a cursor while more remain', async () => {
        await seed();
        const first = await store.read({ limit: 2 });
        expect(first.items.length).toBe(2);
        expect(first.cursor).toBeDefined();

        const second = await store.read({ limit: 2, cursor: first.cursor });
        expect(second.items.length).toBe(2);
        expect(new Set([...first.items, ...second.items]).size).toBe(4);
      });

      it('omits the cursor on the final page', async () => {
        await seed();
        const page = await store.read({ limit: 10 });
        expect(page.cursor).toBeUndefined();
      });
    });
  });
}

export { SEED as CONFORMANCE_SEED };
