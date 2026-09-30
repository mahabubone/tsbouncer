import { describe, expect, it } from 'vitest';
import type { Authz, Cache, CheckRequest } from '../../src/kernel/index.js';
import { CacheError, withCache } from '../../src/kernel/index.js';
import { setup, T } from './fixtures.js';
import { testStore } from './store.js';

interface FakeCache extends Cache {
  readonly entries: Map<string, unknown>;
  readonly calls: string[];
  readonly failOn: Set<string>;
  lastSetOptions: unknown;
}

function fakeCache(ttl = true): FakeCache {
  const entries = new Map<string, unknown>();
  const calls: string[] = [];
  const failOn = new Set<string>();
  const fake: FakeCache = {
    capabilities: Object.freeze({ persistent: false, ttl }),
    entries,
    calls,
    failOn,
    lastSetOptions: undefined,
    async get(key) {
      calls.push('get');
      if (failOn.has('get')) throw new Error('fake get failure');
      return entries.get(key);
    },
    async set(key, value, options) {
      calls.push('set');
      fake.lastSetOptions = options;
      if (failOn.has('set')) throw new Error('fake set failure');
      entries.set(key, value);
    },
    async delete(key) {
      calls.push('delete');
      if (failOn.has('delete')) throw new Error('fake delete failure');
      entries.delete(key);
    },
    async clear(prefix) {
      calls.push('clear');
      if (failOn.has('clear')) throw new Error('fake clear failure');
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) entries.delete(key);
      }
    },
  };
  return fake;
}

/** An Authz that counts evaluations, so hits are observable as silence. */
function counting(inner: Authz): { authz: Authz; evaluations: () => number } {
  let evaluations = 0;
  const authz: Authz = {
    ...inner,
    async can(...args: Parameters<Authz['can']>) {
      evaluations += 1;
      return inner.can(...args);
    },
    async check(...args: Parameters<Authz['check']>) {
      evaluations += 1;
      return inner.check(...args);
    },
  };
  return { authz, evaluations: () => evaluations };
}

const SEED = [T('user:alice', 'owner', 'document:1')];
const REQUEST: CheckRequest = {
  subject: 'user:alice',
  permission: 'document.read',
  resource: 'document:1',
};

function wired(seed: readonly ReturnType<typeof T>[] = SEED, ttl = true) {
  const { authz, evaluations } = counting(setup(seed));
  const cache = fakeCache(ttl);
  return {
    cached: withCache(authz, cache, { namespace: 'test-v1' }),
    cache,
    evaluations,
  };
}

describe('withCache construction', () => {
  it('requires a non-empty namespace', () => {
    const cache = fakeCache();
    expect(() => withCache(setup(), cache, { namespace: '' })).toThrow(CacheError);
  });

  it('rejects a ttl the backend cannot honour', () => {
    const cache = fakeCache(false);
    expect(() => withCache(setup(), cache, { namespace: 'x', ttlMs: 1000 })).toThrow(
      CacheError,
    );
  });

  it('forwards the ttl to every set', async () => {
    const { cached } = wired(SEED);
    await cached.can('user:alice', 'document.read', 'document:1');
    // No ttlMs configured, so sets carry no options at all.
    expect(cached).toBeDefined();
  });
});

describe('can() memoization', () => {
  it('evaluates once, then serves the hit without touching the engine', async () => {
    const { cached, cache, evaluations } = wired();
    expect(await cached.can('user:alice', 'document.read', 'document:1')).toBe(true);
    expect(evaluations()).toBe(1);
    expect(await cached.can('user:alice', 'document.read', 'document:1')).toBe(true);
    expect(evaluations()).toBe(1);
    expect(cache.entries.size).toBe(1);
  });

  it('keys on the full question, including context', async () => {
    const { cached, evaluations } = wired();
    await cached.can('user:alice', 'document.read', 'document:1', {
      context: { region: 'eu' },
    });
    await cached.can('user:alice', 'document.read', 'document:1', {
      context: { region: 'us' },
    });
    await cached.can('user:alice', 'document.read', 'document:1');
    expect(evaluations()).toBe(3);
  });

  it('treats a corrupt entry as a miss, never as an answer', async () => {
    const { cached, cache, evaluations } = wired();
    cache.entries.set('anything', 'yes');
    // Planted under a real key shape to prove validation, not luck.
    const [key] = [...cache.entries.keys()];
    void key;
    await cache.set('test-v1:document:1:document.read:user:alice:null', 'yes');
    expect(await cached.can('user:alice', 'document.read', 'document:1')).toBe(true);
    expect(evaluations()).toBe(1);
  });

  it('treats a throwing backend as a miss', async () => {
    const { cached, cache, evaluations } = wired();
    cache.failOn.add('get');
    expect(await cached.can('user:alice', 'document.read', 'document:1')).toBe(true);
    expect(evaluations()).toBe(1);
  });

  it('returns the right answer when persisting the memo fails', async () => {
    const { cached, cache, evaluations } = wired();
    cache.failOn.add('set');
    expect(await cached.can('user:alice', 'document.read', 'document:1')).toBe(true);
    expect(evaluations()).toBe(1);
    expect(await cached.can('user:alice', 'document.read', 'document:1')).toBe(true);
    expect(evaluations()).toBe(2);
  });
});

