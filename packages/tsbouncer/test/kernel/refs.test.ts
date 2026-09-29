import { describe, expect, it } from 'vitest';
import { InvalidReferenceError } from '../../src/kernel/errors.js';
import {
  formatPermission,
  formatRef,
  isWildcard,
  parsePermission,
  parseRef,
  refKey,
  tryParseRef,
} from '../../src/kernel/refs.js';

describe('parseRef', () => {
  it('parses a direct reference', () => {
    expect(parseRef('user:alice')).toEqual({
      type: 'user',
      id: 'alice',
      relation: undefined,
    });
  });

  it('parses a userset reference', () => {
    expect(parseRef('team:engineering#member')).toEqual({
      type: 'team',
      id: 'engineering',
      relation: 'member',
    });
  });

  it('parses a wildcard subject', () => {
    expect(parseRef('user:*')).toEqual({ type: 'user', id: '*', relation: undefined });
  });

  it('treats colons after the first as part of the id', () => {
    expect(parseRef('org:acme_doc:123')).toEqual({
      type: 'org',
      id: 'acme_doc:123',
      relation: undefined,
    });
  });

  it('combines a colon-bearing id with a relation', () => {
    expect(parseRef('org:acme:doc:9#viewer')).toEqual({
      type: 'org',
      id: 'acme:doc:9',
      relation: 'viewer',
    });
  });

  it.each([
    ['', 'empty'],
    ['alice', 'missing separator'],
    [':alice', 'missing type'],
    ['user:', 'missing id'],
    ['User:alice', 'uppercase type'],
    ['1user:alice', 'type starting with a digit'],
    ['user: alice', 'leading whitespace in id'],
    ['user:alice ', 'trailing whitespace in id'],
    ['user:a#b#c', 'two separators'],
    ['user:a#Bad', 'uppercase relation'],
    ['user:a#', 'empty relation'],
  ])('rejects %s (%s)', (input) => {
    expect(() => parseRef(input)).toThrow(InvalidReferenceError);
  });

  it('rejects control characters in an id', () => {
    expect(() => parseRef('user:a\u0000b')).toThrow(InvalidReferenceError);
    expect(() => parseRef('user:a\nb')).toThrow(InvalidReferenceError);
  });

  it('rejects a relation on a resource', () => {
    expect(() => parseRef('document:1#viewer', 'object')).toThrow(InvalidReferenceError);
  });

  it('rejects a relation on a wildcard subject', () => {
    expect(() => parseRef('user:*#viewer', 'subject')).toThrow(InvalidReferenceError);
  });

  it('allows a wildcard as a resource only in the any position', () => {
    expect(parseRef('user:*').id).toBe('*');
  });

  it('reports the offending input in error details', () => {
    try {
      parseRef('nope');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidReferenceError);
      expect((error as InvalidReferenceError).code).toBe('invalid_reference');
      expect((error as InvalidReferenceError).details).toMatchObject({ input: 'nope' });
    }
  });

  it('guards against non-string input from untyped callers', () => {
    for (const value of [undefined, null, 42, {}, ['user:alice']]) {
      expect(() => parseRef(value as unknown as string)).toThrow(InvalidReferenceError);
    }
  });
});

describe('tryParseRef', () => {
  it('returns undefined instead of throwing', () => {
    expect(tryParseRef('user:alice')).toBeDefined();
    expect(tryParseRef('garbage')).toBeUndefined();
  });
});

describe('formatRef', () => {
  it('round-trips every reference form', () => {
    for (const input of [
      'user:alice',
      'team:eng#member',
      'user:*',
      'org:acme:doc:9#viewer',
    ]) {
      expect(formatRef(parseRef(input))).toBe(input);
    }
  });
});

describe('refKey', () => {
  it('is stable across equivalent inputs', () => {
    expect(refKey('user:alice')).toBe(refKey(parseRef('user:alice')));
  });
});

describe('isWildcard', () => {
  it('detects wildcards in both string and parsed form', () => {
    expect(isWildcard('user:*')).toBe(true);
    expect(isWildcard(parseRef('user:*'))).toBe(true);
    expect(isWildcard('user:alice')).toBe(false);
    expect(isWildcard('user:*x')).toBe(false);
  });
});

describe('parsePermission', () => {
  it('splits type and permission', () => {
    expect(parsePermission('document.read')).toEqual({
      type: 'document',
      permission: 'read',
    });
  });

  it('round-trips', () => {
    expect(formatPermission('document', 'read')).toBe('document.read');
  });

  it.each([
    ['documentread', 'missing separator'],
    ['Doc.read', 'uppercase type'],
    ['document.', 'empty permission'],
  ])('rejects %s (%s)', (input) => {
    expect(() => parsePermission(input)).toThrow(InvalidReferenceError);
  });

  it('keeps permissions distinct from subject relations', () => {
    expect(() => parsePermission('document#read')).toThrow(InvalidReferenceError);
  });
});

describe('parseRef', () => {
  it('rejects a malformed reference rather than guessing', () => {
    expect(() => parseRef('nope')).toThrow(/missing ':'/);
    expect(() => parseRef('user:')).toThrow();
    expect(() => parseRef('User:alice')).toThrow(/invalid type/);
    expect(() => parseRef('team:eng#a#b')).toThrow(/more than one '#'/);
  });

  it('reads the three reference positions', () => {
    // A wildcard is an id, not a separate flag: `user:*` is the one id that
    // stands for a class rather than a thing.
    expect(parseRef('user:alice')).toEqual({ type: 'user', id: 'alice' });
    expect(parseRef('team:eng#member')).toEqual({
      type: 'team',
      id: 'eng',
      relation: 'member',
    });
    expect(parseRef('user:*')).toEqual({ type: 'user', id: '*' });
  });
});
