import { CacheError } from './errors.js';

/**
 * The caching port.
 *
 * Where `TupleStore` is the durable record of grants, `Cache` is the fast,
 * losable layer in front of repeated questions — decision memoization, hot
 * working sets, per-request scratch. Anything in a cache may vanish at any
 * time without violating the contract; that is the whole difference between
 * the two ports, and the reason one backend can implement both.
 *
 * Values must be JSON-serializable. A backend that can hold richer values
 * (structured-cloneable, say) still accepts only what every backend accepts,
 * because a value written through one adapter has to be readable through
 * another. `undefined` is never a storable value — it is the miss signal —
 * so storing it is rejected rather than silently dropped.
 */
export interface CacheOptions {
  /** Milliseconds after which the entry expires. Requires `ttl` capability. */
  readonly ttlMs?: number;
}

export interface CacheCapabilities {
  /** Entries survive process exit. */
  readonly persistent: boolean;
  /** `set` honours `ttlMs`. */
  readonly ttl: boolean;
}

export interface Cache {
  readonly capabilities: CacheCapabilities;
  /** The stored value, or `undefined` on a miss or an expired entry. */
  get(key: string): Promise<unknown>;
  /**
   * Store a value, replacing any entry already under the key. Rejects
   * `undefined` values and `ttlMs` on backends without the `ttl` capability —
   * silently ignoring either would be a staleness bug wearing a success mask.
   */
  set(key: string, value: unknown, options?: CacheOptions): Promise<void>;
  /** Remove one entry. Removing a missing key is a no-op, never an error. */
  delete(key: string): Promise<void>;
  /**
   * Remove every entry whose key starts with `prefix`. An empty prefix clears
   * the whole namespace the instance was opened on — never anything outside
   * it; adapters scope every key they touch.
   */
  clear(prefix: string): Promise<void>;
}

/** Fail-loud argument checks, shared so every adapter rejects identically. */
export function assertCacheSet(
  key: string,
  value: unknown,
  ttlMs: number | undefined,
  ttl: boolean,
): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new CacheError('cache key must be a non-empty string');
  }
  if (value === undefined) {
    throw new CacheError(
      `cache refuses undefined for ${JSON.stringify(key)}: it is the miss signal`,
    );
  }
  if (ttlMs !== undefined && !ttl) {
    throw new CacheError(
      `cache backend has no ttl support, but ttlMs was passed for ${JSON.stringify(key)}`,
    );
  }
  if (ttlMs !== undefined && !(Number.isFinite(ttlMs) && ttlMs >= 0)) {
    throw new CacheError(
      `ttlMs must be a finite number >= 0, got ${JSON.stringify(ttlMs)}`,
    );
  }
}

/**
 * Deterministic JSON: same value, same string, regardless of key insertion
 * order. Object keys sort recursively; arrays keep their order; `undefined`,
 * functions, and symbols follow `JSON.stringify` (dropped from objects, `null`
 * in arrays) so hashing a context never throws on ordinary request data.
 *
 * Memo keys hash this, so two equal contexts must never stringify differently.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? 'null' : rendered;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(
        ([, entry]) =>
          entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol',
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return 'null';
}
