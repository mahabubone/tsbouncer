import { ModelDefinitionError } from './errors.js';
import { RELATION_PATTERN, TYPE_PATTERN } from './refs.js';
import type { ModelShape, TypeShape } from './shape.js';

// ---------------------------------------------------------------------------
// Expression AST
// ---------------------------------------------------------------------------

export interface DirectNode {
  readonly kind: 'direct';
  readonly type: string;
  readonly wildcard: boolean;
}

export interface UsersetNode {
  readonly kind: 'userset';
  readonly type: string;
  readonly relation: string;
}

export interface ComputedNode {
  readonly kind: 'computed';
  readonly name: string;
}

/**
 * Traverse `through` to a related object, then take `target` on it.
 * The Zanzibar form is `parent.folder#viewer`.
 */
export interface TtuNode {
  readonly kind: 'ttu';
  readonly through: string;
  readonly target: string;
}

export interface UnionNode {
  readonly kind: 'union';
  readonly children: readonly SetNode[];
}

export interface IntersectionNode {
  readonly kind: 'intersection';
  readonly children: readonly SetNode[];
}

export interface ExclusionNode {
  readonly kind: 'exclusion';
  readonly base: SetNode;
  readonly subtract: SetNode;
}

export type SetNode =
  | DirectNode
  | UsersetNode
  | ComputedNode
  | TtuNode
  | UnionNode
  | IntersectionNode
  | ExclusionNode;

// ---------------------------------------------------------------------------
// Fluent builders
// ---------------------------------------------------------------------------

export interface SetExpression {
  readonly node: SetNode;
  or(...others: readonly Child[]): SetExpression;
  and(...others: readonly Child[]): SetExpression;
  except(subtract: Child): SetExpression;
}

export type Child = string | SetExpression;

function expression(node: SetNode): SetExpression {
  return {
    node,
    or(...others) {
      return expression({ kind: 'union', children: [node, ...children(...others)] });
    },
    and(...others) {
      return expression({
        kind: 'intersection',
        children: [node, ...children(...others)],
      });
    },
    except(subtract) {
      return expression({ kind: 'exclusion', base: node, subtract: nodeOf(subtract) });
    },
  };
}

export function nodeOf(value: Child): SetNode {
  return typeof value === 'string' ? { kind: 'computed', name: value } : value.node;
}

function children(...values: readonly Child[]): SetNode[] {
  return values.map(nodeOf);
}

/** A relation edge. Tuples can be written against it. */
export function relation(
  type: string | readonly string[],
  options: { readonly through?: string } = {},
): SetExpression {
  if (typeof type !== 'string' && !Array.isArray(type)) {
    throw new ModelDefinitionError(
      'relation() expects a type name or array of type names',
    );
  }
  const types = typeof type === 'string' ? [type] : type;
  if (types.length === 0) {
    throw new ModelDefinitionError('relation() requires at least one type');
  }
  for (const t of types) {
    if (typeof t !== 'string' || t.length === 0) {
      throw new ModelDefinitionError('relation() type names must be non-empty strings');
    }
  }

  const parts: SetNode[] = types.map((t) =>
    options.through === undefined
      ? ({ kind: 'direct', type: t, wildcard: false } as const)
      : ({ kind: 'userset', type: t, relation: options.through } as const),
  );

  const [only, ...more] = parts;
  if (more.length === 0 && only !== undefined) return expression(only);
  return expression({ kind: 'union', children: parts });
}

/** Match any subject of `type` — the `user:*` edge. */
export function wildcard(type: string): SetExpression {
  return expression({ kind: 'direct', type, wildcard: true });
}

/** Follow `through` to a related object and take `target` on it. */
export function ttu(through: string, target: string): SetExpression {
  return expression({ kind: 'ttu', through, target });
}

export const permission = {
  or: (...values: readonly Child[]): SetExpression =>
    expression({ kind: 'union', children: children(...values) }),
  allOf: (...values: readonly Child[]): SetExpression =>
    expression({ kind: 'intersection', children: children(...values) }),
};

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export type ParamType = 'string' | 'number' | 'boolean';

export interface ConditionContext {
  readonly [key: string]: unknown;
}

export type ConditionPredicate = (context: ConditionContext) => boolean;

