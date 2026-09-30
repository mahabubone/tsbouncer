import type { Cache, CacheCapabilities, CacheOptions } from '@tsbouncer/tsbouncer';
import { assertCacheSet, CacheError } from '@tsbouncer/tsbouncer';
import type { RedisClientType } from 'redis';

export interface RedisCacheOptions {
  /** Key namespace. Defaults to `tsbouncer`. Isolate tests with a uuid. */
  readonly prefix?: string;
}

const CAPABILITIES: CacheCapabilities = Object.freeze({
  persistent: true,
  ttl: true,
});

/** Escape Redis glob metacharacters so user keys never act as patterns. */
function escapeGlob(value: string): string {
  return value.replace(/([[*\]?\\])/g, '\\$1');
}

/**
 * A `Cache` over an application-owned Redis client — the same client shape as
 * `redisStore`, and deliberately so: one connection serves both ports, and a
 * deployment that wants hot decisions and durable grants out of one server
 * gets exactly that.
 *
 * Values are JSON strings under `${prefix}:c:${key}`. TTLs ride `PX`, so
 * expiry is enforced server-side rather than hoped for. `clear` pages a
 * `SCAN` and deletes in place; glob characters in keys are escaped first, so
 * a key containing `*` clears itself and nothing else.
 *
 * An entry that no longer parses is a miss, not an error: cache contents are
 * losable by definition, and the memo layer above already treats misses and
 * corrupt entries identically.
 */
export function redisCache(
  client: RedisClientType,
  options: RedisCacheOptions = {},
): Cache {
  const prefix = options.prefix ?? 'tsbouncer';
  const at = (key: string): string => `${prefix}:c:${key}`;

  async function ensureConnected(): Promise<void> {
    if (client.isOpen) return;
    try {
      await client.connect();
    } catch (cause) {
      throw new CacheError(
        `could not connect to Redis: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }

  function failure(operation: string, cause: unknown): Error {
    if (cause instanceof CacheError) return cause;
    return new CacheError(
      `Redis cache ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  async function get(key: string): Promise<unknown> {
    await ensureConnected();
    let raw: string | null;
    try {
      raw = await client.get(at(key));
    } catch (cause) {
      throw failure('get', cause);
    }
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  async function set(
    key: string,
    value: unknown,
    setOptions?: CacheOptions,
  ): Promise<void> {
    const ttlMs = setOptions?.ttlMs;
    assertCacheSet(key, value, ttlMs, true);
    await ensureConnected();
    try {
      if (ttlMs === undefined) {
        await client.set(at(key), JSON.stringify(value));
      } else if (ttlMs <= 0) {
        // Redis rejects PX 0, and the semantics are "already expired" anyway:
        // leave the key absent rather than writing something already dead.
        await client.del(at(key));
      } else {
        await client.set(at(key), JSON.stringify(value), { PX: Math.floor(ttlMs) });
      }
    } catch (cause) {
      throw failure('set', cause);
    }
  }

  async function remove(key: string): Promise<void> {
    await ensureConnected();
    try {
      await client.del(at(key));
    } catch (cause) {
      throw failure('delete', cause);
    }
  }

  async function clear(clearPrefix: string): Promise<void> {
    await ensureConnected();
    try {
      const match = `${prefix}:c:${escapeGlob(clearPrefix)}*`;
      for await (const keys of client.scanIterator({ MATCH: match, COUNT: 500 })) {
        if (keys.length > 0) await client.del(keys);
      }
    } catch (cause) {
      throw failure('clear', cause);
    }
  }

  return Object.freeze({ capabilities: CAPABILITIES, get, set, delete: remove, clear });
}
