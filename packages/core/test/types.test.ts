import { describe, expect, it } from 'vitest';
import type {
  ModelShapeOf,
  ObjectRefOf,
  PermissionOf,
  SubjectRefOf,
  TypeNames,
} from '../src/index.js';
import { defineModel, defineType, permission, relation } from '../src/index.js';

/**
 * The type-level derivations are the whole "pragmatic typing" story, and no
 * runtime assertion can catch their regression — a model that still *works* can
 * still derive `` `${string}.${string}` `` instead of literal names.
 *
 * Three things have to hold, and each has been broken:
 *
 *  1. `defineType` must preserve the literal config it was handed, or the
 *     permission names are gone before anything derives from them.
 *  2. A type that declares *no* permissions must derive `never`, not a string
 *     index — otherwise "this type has no permissions" reads as "any permission".
 *  3. The shape must be reachable without intersecting it into `Model['types']`,
 *     which would break AST access.
 *
 * `tsc --noEmit` covers `test/**`, so the `@ts-expect-error` lines below are real
 * assertions: remove a derivation and this file stops building.
 */

const model = defineModel({
  types: {
    user: defineType({}),
    team: defineType({ relations: { member: relation(['user']) } }),
    document: defineType({
      relations: { owner: relation(['user']) },
      permissions: { read: permission.or('owner'), write: permission.or('owner') },
    }),
  },
});

type Shape = ModelShapeOf<typeof model>;

/**
 * Mutual assignability rather than the `<T>() => T extends A ? 1 : 2` identity
 * trick: for template-literal unions TypeScript normalises the same set of
 * members into different unions, and the identity check calls those unequal.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

type _Names = Assert<Same<TypeNames<Shape>, 'user' | 'team' | 'document'>>;

// No `user.*` and no `team.*`: neither declares a permission, so each must
// contribute `never` rather than an index signature.
type _Permissions = Assert<Same<PermissionOf<Shape>, 'document.read' | 'document.write'>>;

type _Objects = Assert<
  Same<ObjectRefOf<Shape>, `user:${string}` | `team:${string}` | `document:${string}`>
>;

type _Subjects = Assert<
  Same<
    SubjectRefOf<Shape>,
    | `user:${string}`
    | `team:${string}`
    | `team:${string}#member`
    | `document:${string}`
    | `document:${string}#owner`
  >
>;

const perm: PermissionOf<Shape> = 'document.read';
// @ts-expect-error not a declared permission
const badPerm: PermissionOf<Shape> = 'document.delete';
// @ts-expect-error `team` declares no permission
const badTeamPerm: PermissionOf<Shape> = 'team.read';
// @ts-expect-error not a declared type
const badObject: ObjectRefOf<Shape> = 'invoice:1';

/**
 * A known limit, asserted so it stays visible: `${string}` also matches a `#`, so
 * `` `user:${string}` `` accepts `user:x#member` even though `user` declares no
 * relations. Catching that needs a branded id type, which is more machinery than
 * the rest of the typing story is worth. The *permission* union — the one that
 * drives autocomplete at a call site — is exact, and that is the point.
 */
const looseUserset: SubjectRefOf<Shape> = 'user:x#member';

describe('type-level derivations', () => {
  it('derives literal names, not string templates', () => {
    expect(perm).toBe('document.read');
  });

  it('leaves the runtime AST readable as an AST', () => {
    const read = model.types.document?.permissions.read;
    expect(read).toBeDefined();
    expect(read?.kind).toBe('union');
  });

  it('accepts the declared values and nothing else', () => {
    // Referenced so the negative cases above are not elided as unused.
    expect([badPerm, badTeamPerm, badObject, looseUserset]).toHaveLength(4);
  });
});
