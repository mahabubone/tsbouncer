import { describe, expect, it } from 'vitest';
import {
  concreteRefs,
  difference,
  differenceAll,
  emptySet,
  intersection,
  intersectionAll,
  isEmpty,
  isExhaustive,
  set,
  setOfType,
  union,
  unionAll,
} from '../src/index.js';

const alice = 'user:alice';
const bob = 'user:bob';
const eng = 'team:eng#member';

describe('construction', () => {
  it('sorts and de-duplicates members', () => {
    expect(set([bob, alice, bob]).members).toEqual([alice, bob]);
  });

  it('does not list a member already covered by a symbolic type', () => {
    // `allOfTypes` already implies every user, so repeating alice is noise.
    const value = setOfType('user');
    expect(union(value, set([alice])).members).toEqual([]);
  });

  it('keeps a member of a type that is not covered', () => {
    expect(union(setOfType('user'), set([eng])).members).toEqual([eng]);
  });

  it('reports emptiness and exhaustiveness', () => {
    expect(isEmpty(emptySet())).toBe(true);
    expect(isEmpty(set([alice]))).toBe(false);
    expect(isEmpty(setOfType('user'))).toBe(false);
    expect(isExhaustive(set([alice]))).toBe(true);
    expect(isExhaustive(set([alice], true))).toBe(false);
    expect(isExhaustive(setOfType('user'))).toBe(false);
  });
});

describe('union', () => {
  it('adds members from both sides', () => {
    expect(union(set([alice]), set([bob])).members).toEqual([alice, bob]);
  });

  it('unions symbolic types', () => {
    expect(union(setOfType('user'), setOfType('team')).allOfTypes).toEqual([
      'team',
      'user',
    ]);
  });

  it('folds a list into a sorted result', () => {
    // Sorted, so two runs over the same data produce byte-identical output.
    expect(unionAll([set([alice]), set([bob]), set([eng])]).members).toEqual([
      eng,
      alice,
      bob,
    ]);
  });

  it('propagates truncation', () => {
    expect(unionAll([set([alice], true), set([bob])]).truncated).toBe(true);
  });
});

describe('intersection', () => {
  it('keeps members present on both sides', () => {
    expect(intersection(set([alice, bob]), set([bob, eng])).members).toEqual([bob]);
  });

  it('is empty for disjoint concrete sets', () => {
    expect(isEmpty(intersection(set([alice]), set([bob])))).toBe(true);
  });

  // This is the case that makes `(user | team#member) and editor` computable
  // rather than a dead end: the symbolic side is universal, so the concrete side
  // is the whole answer.
  it('narrows a symbolic side to a concrete set', () => {
    const result = intersection(setOfType('user'), set([alice, eng]));
    expect(result.members).toEqual([alice]);
    expect(result.allOfTypes).toEqual([]);
  });

  it('narrows a concrete set by a symbolic side', () => {
    expect(intersection(set([alice, eng]), setOfType('user')).members).toEqual([alice]);
  });

  it('keeps a shared symbolic type', () => {
    const result = intersection(setOfType('user'), setOfType('user'));
    expect(result.allOfTypes).toEqual(['user']);
  });

  it('is empty when the symbolic types differ', () => {
    expect(isEmpty(intersection(setOfType('user'), setOfType('team')))).toBe(true);
  });

  it('folds a list and treats an empty list as the empty set', () => {
    expect(
      intersectionAll([set([alice, bob]), set([bob]), set([bob, eng])]).members,
    ).toEqual([bob]);
    expect(isEmpty(intersectionAll([]))).toBe(true);
  });

  it('carries either side exclusions forward', () => {
    const base = { ...set([alice, bob]), excluded: ['user:mallory'] };
    expect(intersection(base, set([alice])).excluded).toEqual(['user:mallory']);
  });
});

describe('difference', () => {
  it('removes members present in the subtrahend', () => {
    expect(difference(set([alice, bob]), set([bob])).members).toEqual([alice]);
  });

  it('records what it removed', () => {
    expect(difference(set([alice, bob]), set([bob])).excluded).toEqual([bob]);
  });

  it('is a no-op against a disjoint set', () => {
    const result = difference(set([alice]), set([bob]));
    expect(result.members).toEqual([alice]);
    expect(result.excluded).toEqual([bob]);
  });

  // `write = (owner and editor) except banned` with a wildcard owner edge is
  // genuinely "every user except the banned ones". That is not a list, and the
  // point of keeping `allOfTypes` is that it stays representable.
  it('keeps a symbolic base symbolic when something is subtracted', () => {
    const result = difference(setOfType('user'), set([alice]));
    expect(result.allOfTypes).toEqual(['user']);
    expect(result.excluded).toEqual([alice]);
    expect(isExhaustive(result)).toBe(false);
  });

  it('drops a type the subtrahend covers', () => {
    expect(difference(setOfType('user'), setOfType('user')).allOfTypes).toEqual([]);
  });

  it('keeps a type the subtrahend does not cover', () => {
    expect(difference(setOfType('user'), setOfType('team')).allOfTypes).toEqual(['user']);
  });

  it('removes members of a covered type', () => {
    const result = difference(set([alice, eng]), setOfType('user'));
    expect(result.members).toEqual([eng]);
  });
});

describe('differenceAll and concreteRefs', () => {
  it('subtracts a list from a base', () => {
    const base = set(['user:alice', 'user:bob', 'user:carol']);
    const result = differenceAll(base, [set(['user:bob']), set(['user:carol'])]);
    expect(concreteRefs(result)).toEqual(['user:alice']);
  });

  it('leaves the base alone for an empty list', () => {
    expect(concreteRefs(differenceAll(set(['user:alice']), []))).toEqual(['user:alice']);
  });
});

describe('subject-set union', () => {
  it('carries the excluded list from whichever side has one', () => {
    const plain = set(['user:alice']);
    const guarded = { ...setOfType('user'), excluded: ['team:eng#member'] };
    // Both orders must keep the exclusion: dropping it would read as "everyone"
    // where the truth is "everyone except that team".
    expect(union(plain, guarded).excluded).toEqual(['team:eng#member']);
    expect(union(guarded, plain).excluded).toEqual(['team:eng#member']);
  });

  it('propagates truncation from either side', () => {
    const cut = { ...set(['user:alice']), truncated: true };
    expect(union(cut, set(['user:bob'])).truncated).toBe(true);
    expect(union(set(['user:bob']), cut).truncated).toBe(true);
    expect(union(set(['user:alice']), set(['user:bob'])).truncated).toBe(false);
  });

  it('keeps both sides of a type union', () => {
    const result = union(setOfType('user'), setOfType('team'));
    expect([...result.allOfTypes].sort()).toEqual(['team', 'user']);
    expect(result.members).toEqual([]);
  });

  it('keeps bare references that carry no type prefix', () => {
    // A reference with no colon has no type to match a wildcard against, so it
    // is carried through as an ordinary member instead of being dropped.
    const result = union(set(['alice']), set(['bob']));
    expect(result.members).toEqual(['alice', 'bob']);
    expect(result.allOfTypes).toEqual([]);
  });
});
