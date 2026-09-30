import type { Cache, CacheCapabilities, CacheOptions } from '@tsbouncer/tsbouncer';
import { assertCacheSet } from '@tsbouncer/tsbouncer';

export interface MemoryCacheOptions {
  /** Seed entries. Keys must be non-empty, values must not be `undefined`. */
  readonly entries?: readonly (readonly [string, unknown])[];
}

const CAPABILITIES: CacheCapabilities = Object.freeze({
  persistent: false,
  ttl: true,
});

interface Entry {
  readonly value: unknown;
  /** Epoch milliseconds at which the entry expires, if ever. */
  readonly expiresAt?: number;
}

/**
 * Process-local cache. Nothing is persisted and nothing is shared — the same
 * properties that make `memoryStore` the right store for tests make this the
 * right cache for them, and for single-process applications that want memo
 * decisions without a server.
 *
 * Values are deep-cloned on the way in and on the way out, so a caller
 * mutating an object it passed (or received) can never corrupt what a later
 * `get` returns. Expiry is lazy: entries are checked on `get`, never swept by
 * a timer, so an idle cache holds no handles and never keeps a process alive.
 */
export function memoryCache(options: MemoryCacheOptions = {}): Cache {
  const entries = new Map<string, Entry>();

  for (const [key, value] of options.entries ?? []) {
    assertCacheSet(key, value, undefined, true);
    entries.set(key, { value: structuredClone(value) });
  }

  function expired(entry: Entry): boolean {
    return entry.expiresAt !== undefined && Date.now() >= entry.expiresAt;
  }

  async function get(key: string): Promise<unknown> {
    const entry = entries.get(key);
    if (entry === undefined || expired(entry)) {
      if (entry !== undefined) entries.delete(key);
      return undefined;
    }
    return structuredClone(entry.value);
  }

  async function set(
    key: string,
    value: unknown,
    setOptions?: CacheOptions,
  ): Promise<void> {
    const ttlMs = setOptions?.ttlMs;
    assertCacheSet(key, value, ttlMs, true);
    entries.set(
      key,
      ttlMs === undefined
        ? { value: structuredClone(value) }
        : { value: structuredClone(value), expiresAt: Date.now() + ttlMs },
    );
  }

  async function remove(key: string): Promise<void> {
    entries.delete(key);
  }

  async function clear(prefix: string): Promise<void> {
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) entries.delete(key);
    }
  }

  return Object.freeze({ capabilities: CAPABILITIES, get, set, delete: remove, clear });
}
