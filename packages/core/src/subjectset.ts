/**
 * A set of subjects, which is often not finitely enumerable.
 *
 * `user:*` grants read on a document to every user that will ever exist, so the
 * answer to "who can read this?" is not a list — it is a rule. Collapsing that
 * into a finite list would either be wrong or, worse, silently truncated.
 *
 * So a set is a small algebra rather than an array:
 *
 *   allOfTypes  every subject of these types, including ones not yet created
 *   members     concrete references, e.g. `user:alice`, `team:eng#member`
 *   excluded    references removed from the whole set
 *   truncated   a budget stopped the walk, so the answer is a lower bound
 *
 * `truncated` matters more than it looks: a partial answer is only useful if the
 * caller knows it is partial, and returning one without saying so would be a lie
 * that looks like a result.
 */
export interface SubjectSet {
  readonly allOfTypes: readonly string[];
  readonly members: readonly string[];
  readonly excluded: readonly string[];
  readonly truncated: boolean;
}

export function emptySet(truncated = false): SubjectSet {
  return Object.freeze({ allOfTypes: [], members: [], excluded: [], truncated });
}

function build(
  allOfTypes: readonly string[],
  members: readonly string[],
  excluded: readonly string[],
  truncated: boolean,
): SubjectSet {
  // A reference covered by a symbolic type is already implied; keeping both just
  // makes the result noisier to read and slower to compare.
  const concrete = members.filter((m) => !coveredBy(m, allOfTypes));
  return Object.freeze({
    allOfTypes: Object.freeze([...new Set(allOfTypes)].sort()),
    members: Object.freeze([...new Set(concrete)].sort()),
    excluded: Object.freeze([...new Set(excluded)].sort()),
    truncated,
  });
}

export function set(members: readonly string[], truncated = false): SubjectSet {
  return build([], members, [], truncated);
}

export function setOfType(type: string, truncated = false): SubjectSet {
  return build([type], [], [], truncated);
}

function typeOf(ref: string): string {
  const colon = ref.indexOf(':');
  return colon < 0 ? ref : ref.slice(0, colon);
}

function coveredBy(ref: string, allOfTypes: readonly string[]): boolean {
  const type = typeOf(ref);
  return allOfTypes.includes(type);
}

/**
 * `a ∪ b`.
 *
 * The `excluded` lists are **not** combined: `(A \ E1) ∪ (A \ E2)` is neither
 * `A \ (E1 ∪ E2)` nor `A \ (E1 ∩ E2)`, and a union of two exclusions is rare
 * enough that guessing would be worse than dropping the distinction. The excluded
 * list is therefore only carried through when one side is trivially empty, and
 * callers that need exactness should check `truncated` and the exclusion list
 * rather than trust a flattened union.
 */
export function union(a: SubjectSet, b: SubjectSet): SubjectSet {
  return build(
    [...a.allOfTypes, ...b.allOfTypes],
    [...a.members, ...b.members],
    a.excluded.length > 0 ? a.excluded : b.excluded,
    a.truncated || b.truncated,
  );
}

export function unionAll(sets: readonly SubjectSet[]): SubjectSet {
  return sets.reduce(union, emptySet());
}

/**
 * `a ∩ b`.
 *
 * A member can come from either side, which is the whole trick: "every user"
 * intersected with `{alice, team:eng#member}` is `{alice}`, not empty. Alice is
 * in the result because she is concrete in `b` and covered by `a`'s symbolic
 * type, and `team:eng#member` is not in it because `team` is not covered.
 *
 * That is what makes `(user | team#member) and editor` computable instead of a
 * dead end — the most common shape in a real model.
 */
export function intersection(a: SubjectSet, b: SubjectSet): SubjectSet {
  // A whole type survives only if both sides cover it. A finite member list can
  // never cover a type, so it never contributes one.
  const sharedTypes = a.allOfTypes.filter((t) => b.allOfTypes.includes(t));

  const fromA = a.members.filter(
    (m) => b.members.includes(m) || coveredBy(m, b.allOfTypes),
  );
  const fromB = b.members.filter(
    (m) => a.members.includes(m) || coveredBy(m, a.allOfTypes),
  );

  return build(
    sharedTypes,
    [...fromA, ...fromB],
    // The result is a subset of both, so either side's exclusions still apply.
    [...a.excluded, ...b.excluded],
    a.truncated || b.truncated,
  );
}

export function intersectionAll(sets: readonly SubjectSet[]): SubjectSet {
  if (sets.length === 0) return emptySet();
  return sets.reduce(intersection);
}

/**
 * `a \ b`.
 *
 * When the base is concrete this is an exact difference. When the base is
 * symbolic the answer is "every user except these", which cannot be enumerated —
 * so it stays a symbolic set carrying an exclusion list, and the caller sees
 * `allOfTypes` non-empty and knows it is not an exhaustive list.
 */
export function difference(a: SubjectSet, b: SubjectSet): SubjectSet {
  // A whole type survives unless the subtraction covers it. A finite member list
  // can never cover a type, so it never removes one.
  const survivingTypes = a.allOfTypes.filter((t) => !b.allOfTypes.includes(t));

  const removed = new Set([...a.excluded, ...b.members, ...b.excluded]);
  // A member is also removed when the subtrahend covers its *type*: "every user"
  // minus alice leaves no alice, even though alice was never named in `b`.
  const members = a.members.filter((m) => !removed.has(m) && !coveredBy(m, b.allOfTypes));

  return build(survivingTypes, members, [...removed], a.truncated || b.truncated);
}

export function differenceAll(base: SubjectSet, sets: readonly SubjectSet[]): SubjectSet {
  return sets.reduce(difference, base);
}

/** Every concrete reference, which is all a set ever holds exhaustively. */
export function concreteRefs(value: SubjectSet): readonly string[] {
  return value.members;
}

export function isEmpty(value: SubjectSet): boolean {
  return value.allOfTypes.length === 0 && value.members.length === 0;
}

/**
 * Whether the set can be printed as a plain list.
 *
 * A truncated set is a lower bound, a set with exclusions is "everyone except",
 * and a symbolic set is every subject of a type. All three are answers; none of
 * them is a list. A caller rendering "who can see this" should say so rather
 * than print something that looks complete and is not.
 */
export function isExhaustive(value: SubjectSet): boolean {
  return !value.truncated && value.excluded.length === 0 && value.allOfTypes.length === 0;
}
