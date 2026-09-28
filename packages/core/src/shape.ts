/**
 * Structural description of a model, carried at the type level only.
 *
 * The runtime model is built by `defineModel`. These interfaces exist so that
 * reference and permission strings can be *derived* from `typeof model`, which
 * gives editor autocomplete without attempting full compile-time inference.
 */

export interface TypeShape {
  readonly relations: Readonly<Record<string, unknown>>;
  readonly permissions: Readonly<Record<string, true>>;
}

export interface ModelShape {
  readonly types: Readonly<Record<string, TypeShape>>;
}

export type TypeNames<M extends ModelShape> = Extract<keyof M['types'], string>;

export type RelationNames<T> = T extends { readonly relations: infer R }
  ? Extract<keyof R, string>
  : never;

export type PermissionNames<T> = T extends { readonly permissions: infer P }
  ? Extract<keyof P, string>
  : never;

/** Every `type:id` and `type:id#relation` string the model permits as a subject. */
export type SubjectRefOf<M extends ModelShape> = {
  [T in TypeNames<M>]:
    | `${T}:${string}`
    | (RelationNames<M['types'][T]> extends never
        ? never
        : `${T}:${string}#${RelationNames<M['types'][T]>}`);
}[TypeNames<M>];

/** Every `type:id` string the model permits as a resource. */
export type ObjectRefOf<M extends ModelShape> = `${TypeNames<M>}:${string}`;

/** Every `type.permission` string the model declares. */
export type PermissionOf<M extends ModelShape> = {
  [T in TypeNames<M>]: PermissionNames<M['types'][T]> extends never
    ? never
    : `${T}.${PermissionNames<M['types'][T]>}`;
}[TypeNames<M>];

/** Every relation name declared on type `T`. */
export type RelationsOf<M extends ModelShape, T extends TypeNames<M>> = RelationNames<
  M['types'][T]
>;
