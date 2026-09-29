import { describe, expect, it } from 'vitest';
import {
  assertStoreShape,
  duplicateTupleMessage,
  matchesQuery,
  NO_CAPABILITIES,
  type Tuple,
  tupleKey,
} from '../../src/kernel/store.js';

const TUPLE: Tuple = {
  subject: 'user:alice',
  relation: 'viewer',
  resource: 'document:1',
};

describe('tupleKey', () => {
  it('builds a stable key from the edge', () => {
    expect(tupleKey(TUPLE)).toBe('["user:alice","viewer","document:1",""]');
  });

  it('does not confuse separators inside ids with field boundaries', () => {
    const a = tupleKey({ subject: 'user:a', relation: 'b|c', resource: 'd:e' });
    const b = tupleKey({ subject: 'user:a|b', relation: 'c', resource: 'd:e' });
    expect(a).not.toBe(b);
  });

  it('includes the condition, so a conditioned edge is a different edge', () => {
    const plain = tupleKey(TUPLE);
    const conditioned = tupleKey({ ...TUPLE, condition: 'inRegion' });
    expect(conditioned).not.toBe(plain);
  });

  it('ignores context, so re-binding the same condition replaces the tuple', () => {
    expect(tupleKey({ ...TUPLE, condition: 'c', context: { a: 1 } })).toBe(
      tupleKey({ ...TUPLE, condition: 'c', context: { b: 2 } }),
    );
  });

  it('distinguishes different edges', () => {
    expect(tupleKey(TUPLE)).not.toBe(tupleKey({ ...TUPLE, relation: 'editor' }));
    expect(tupleKey(TUPLE)).not.toBe(tupleKey({ ...TUPLE, resource: 'document:2' }));
  });
});

describe('duplicateTupleMessage', () => {
  it('names the edge for a plain duplicate', () => {
    expect(duplicateTupleMessage(TUPLE)).toBe(
      'write rejected by a unique constraint — user:alice#viewer@document:1 already exists',
    );
  });

  it('names the one-param-set rule for a re-binding', () => {
    const message = duplicateTupleMessage({
      ...TUPLE,
      condition: 'inRegion',
      context: { region: 'us' },
    });
    expect(message).toMatch(/with condition "inRegion" already holds a binding/);
    expect(message).toMatch(/one param-set per condition/);
    expect(message).toMatch(/mode 'upsert'/);
  });
});

describe('matchesQuery', () => {
  it('matches everything when the query is empty', () => {
    expect(matchesQuery(TUPLE, {})).toBe(true);
  });

  it('matches a single string filter exactly', () => {
    expect(matchesQuery(TUPLE, { subject: 'user:alice' })).toBe(true);
    expect(matchesQuery(TUPLE, { subject: 'user:bob' })).toBe(false);
  });

  it('matches any value in an array filter', () => {
    expect(matchesQuery(TUPLE, { subject: ['user:bob', 'user:alice'] })).toBe(true);
    expect(matchesQuery(TUPLE, { subject: ['user:bob'] })).toBe(false);
  });

  it('conjoins multiple filters', () => {
    expect(matchesQuery(TUPLE, { subject: 'user:alice', relation: 'editor' })).toBe(
      false,
    );
  });

  it('treats a wildcard as a literal, never a pattern', () => {
    const star: Tuple = { subject: 'user:*', relation: 'viewer', resource: 'document:1' };
    expect(matchesQuery(star, { subject: 'user:alice' })).toBe(false);
    expect(matchesQuery(star, { subject: 'user:*' })).toBe(true);
  });

  it('ignores pagination fields', () => {
    expect(matchesQuery(TUPLE, { limit: 10, cursor: 'x' })).toBe(true);
  });
});

describe('assertStoreShape', () => {
  const complete = {
    capabilities: {},
    read: () => {},
    write: () => {},
    delete: () => {},
  };

  it('accepts a complete store', () => {
    expect(() => assertStoreShape(complete)).not.toThrow();
  });

  it.each(['read', 'write', 'delete'] as const)(
    'rejects a store missing %s',
    (method) => {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[method];
      expect(() => assertStoreShape(partial)).toThrow(new RegExp(method));
    },
  );

  it('rejects a store without capabilities', () => {
    const partial: Record<string, unknown> = { ...complete };
    delete partial.capabilities;
    expect(() => assertStoreShape(partial)).toThrow(/capabilities/);
  });

  it.each([null, undefined, 42, 'store'])('rejects the non-object %s', (value) => {
    expect(() => assertStoreShape(value)).toThrow(TypeError);
  });
});

describe('NO_CAPABILITIES', () => {
  it('declares every capability as false and is frozen', () => {
    expect(Object.values(NO_CAPABILITIES).every((v) => v === false)).toBe(true);
    expect(Object.isFrozen(NO_CAPABILITIES)).toBe(true);
  });
});
