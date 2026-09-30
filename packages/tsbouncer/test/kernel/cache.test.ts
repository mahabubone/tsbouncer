import { describe, expect, it } from 'vitest';
import { assertCacheSet, CacheError, canonicalJson } from '../../src/kernel/index.js';

describe('canonicalJson', () => {
  it('is insensitive to key insertion order, at any depth', () => {
    const a = { user: 'alice', ctx: { region: 'eu', tier: 'pro' } };
    const b = { ctx: { tier: 'pro', region: 'eu' }, user: 'alice' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('keeps array order, because order is meaning there', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('treats undefined like JSON.stringify does, deterministically', () => {
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe('[null]');
  });

  it('renders primitives exactly as JSON does', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(null)).toBe('null');
  });
});

describe('assertCacheSet', () => {
  it('passes a well-formed write silently', () => {
    expect(() => assertCacheSet('k', { allowed: true }, undefined, true)).not.toThrow();
    expect(() => assertCacheSet('k', { allowed: true }, 1000, true)).not.toThrow();
  });

  it('rejects an empty key', () => {
    expect(() => assertCacheSet('', true, undefined, true)).toThrow(CacheError);
  });

  it('rejects undefined, which is the miss signal', () => {
    expect(() => assertCacheSet('k', undefined, undefined, true)).toThrow(CacheError);
  });

  it('rejects a ttl the backend cannot honour', () => {
    expect(() => assertCacheSet('k', true, 1000, false)).toThrow(CacheError);
  });

  it('rejects a ttl that is not a usable duration', () => {
    for (const ttlMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => assertCacheSet('k', true, ttlMs, true)).toThrow(CacheError);
    }
    expect(() => assertCacheSet('k', true, 0, true)).not.toThrow();
  });
});
