import { InvalidReferenceError } from './errors.js';
import type { ModelShape, ObjectRefOf, PermissionOf, SubjectRefOf } from './shape.js';

export type { ObjectRefOf, PermissionOf, SubjectRefOf };

/**
 * Grammar, longest form first:
 *
 *   ref      := type ':' id [ '#' relation ]
 *   type     := [a-z_][a-zA-Z0-9_]*
 *   id       := non-empty, no '#', no control chars, no edge whitespace
 *   relation := [a-z_][a-zA-Z0-9_]*
 *
 * Names allow internal uppercase so `teamMember` and `inRegion` are ordinary.
 * The leading character must be lowercase or an underscore.
 *
 * `id` may itself contain ':'. Splitting happens on the *first* ':' and the
 * *first* '#', so `org:acme_doc:123` is `org` + `acme_doc:123`, not a nested
 * type. That is what lets callers fold tenancy into an opaque id — see the
 * multi-tenant decision in PLAN.md — without teaching the engine about it.
 */
export const TYPE_PATTERN = /^[a-z_][a-zA-Z0-9_]*$/;
export const RELATION_PATTERN = /^[a-z_][a-zA-Z0-9_]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters in ids is the entire purpose
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

export const WILDCARD = '*';

export type RefPosition = 'subject' | 'object' | 'any';

export interface ParsedRef {
  readonly type: string;
  readonly id: string;
  readonly relation?: string | undefined;
}

export function isWildcard(ref: ParsedRef | string): boolean {
  const id =
    typeof ref === 'string' ? ref.split('#')[0]?.split(':').slice(1).join(':') : ref.id;
  return id === WILDCARD;
}

export function parseRef(input: string, position: RefPosition = 'any'): ParsedRef {
  if (typeof input !== 'string') {
    throw new InvalidReferenceError('reference must be a string', {
      received: typeof input,
    });
  }
  if (input.length === 0) {
    throw new InvalidReferenceError('reference must not be empty');
  }

  const colon = input.indexOf(':');
  if (colon < 0) {
    throw new InvalidReferenceError(
      `reference ${JSON.stringify(input)} is missing ':' — expected "type:id"`,
      { input },
    );
  }

  const type = input.slice(0, colon);
  if (!TYPE_PATTERN.test(type)) {
    throw new InvalidReferenceError(
      `invalid type ${JSON.stringify(type)} in ${JSON.stringify(input)}: expected [a-z_][a-z0-9_]*`,
      { input, type },
    );
  }

  const rest = input.slice(colon + 1);
  const hash = rest.indexOf('#');

  let id: string;
  let relation: string | undefined;

  if (hash < 0) {
    id = rest;
  } else {
    id = rest.slice(0, hash);
    relation = rest.slice(hash + 1);
    if (relation.includes('#')) {
      throw new InvalidReferenceError(
        `reference ${JSON.stringify(input)} has more than one '#' — ids may not contain '#'`,
        { input },
      );
    }
    if (!RELATION_PATTERN.test(relation)) {
      throw new InvalidReferenceError(
        `invalid relation ${JSON.stringify(relation)} in ${JSON.stringify(input)}: expected [a-z_][a-z0-9_]*`,
        { input, relation },
      );
    }
  }

  assertValidId(id, input);

  if (position === 'object' && relation !== undefined) {
    throw new InvalidReferenceError(
      `resource ${JSON.stringify(input)} must not carry a relation — use "type:id"`,
      { input },
    );
  }

  if (position === 'subject' && id === WILDCARD && relation !== undefined) {
    throw new InvalidReferenceError(
      `wildcard subject ${JSON.stringify(input)} must not carry a relation`,
      { input },
    );
  }

  return { type, id, relation };
}

function assertValidId(id: string, input: string): void {
  if (id.length === 0) {
    throw new InvalidReferenceError(
      `reference ${JSON.stringify(input)} has an empty id`,
      {
        input,
      },
    );
  }
  if (id !== id.trim()) {
    throw new InvalidReferenceError(
      `id ${JSON.stringify(id)} has leading or trailing whitespace`,
      { input, id },
    );
  }
  if (CONTROL_CHAR_PATTERN.test(id)) {
    throw new InvalidReferenceError(
      `id ${JSON.stringify(id)} contains control characters`,
      { input, id },
    );
  }
}

export function formatRef(ref: ParsedRef): string {
  const base = `${ref.type}:${ref.id}`;
  return ref.relation === undefined ? base : `${base}#${ref.relation}`;
}

/** Canonical key for memoization, dedup, and set membership. */
export function refKey(input: string | ParsedRef): string {
  const ref = typeof input === 'string' ? parseRef(input) : input;
  return formatRef(ref);
}

export function tryParseRef(input: string): ParsedRef | undefined {
  try {
    return parseRef(input);
  } catch {
    return undefined;
  }
}

/**
 * Splits the user-facing `type.permission` form into its parts.
 *
 * Permissions use `.` while subject references use `#`. That asymmetry comes
 * from the API in IDEA.md, where `permission: "document.read"` sits next to
 * `subject: "team:engineering#member"`. Normalizing to `#` internally would
 * collide with subject references, so both stay distinct end to end.
 */
export function parsePermission(input: string): { type: string; permission: string } {
  const dot = input.indexOf('.');
  if (dot < 0) {
    throw new InvalidReferenceError(
      `permission ${JSON.stringify(input)} is missing '.' — expected "type.permission"`,
      { input },
    );
  }
  const type = input.slice(0, dot);
  const permission = input.slice(dot + 1);
  if (!TYPE_PATTERN.test(type) || !RELATION_PATTERN.test(permission)) {
    throw new InvalidReferenceError(
      `invalid permission ${JSON.stringify(input)}: expected "type.permission" with [a-z_][a-z0-9_]* names`,
      { input },
    );
  }
  return { type, permission };
}

export function formatPermission(type: string, permission: string): string {
  return `${type}.${permission}`;
}

export type SubjectOf<M extends ModelShape> = SubjectRefOf<M>;
export type ResourceOf<M extends ModelShape> = ObjectRefOf<M>;
export type PermissionNameOf<M extends ModelShape> = PermissionOf<M>;