export interface ConditionOptions {
  /**
   * Declares the context parameters a tuple is allowed to bind. Optional: omit
   * it and tuples may carry any context object. When present, `grant`/`write`
   * validate the tuple's context against it and reject unknown or ill-typed
   * keys.
   */
  readonly params?: Readonly<Record<string, ParamType | unknown>>;
}

export interface ConditionDef {
  readonly name: string;
  readonly predicate: ConditionPredicate;
  readonly options: ConditionOptions;
}

export function defineCondition(
  name: string,
  predicate: ConditionPredicate,
  options: ConditionOptions = {},
): ConditionDef {
  if (typeof name !== 'string' || !RELATION_PATTERN.test(name)) {
    throw new ModelDefinitionError(
      `invalid condition name ${JSON.stringify(name)}: expected [a-z_][a-z0-9_]*`,
    );
  }
  if (typeof predicate !== 'function') {
    throw new ModelDefinitionError(
      `condition ${JSON.stringify(name)} must be a function`,
    );
  }
  return Object.freeze({ name, predicate, options: Object.freeze({ ...options }) });
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

export interface TypeConfig {
  readonly relations?: Readonly<Record<string, SetExpression>>;
  readonly permissions?: Readonly<Record<string, SetExpression>>;
}

export interface ModelConfig {
  readonly types: Readonly<Record<string, TypeConfig>>;
  readonly conditions?: Readonly<Record<string, ConditionDef>>;
}

type ShapeOfConfig<C extends ModelConfig> = {
  types: {
    [K in keyof C['types'] & string]: {
      relations: K extends keyof C['types']
        ? NonNullable<C['types'][K] extends { relations: infer R } ? R : never>
        : Record<never, never>;
      permissions: K extends keyof C['types']
        ? {
            [P in keyof NonNullable<
              C['types'][K] extends { permissions: infer P } ? P : never
            > &
              string]: true;
          }
        : Record<never, never>;
    };
  };
};

export interface TypeDefinition {
  readonly name: string;
  readonly relations: Readonly<Record<string, SetNode>>;
  readonly permissions: Readonly<Record<string, SetNode>>;
}

export interface Model<M extends ModelShape = ModelShape> {
  readonly types: Readonly<Record<string, TypeDefinition>>;
  readonly conditions: Readonly<Record<string, ConditionDef>>;
  readonly __shape?: M;
}

export function defineType(config: TypeConfig = {}): TypeConfig {
  return config;
}

export function defineModel<C extends ModelConfig>(config: C): Model<ShapeOfConfig<C>> {
  if (typeof config !== 'object' || config === null) {
    throw new ModelDefinitionError('defineModel() expects a config object');
  }
  const typeNames = Object.keys(config.types ?? {});
  if (typeNames.length === 0) {
    throw new ModelDefinitionError('model must declare at least one type');
  }
  for (const name of typeNames) {
    if (!TYPE_PATTERN.test(name)) {
      throw new ModelDefinitionError(
        `invalid type name ${JSON.stringify(name)}: expected [a-z_][a-z0-9_]*`,
      );
    }
  }

  const conditions: Record<string, ConditionDef> = {};
  for (const [name, def] of Object.entries(config.conditions ?? {})) {
    if (def?.name !== name) {
      throw new ModelDefinitionError(
        `condition ${JSON.stringify(name)} is registered under a different name`,
        { name, declared: def?.name },
      );
    }
    conditions[name] = def;
  }

  const types: Record<string, TypeDefinition> = {};
  for (const name of typeNames) {
    types[name] = buildType(name, config.types[name] ?? {});
  }

  validateCrossType(types);

  for (const name of typeNames) {
    const definition = types[name];
    if (definition !== undefined) detectCycles(name, definition);
  }

  return Object.freeze({
    types: Object.freeze(types),
    conditions: Object.freeze(conditions),
  }) as Model<ShapeOfConfig<C>>;
}

function buildType(name: string, config: TypeConfig): TypeDefinition {
  const relations: Record<string, SetNode> = {};
  const permissions: Record<string, SetNode> = {};

  for (const [relName, expr] of Object.entries(config.relations ?? {})) {
    assertValidMemberName(name, relName, 'relation');
    relations[relName] = expr.node;
  }

  for (const [permName, expr] of Object.entries(config.permissions ?? {})) {
    assertValidMemberName(name, permName, 'permission');
    if (permName in relations) {
      throw new ModelDefinitionError(
        `type ${JSON.stringify(name)} declares ${JSON.stringify(permName)} as both a relation and a permission`,
      );
    }
    permissions[permName] = expr.node;
  }

  const definition: TypeDefinition = { name, relations, permissions };
  validateLocal(name, definition);
  return definition;
}

function assertValidMemberName(typeName: string, member: string, kind: string): void {
  if (!RELATION_PATTERN.test(member)) {
    throw new ModelDefinitionError(
      `invalid ${kind} name ${JSON.stringify(member)} on type ${JSON.stringify(typeName)}: expected [a-z_][a-z0-9_]*`,
    );
  }
}

/** Intra-type checks. Safe to run per type, before other types are known. */
function validateLocal(typeName: string, definition: TypeDefinition): void {
  const known = new Set([
    ...Object.keys(definition.relations),
    ...Object.keys(definition.permissions),
  ]);

  const check = (fromKind: string, fromName: string, node: SetNode): void => {
    walk(node, (child) => {
      if (child.kind === 'computed' && !known.has(child.name)) {
        throw new ModelDefinitionError(
          `type ${JSON.stringify(typeName)} ${fromKind} ${JSON.stringify(fromName)} references ${JSON.stringify(child.name)}, which is not a relation or permission on that type`,
          { type: typeName, name: child.name },
        );
      }
      if (child.kind === 'ttu' && !definition.relations[child.through]) {
        throw new ModelDefinitionError(
          `type ${JSON.stringify(typeName)} ${fromKind} ${JSON.stringify(fromName)} traverses ${JSON.stringify(child.through)}, which is not a relation on ${JSON.stringify(typeName)}`,
          { type: typeName, through: child.through },
        );
      }
      // A tuple is only ever written against a relation, so a permission that
      // contains a direct or userset edge names an edge that can never exist.
      if (
        fromKind === 'permission' &&
        (child.kind === 'direct' || child.kind === 'userset')
      ) {
        throw new ModelDefinitionError(
          `type ${JSON.stringify(typeName)} permission ${JSON.stringify(fromName)} contains a ${child.kind} edge, but tuples are only written against relations — reference a relation instead`,
          { type: typeName, name: fromName, edge: child.kind },
        );
      }
    });
  };

  for (const [name, node] of Object.entries(definition.relations)) {
    check('relation', name, node);
  }
  for (const [name, node] of Object.entries(definition.permissions)) {
    check('permission', name, node);
  }
}

/** Cross-type checks. Must run once every type has been built. */
function validateCrossType(types: Readonly<Record<string, TypeDefinition>>): void {
  for (const definition of Object.values(types)) {
    const { name: typeName, relations, permissions } = definition;
    const all: [string, string, SetNode][] = [
      ...Object.entries(relations).map(([n, node]): [string, string, SetNode] => [
        'relation',
        n,
        node,
      ]),
      ...Object.entries(permissions).map(([n, node]): [string, string, SetNode] => [
        'permission',
        n,
        node,
      ]),
    ];

    for (const [kind, member, node] of all) {
      walk(node, (child) => {
        switch (child.kind) {
          case 'direct': {
            if (!types[child.type]) {
              throw new ModelDefinitionError(
                `type ${JSON.stringify(typeName)} ${kind} ${JSON.stringify(member)} accepts subject type ${JSON.stringify(child.type)}, which the model does not declare`,
                { type: typeName, subjectType: child.type },
              );
            }
            return;
          }
          case 'userset': {
            const target = types[child.type];
            if (!target) {
              throw new ModelDefinitionError(
                `type ${JSON.stringify(typeName)} ${kind} ${JSON.stringify(member)} expands ${child.type}#${child.relation}, but ${JSON.stringify(child.type)} is not a declared type`,
                { type: typeName, subjectType: child.type },
              );
            }
            if (!(child.relation in target.relations)) {
              throw new ModelDefinitionError(
                `type ${JSON.stringify(typeName)} ${kind} ${JSON.stringify(member)} expands ${child.type}#${child.relation}, which is not a relation on ${JSON.stringify(child.type)}`,
                {
                  type: typeName,
                  subjectType: child.type,
                  subjectRelation: child.relation,
                },
              );
            }
            return;
          }
          case 'ttu': {
            const through = relations[child.through];
            const targets = through ? directTargets(types, typeName, through) : [];
            if (targets.length === 0) {
              throw new ModelDefinitionError(
                `tuple-to-userset ${child.through}.${child.target} on type ${JSON.stringify(typeName)} must traverse a relation that yields objects, but ${JSON.stringify(child.through)} has no direct target type`,
                { type: typeName, through: child.through },
              );
            }
            for (const targetType of targets) {
              const target = types[targetType];
              if (!target) continue;
              if (
                child.target in target.relations ||
                child.target in target.permissions
              ) {
                continue;
              }
              throw new ModelDefinitionError(
                `tuple-to-userset ${child.through}.${child.target} on type ${JSON.stringify(typeName)} targets ${JSON.stringify(child.target)}, which is neither a relation nor a permission on ${JSON.stringify(targetType)}`,
                {
                  type: typeName,
                  through: child.through,
                  target: child.target,
                  targetType,
                },
              );
            }
            return;
          }
          default:
        }
      });
    }
  }
}

/**
 * The object types a relation edge actually points at.
 *
 * A tuple-to-userset can only traverse an edge that yields objects, so
 * `relation('folder')` contributes `folder` while `relation('team', { through:
 * 'member' })` contributes nothing — that one points at *subjects*, not at an
 * object we can then ask a question of.
 */
function directTargets(
  types: Readonly<Record<string, TypeDefinition>>,
  typeName: string,
  node: SetNode,
  seen: Set<string> = new Set(),
): string[] {
  switch (node.kind) {
    case 'direct':
      return [node.type];
    case 'union':
    case 'intersection':
      return [
        ...new Set(node.children.flatMap((c) => directTargets(types, typeName, c, seen))),
      ];
    // A relation may delegate to another member of its own type, and a
    // tuple-to-userset can traverse through that delegate. Resolving the
    // reference needs the built types, so it is followed rather than treated as
    // a dead end that would reject a legal model.
    case 'computed': {
      const key = `${typeName}#${node.name}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const target = types[typeName]?.relations[node.name];
      return target === undefined ? [] : directTargets(types, typeName, target, seen);
    }
    default:
      return [];
  }
}

function walk(node: SetNode, visit: (node: SetNode) => void): void {
  visit(node);
  switch (node.kind) {
    case 'union':
    case 'intersection':
      for (const child of node.children) walk(child, visit);
      return;
    case 'exclusion':
      walk(node.base, visit);
      walk(node.subtract, visit);
      return;
    default:
  }
}

/**
 * A `computed` edge from a permission back to itself is an infinite loop that
 * no runtime budget can make safe. TTU edges cross object boundaries and are
 * handled at evaluation time by the seen-set instead.
 */
function detectCycles(typeName: string, definition: TypeDefinition): void {
  const edges = new Map<string, string[]>();

  const collect = (from: string, node: SetNode): void => {
    const targets: string[] = [];
    walk(node, (child) => {
      if (child.kind === 'computed') targets.push(child.name);
    });
    edges.set(from, targets);
  };

  for (const [name, node] of Object.entries(definition.relations)) collect(name, node);
  for (const [name, node] of Object.entries(definition.permissions)) collect(name, node);

  const state = new Map<string, 'open' | 'closed'>();
  const stack: string[] = [];

  const visit = (name: string): void => {
    const current = state.get(name);
    if (current === 'closed') return;
    if (current === 'open') {
      const cycle = [...stack.slice(stack.indexOf(name)), name];
      throw new ModelDefinitionError(
        `type ${JSON.stringify(typeName)} has a cycle: ${cycle.join(' -> ')}`,
        { type: typeName, cycle },
      );
    }
    state.set(name, 'open');
    stack.push(name);
    for (const next of edges.get(name) ?? []) visit(next);
    stack.pop();
    state.set(name, 'closed');
  };

  for (const name of edges.keys()) visit(name);
}

export function typeNames(model: Model): string[] {
  return Object.keys(model.types);
}

export function relationsOf(model: Model, type: string): string[] {
  const definition = model.types[type];
  if (!definition) {
    throw new ModelDefinitionError(`unknown type ${JSON.stringify(type)}`);
  }
  return Object.keys(definition.relations);
}

export function permissionsOf(model: Model, type: string): string[] {
  const definition = model.types[type];
  if (!definition) {
    throw new ModelDefinitionError(`unknown type ${JSON.stringify(type)}`);
  }
  return Object.keys(definition.permissions);
}

export type { ModelShape, TypeShape };
