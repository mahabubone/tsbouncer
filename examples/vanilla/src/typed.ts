import type {
  Authz,
  ModelShapeOf,
  ObjectRefOf,
  PermissionOf,
  SubjectRefOf,
} from 'tsbouncer';
import type { model } from './model.js';

/**
 * The typing layer, in one file.
 *
 * `authz.can(subject, permission, resource)` takes three plain `string`s, because
 * the store is schemaless and the model is built at runtime. The model *is* known
 * statically though, so these helpers derive the legal strings from
 * `typeof model` and the call sites get autocomplete.
 *
 * This is the whole pattern: build refs in one place, derive the string unions
 * once, and every `can()` after that is checked.
 */

type Shape = ModelShapeOf<typeof model>;

/** `'user:…' | 'team:…#member' | …` — every subject the model admits. */
export type AnySubject = SubjectRefOf<Shape>;

/** `'user:…' | 'document:…' | 'folder:…' | 'team:…'` */
export type AnyResource = ObjectRefOf<Shape>;

/** `'document.read' | 'document.write' | 'document.public' | 'folder.read' | 'team.read'` */
export type AnyPermission = PermissionOf<Shape>;

/** Narrowing to one type is a plain `Extract`, since the union is `'type.perm'`. */
export type DocumentPermission = Extract<AnyPermission, `document.${string}`>;

/* Ref builders. The casts are the point: an id cannot contain `:` or `#`, so
 * these are total. A caller that interpolates an unvalidated string is not. */
export const userRef = (id: string): AnySubject => `user:${id}` as AnySubject;
export const teamRef = (id: string): AnySubject => `team:${id}` as AnySubject;
export const teamMemberRef = (id: string): AnySubject =>
  `team:${id}#member` as AnySubject;
export const docRef = (id: string): AnyResource => `document:${id}` as AnyResource;

/**
 * A thin, typed façade over the client. Nothing is wrapped or hidden — every
 * method forwards to `authz` — but the arguments are now checked.
 */
export function typed(authz: Authz) {
  return {
    can: (subject: AnySubject, permission: AnyPermission, resource: AnyResource) =>
      authz.can(subject, permission, resource),

    /** The common case: "can this subject do this to document #id?". */
    canOnDocument: (subject: AnySubject, permission: DocumentPermission, id: string) =>
      authz.can(subject, permission, docRef(id)),

    assertOnDocument: (subject: AnySubject, permission: DocumentPermission, id: string) =>
      authz.assert({ subject, permission, resource: docRef(id) }),
  };
}
