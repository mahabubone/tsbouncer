import type { Cache } from 'tsbouncer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

export interface CacheConformanceOptions {
  /** Used in the suite name. */
  readonly name: string;
  /** Produce a fresh, empty cache for each test. */
  readonly create: () => Cache | Promise<Cache>;
  /** Release any resources held by the cache. */
  readonly teardown?: (cache: Cache) => void | Promise<void>;
  /**
   * Caches are not required to support every capability. Any capability listed
   * here is skipped. Capabilities that are *not* listed are asserted to work,
   * so do not silence a failure you have not understood.
   */
  readonly skip?: readonly (keyof Cache['capabilities'])[];
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs the cache contract against an implementation.
 *
 * Same shape and same narrowness as `storeConformance`: it tests the
 * guarantees in `PLAN.md` and nothing else. It does not assert ordering,
 * error messages, or error types — those are implementation details, and
 * pinning them would make the suite hostile to legitimate caches. If a cache
 * cannot pass this, it is not a `Cache`.
 */
export function cacheConformance(options: CacheConformanceOptions): void {
  const skip = new Set(options.skip ?? []);

  describe(`cache conformance: ${options.name}`, () => {
    let cache: Cache;

    beforeEach(async () => {
      cache = await options.create();
    });

    afterEach(async () => {
      await options.teardown?.(cache);
    });

    // -- capabilities ------------------------------------------------------

    describe('capabilities', () => {
      it('declares a capabilities object with every flag set', () => {
        expect(typeof cache.capabilities).toBe('object');
        for (const flag of ['persistent', 'ttl'] as const) {
          expect(typeof cache.capabilities[flag]).toBe('boolean');
        }
      });
    });

    // -- get / set ---------------------------------------------------------

    describe('get and set', () => {
      it('round-trips JSON values', async () => {
        await cache.set('s', ' Regions ');
        await cache.set('n', 42);
        await cache.set('b', false);
        await cache.set('nil', null);
        await cache.set('obj', { allowed: true, truncated: false, tags: ['a', 'b'] });
        expect(await cache.get('s')).toBe(' Regions ');
        expect(await cache.get('n')).toBe(42);
        expect(await cache.get('b')).toBe(false);
        expect(await cache.get('nil')).toBe(null);
        expect(await cache.get('obj')).toEqual({
          allowed: true,
          truncated: false,
          tags: ['a', 'b'],
        });
      });

      it('answers undefined for a missing key', async () => {
        expect(await cache.get('nope')).toBeUndefined();
      });

      it('replaces the entry already under a key', async () => {
        await cache.set('k', 1);
        await cache.set('k', 2);
        expect(await cache.get('k')).toBe(2);
      });

      it('rejects undefined, which is the miss signal', async () => {
        await expect(cache.set('k', undefined)).rejects.toThrow();
      });

      it('rejects an empty key', async () => {
        await expect(cache.set('', 1)).rejects.toThrow();
      });
    });

    // -- delete ------------------------------------------------------------

    describe('delete', () => {
      it('removes an entry', async () => {
        await cache.set('k', 1);
        await cache.delete('k');
        expect(await cache.get('k')).toBeUndefined();
      });

      it('ignores a delete for a key that does not exist', async () => {
        await cache.delete('ghost');
        expect(await cache.get('ghost')).toBeUndefined();
      });
    });

    // -- clear -------------------------------------------------------------

    describe('clear', () => {
      it('removes only the entries under the prefix', async () => {
        await cache.set('a:1', 1);
        await cache.set('a:2', 2);
        await cache.set('b:1', 3);
        await cache.clear('a:');
        expect(await cache.get('a:1')).toBeUndefined();
        expect(await cache.get('a:2')).toBeUndefined();
        expect(await cache.get('b:1')).toBe(3);
      });

      it('clears everything on an empty prefix', async () => {
        await cache.set('a:1', 1);
        await cache.set('b:1', 2);
        await cache.clear('');
        expect(await cache.get('a:1')).toBeUndefined();
        expect(await cache.get('b:1')).toBeUndefined();
      });
    });

    // -- ttl (capability gated) --------------------------------------------

    describe.skipIf(skip.has('ttl'))('ttl', () => {
      it('serves an entry before it expires', async () => {
        await cache.set('k', 1, { ttlMs: 60_000 });
        expect(await cache.get('k')).toBe(1);
      });

      it('expires an entry with ttlMs 0', async () => {
        await cache.set('k', 1, { ttlMs: 0 });
        expect(await cache.get('k')).toBeUndefined();
      });

      it('expires an entry after its ttl', async () => {
        await cache.set('k', 1, { ttlMs: 50 });
        expect(await cache.get('k')).toBe(1);
        const deadline = Date.now() + 5000;
        while ((await cache.get('k')) !== undefined) {
          expect(Date.now()).toBeLessThan(deadline);
          await sleep(25);
        }
        expect(await cache.get('k')).toBeUndefined();
      });

      it('rejects a ttl that is not a usable duration', async () => {
        await expect(cache.set('k', 1, { ttlMs: Number.NaN })).rejects.toThrow();
      });
    });
  });
}
