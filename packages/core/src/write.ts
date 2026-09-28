import { TupleValidationError } from './errors.js';
import type { Model, SetNode } from './model.js';
import { type ParsedRef, parseRef } from './refs.js';
import type { Tuple } from './store.js';

/**
 * Check a tuple against the model *before* it is persisted.
 *
 * A bad tuple is a bug in the caller, and finding it at write time is far
 * cheaper than finding it as a silent denial months later. This is the reason to
 * validate at all: the store contract carries no model, so without this the only
 * place a typo ever surfaces is a decision.
 */
export function validateTuple(model: Model, tuple: Tuple): void {
  const subject = parseRef(tuple.subject, 'subject');
  const resource = parseRef(tuple.resource, 'object');

  const resourceType = model.types[resource.type];
  if (resourceType === undefined) {
    throw new TupleValidationError(
      `resource type ${JSON.stringify(resource.type)} is not declared by the model`,
      {
        resourceType: resource.type,
        subjectType: subject.type,
        relation: tuple.relation,
      },
    );
  }

  const edge = resourceType.relations[tuple.relation];
  if (edge === undefined) {
    if (tuple.relation in resourceType.permissions) {
      throw new TupleValidationError(
        `${JSON.stringify(resource.type)}.${tuple.relation} is a permission, and tuples are only written against relations`,
        { resourceType: resource.type, relation: tuple.relation, alsoPermission: true },
      );
    }
    throw new TupleValidationError(
      `type ${JSON.stringify(resource.type)} has no relation ${JSON.stringify(tuple.relation)}`,
      {
        resourceType: resource.type,
        relation: tuple.relation,
        declared: Object.keys(resourceType.relations),
      },
    );
  }

  if (model.types[subject.type] === undefined) {
    throw new TupleValidationError(
      `subject type ${JSON.stringify(subject.type)} is not declared by the model`,
      { subjectType: subject.type },
    );
  }

  if (!acceptsSubject(model, resource.type, edge, subject, new Set())) {
    const wanted =
      subject.relation === undefined
        ? subject.type
        : `${subject.type}#${subject.relation}`;
    throw new TupleValidationError(
      `relation ${JSON.stringify(tuple.relation)} on ${JSON.stringify(resource.type)} does not accept a ${JSON.stringify(wanted)} subject`,
      { relation: tuple.relation, resourceType: resource.type, subject: wanted },
    );
  }

  if (tuple.condition !== undefined && model.conditions[tuple.condition] === undefined) {
    throw new TupleValidationError(
      `condition ${JSON.stringify(tuple.condition)} is not declared by the model`,
      { condition: tuple.condition, declared: Object.keys(model.conditions) },
    );
  }
}

export function validateTuples(model: Model, tuples: readonly Tuple[]): void {
  for (const tuple of tuples) validateTuple(model, tuple);
}

/**
 * Does this relation edge accept a subject of `subject.type`, optionally a
 * userset of `subject.relation`?
 *
 * A union accepts a subject if any branch does; an intersection only if every
 * branch does; an exclusion is decided by its base, because the `except` side can
 * only remove an access the base granted.
 *
 * `computed` is followed rather than rejected: a relation is allowed to delegate
 * to another member of the same type, and stopping at the reference would reject
 * tuples that are perfectly valid.
 */
export function acceptsSubject(
  model: Model,
  typeName: string,
  node: SetNode,
  subject: ParsedRef,
  seen: Set<string>,
): boolean {
  switch (node.kind) {
    case 'direct':
      // A wildcard edge is not something a caller writes a grant against, so
      // only a non-wildcard edge of the same type accepts a direct subject.
      return !node.wildcard && subject.type === node.type;

    case 'userset':
      return subject.relation === node.relation && subject.type === node.type;

    case 'computed': {
      const key = `${typeName}#${node.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const type = model.types[typeName];
      const target =
        type?.relations[node.name] ?? type?.permissions[node.name] ?? undefined;
      return target === undefined
        ? false
        : acceptsSubject(model, typeName, target, subject, seen);
    }

    case 'union':
      return node.children.some((child) =>
        acceptsSubject(model, typeName, child, subject, new Set(seen)),
      );

    case 'intersection':
      return node.children.every((child) =>
        acceptsSubject(model, typeName, child, subject, new Set(seen)),
      );

    case 'exclusion':
      return acceptsSubject(model, typeName, node.base, subject, seen);

    case 'ttu':
      return false;
  }
}

export function describeTuple(tuple: Tuple): string {
  return `${tuple.subject}#${tuple.relation}@${tuple.resource}`;
}