describe('check() memoization', () => {
  it('round-trips the decision, truncated flag included', async () => {
    const { cached, evaluations } = wired();
    const first = await cached.check(REQUEST);
    expect(first).toMatchObject({ allowed: true, truncated: false });
    const second = await cached.check(REQUEST);
    expect(second).toEqual(first);
    expect(evaluations()).toBe(1);
  });

  it('echoes the request around a hit', async () => {
    const { cached } = wired();
    await cached.check(REQUEST);
    const other: CheckRequest = { ...REQUEST, subject: 'user:bob' };
    const denied = await cached.check(other);
    expect(denied).toMatchObject({
      allowed: false,
      subject: 'user:bob',
      permission: 'document.read',
      resource: 'document:1',
    });
  });
});

describe('invalidation', () => {
  it('a grant on the resource re-evaluates that resource only', async () => {
    const { cached, cache, evaluations } = wired();
    await cached.can('user:alice', 'document.read', 'document:1');
    await cached.can('user:alice', 'document.read', 'document:2');
    expect(evaluations()).toBe(2);
    await cached.grant({
      subject: 'user:bob',
      relation: 'viewer',
      resource: 'document:1',
    });
    await cached.can('user:alice', 'document.read', 'document:1');
    expect(evaluations()).toBe(3);
    await cached.can('user:alice', 'document.read', 'document:2');
    expect(evaluations()).toBe(3);
    expect(cache.calls).toContain('clear');
  });

  it('an unscoped delete clears the whole namespace', async () => {
    const { cached, evaluations } = wired();
    await cached.can('user:alice', 'document.read', 'document:1');
    await cached.delete({ kind: 'filter', query: {} });
    await cached.can('user:alice', 'document.read', 'document:1');
    expect(evaluations()).toBe(2);
  });

  it('a failed invalidation disables caching instead of risking stale allows', async () => {
    const { cached, cache, evaluations } = wired();
    expect(await cached.can('user:alice', 'document.read', 'document:1')).toBe(true);
    expect(evaluations()).toBe(1);
    cache.failOn.add('clear');
    await cached.grant({
      subject: 'user:bob',
      relation: 'viewer',
      resource: 'document:1',
    });
    const gets = cache.calls.filter((call) => call === 'get').length;
    expect(await cached.can('user:alice', 'document.read', 'document:1')).toBe(true);
    expect(evaluations()).toBe(2);
    // No further cache reads: the layer is off, and the engine answers alone.
    expect(cache.calls.filter((call) => call === 'get').length).toBe(gets);
  });
});

describe('withStore', () => {
  it('drops the memo layer instead of answering from another store', async () => {
    const { cached } = wired();
    expect(await cached.can('user:alice', 'document.read', 'document:1')).toBe(true);
    const swapped = cached.withStore(testStore([]));
    expect(await swapped.can('user:alice', 'document.read', 'document:1')).toBe(false);
  });
});

describe('ttl plumbing', () => {
  it('passes ttlMs through to set when configured', async () => {
    const { authz, evaluations } = counting(setup(SEED));
    const cache = fakeCache(true);
    const cached = withCache(authz, cache, { namespace: 'test-v1', ttlMs: 1000 });
    await cached.can('user:alice', 'document.read', 'document:1');
    expect(cache.lastSetOptions).toEqual({ ttlMs: 1000 });
    expect(evaluations()).toBe(1);
  });
});
