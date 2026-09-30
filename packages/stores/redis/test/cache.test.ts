import type { RedisClientType } from 'redis';
import { CacheError } from 'tsbouncer';
import { describe, expect, it } from 'vitest';
import { redisCache } from '../src/index.js';

/**
 * A command-level double: no Lua, no socket, just the five commands the cache
 * uses, with glob matching honest enough to prove escaping. Pattern segments
 * split on unescaped `*`; a backslash quotes the next character, exactly as
 * Redis MATCH does.
 */
function commandFake(state?: Map<string, string>, log: string[] = []) {
  const strings = state ?? new Map<string, string>();
  const match = (pattern: string, key: string): boolean => {
    const segments: string[] = [];
    let current = '';
    for (let i = 0; i < pattern.length; i += 1) {
      const char = pattern[i] as string;
      if (char === '\\' && i + 1 < pattern.length) {
        current += pattern[i + 1] as string;
        i += 1;
      } else if (char === '*') {
        segments.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    segments.push(current);
    if (segments.length === 1) return key === (segments[0] as string);
    let rest = key;
    for (const [at, segment] of segments.entries()) {
      if (at === 0) {
        if (!rest.startsWith(segment)) return false;
        rest = rest.slice(segment.length);
      } else if (at === segments.length - 1) {
        if (!rest.endsWith(segment)) return false;
      } else {
        const found = rest.indexOf(segment);
        if (found < 0) return false;
        rest = rest.slice(found + segment.length);
      }
    }
    return true;
  };
  const fake = {
    isOpen: true,
    async connect() {},
    destroy() {},
    async get(key: string): Promise<string | null> {
      log.push(`GET ${key}`);
      return strings.get(key) ?? null;
    },
    async set(key: string, value: string, options?: { PX?: number }): Promise<string> {
      log.push(
        `SET ${key} ${value}${options?.PX === undefined ? '' : ` PX ${String(options.PX)}`}`,
      );
      strings.set(key, value);
      return 'OK';
    },
    async del(keys: string | string[]): Promise<number> {
      const list = Array.isArray(keys) ? keys : [keys];
      log.push(`DEL ${list.join(' ')}`);
      let removed = 0;
      for (const key of list) {
        if (strings.delete(key)) removed += 1;
      }
      return removed;
    },
    async *scanIterator(options?: {
      MATCH?: string;
    }): AsyncGenerator<string[], void, void> {
      const pattern = options?.MATCH ?? '*';
      log.push(`SCAN ${pattern}`);
      const matched = [...strings.keys()].filter((key) => match(pattern, key));
      if (matched.length > 0) yield matched;
    },
  } as unknown as RedisClientType;
  return { fake, state: strings, log };
}

describe('redisCache', () => {
  it('round-trips JSON values', async () => {
    const { fake } = commandFake();
    const cache = redisCache(fake);
    await cache.set('k', { allowed: true, tags: ['a'] });
    expect(await cache.get('k')).toEqual({ allowed: true, tags: ['a'] });
  });

  it('answers undefined for a missing key', async () => {
    const { fake } = commandFake();
    expect(await redisCache(fake).get('ghost')).toBeUndefined();
  });

  it('treats an unparseable entry as a miss', async () => {
    const { fake } = commandFake(new Map([['tsbouncer:c:rot', '{not json']]));
    expect(await redisCache(fake).get('rot')).toBeUndefined();
  });

  it('sends PX only when a ttl is given', async () => {
    const { fake, log } = commandFake();
    const cache = redisCache(fake);
    await cache.set('a', 1);
    await cache.set('b', 2, { ttlMs: 1500 });
    expect(log).toEqual(['SET tsbouncer:c:a 1', 'SET tsbouncer:c:b 2 PX 1500']);
  });

  it('leaves a zero-ttl key absent', async () => {
    const { fake, state } = commandFake();
    const cache = redisCache(fake);
    await cache.set('k', 1, { ttlMs: 0 });
    expect(state.has('tsbouncer:c:k')).toBe(false);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('rejects undefined values and empty keys without I/O', async () => {
    const { fake, log } = commandFake();
    const cache = redisCache(fake);
    await expect(cache.set('k', undefined)).rejects.toThrow(CacheError);
    await expect(cache.set('', 1)).rejects.toThrow(CacheError);
    expect(log).toEqual([]);
  });

  it('escapes glob characters when clearing, so a star clears itself', async () => {
    const { fake, log } = commandFake(
      new Map([
        ['tsbouncer:c:a*b', '1'],
        ['tsbouncer:c:ab', '2'],
      ]),
    );
    const cache = redisCache(fake);
    await cache.clear('a*');
    expect(log[0]).toBe('SCAN tsbouncer:c:a\\**');
    expect(await cache.get('a*b')).toBeUndefined();
    expect(await cache.get('ab')).toBe(2);
  });

  it('clears everything on an empty prefix', async () => {
    const { fake } = commandFake(
      new Map([
        ['tsbouncer:c:a', '1'],
        ['tsbouncer:c:b', '2'],
      ]),
    );
    const cache = redisCache(fake);
    await cache.clear('');
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeUndefined();
  });

  it('deletes one key and ignores a missing one', async () => {
    const { fake } = commandFake(new Map([['tsbouncer:c:k', '1']]));
    const cache = redisCache(fake);
    await cache.delete('k');
    await cache.delete('ghost');
    expect(await cache.get('k')).toBeUndefined();
  });

  it('wraps connection failures in CacheError', async () => {
    const fake = {
      isOpen: false,
      async connect(): Promise<void> {
        throw new Error('refused');
      },
      destroy() {},
    } as unknown as RedisClientType;
    await expect(redisCache(fake).get('k')).rejects.toThrow(CacheError);
  });
});
