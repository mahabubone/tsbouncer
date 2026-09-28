import { AccessDeniedError, InvalidReferenceError } from './errors.js';
import { evaluate } from './evaluate.js';
import type { ExplainResult } from './explain.js';
import { type EvaluationLimits, resolveLimits } from './limits.js';
import type { ConditionContext, Model } from './model.js';
import { formatPermission, parsePermission, parseRef, WILDCARD } from './refs.js';
import {
  assertStoreShape,
  type DeleteInput,
  type KeymanStore,
  type Tuple,
  type WriteMode,
} from './store.js';
import { validateTuples } from './write.js';

export interface CreateAuthzOptions {
  readonly model: Model;
  readonly store: KeymanStore;
  /** Per-request evaluation budget. */
  readonly limits?: Partial<EvaluationLimits> | undefined;
  /** Validate every tuple against the model before writing. Default true. */
  readonly validate?: boolean;
}

export interface CheckRequest {
  readonly subject: string;
  readonly permission: string;
  readonly resource: string;
}

export interface CheckOptions {
  /** Request-time context, merged over each tuple's own bindings. */
  readonly context?: ConditionContext | undefined;
}

export interface Decision {
  readonly allowed: boolean;
  readonly subject: string;
  readonly permission: string;
  readonly resource: string;
}

export interface GrantInput {
  readonly subject: string;
  readonly relation: string;
  readonly resource: string;
  readonly condition?: string | undefined;
  readonly context?: ConditionContext | undefined;
}

export interface Authz {
  readonly model: Model;
  readonly store: KeymanStore;

  can(subject: string, permission: string, resource: string): Promise<boolean>;
  check(request: CheckRequest, options?: CheckOptions): Promise<Decision>;
  assert(request: CheckRequest, options?: CheckOptions): Promise<void>;
  explain(request: CheckRequest, options?: CheckOptions): Promise<ExplainResult>;

  grant(input: GrantInput): Promise<void>;
  write(tuples: readonly Tuple[], mode?: WriteMode): Promise<void>;
  revoke(tuple: GrantInput): Promise<void>;
  delete(input: DeleteInput): Promise<void>;

  /** A client bound to another store — typically a transaction handle. */
  withStore(store: KeymanStore): Authz;

  types(): string[];
  relations(type: string): string[];
  permissions(type: string): string[];
}

/**
 * Build a client.
 *
 * Everything the library does goes through here. The application owns the store,
 * the connection, and the transaction; this object only knows how to ask.
 */
export function createAuthz(options: CreateAuthzOptions): Authz {
  const { model, store } = options;
  if (model === undefined || model === null || typeof model.types !== 'object') {
    throw new TypeError('createAuthz() requires a model built with defineModel()');
  }
  assertStoreShape(store);

  const limits = resolveLimits(options.limits);
  const shouldValidate = options.validate ?? true;

  const client: Authz = {
    model,
    store,

    can(subject, permission, resource) {
      return decide(model, store, limits, { subject, permission, resource }).then(
        (d) => d.allowed,
      );
    },

    async check(request, checkOptions) {
      return decide(model, store, limits, request, checkOptions);
    },

    async assert(request, checkOptions) {
      const decision = await decide(model, store, limits, request, checkOptions);
      if (!decision.allowed) {
        throw new AccessDeniedError({
          subject: decision.subject,
          permission: decision.permission,
          resource: decision.resource,
        });
      }
    },

    async explain(request, checkOptions) {
      const resolved = resolveRequest(model, request);
      const outcome = await evaluate({
        model,
        store,
        subject: resolved.subject,
        member: resolved.permission,
        resource: resolved.resource,
        context: checkOptions?.context,
        limits,
      });
      return {
        allowed: outcome.allowed,
        subject: resolved.subjectRef,
        permission: formatPermission(resolved.type, resolved.permission),
        resource: resolved.resourceRef,
        tree: outcome.tree,
        reads: outcome.reads,
      };
    },

    async grant(input) {
      await client.write([toTuple(input)]);
    },

    async write(tuples, mode = 'insert') {
      if (shouldValidate) validateTuples(model, tuples);
      await store.write({ tuples, mode });
    },

    async revoke(input) {
      await client.delete({ kind: 'tuples', tuples: [toTuple(input)] });
    },

    async delete(input) {
      if (input.kind === 'tuples' && shouldValidate) validateTuples(model, input.tuples);
      if (input.kind === 'replace' && shouldValidate) validateTuples(model, input.tuples);
      await store.delete(input);
    },

    withStore(next) {
      assertStoreShape(next);
      return createAuthz({
        model,
        store: next,
        limits: options.limits,
        validate: shouldValidate,
      });
    },

    types() {
      return Object.keys(model.types);
    },

    relations(type) {
      const definition = model.types[type];
      if (definition === undefined) {
        throw new InvalidReferenceError(`unknown type ${JSON.stringify(type)}`, { type });
      }
      return Object.keys(definition.relations);
    },

    permissions(type) {
      const definition = model.types[type];
      if (definition === undefined) {
        throw new InvalidReferenceError(`unknown type ${JSON.stringify(type)}`, { type });
      }
      return Object.keys(definition.permissions);
    },
  };

  return Object.freeze(client);
}

interface ResolvedRequest {
  subject: ReturnType<typeof parseRef>;
  subjectRef: string;
  type: string;
  permission: string;
  resource: ReturnType<typeof parseRef>;
  resourceRef: string;
}

function resolveRequest(model: Model, request: CheckRequest): ResolvedRequest {
  const { type, permission } = parsePermission(request.permission);
  const subject = parseRef(request.subject, 'subject');
  const resource = parseRef(request.resource, 'object');

  if (subject.relation === undefined && subject.id === WILDCARD) {
    throw new InvalidReferenceError(
      'cannot check on behalf of a wildcard subject; ask whether a specific subject is allowed',
      { subject: request.subject },
    );
  }

  const definition = model.types[type];
  if (definition === undefined) {
    throw new InvalidReferenceError(
      `permission ${JSON.stringify(request.permission)} names a type the model does not declare`,
      { type },
    );
  }
  if (
    definition.relations[permission] === undefined &&
    definition.permissions[permission] === undefined
  ) {
    throw new InvalidReferenceError(
      `type ${JSON.stringify(type)} declares no relation or permission named ${JSON.stringify(permission)}`,
      { type, permission },
    );
  }
  if (resource.type !== type) {
    throw new InvalidReferenceError(
      `permission ${JSON.stringify(request.permission)} applies to a ${JSON.stringify(type)}, but the resource is a ${JSON.stringify(resource.type)}`,
      { type, permission, resourceType: resource.type },
    );
  }

  return {
    subject,
    subjectRef: request.subject,
    type,
    permission,
    resource,
    resourceRef: request.resource,
  };
}

async function decide(
  model: Model,
  store: KeymanStore,
  limits: EvaluationLimits,
  request: CheckRequest,
  options?: CheckOptions,
): Promise<Decision> {
  const resolved = resolveRequest(model, request);
  const outcome = await evaluate({
    model,
    store,
    subject: resolved.subject,
    member: resolved.permission,
    resource: resolved.resource,
    context: options?.context,
    limits,
  });
  return {
    allowed: outcome.allowed,
    subject: request.subject,
    permission: request.permission,
    resource: request.resource,
  };
}

function toTuple(input: GrantInput): Tuple {
  const tuple: Tuple = {
    subject: input.subject,
    relation: input.relation,
    resource: input.resource,
    condition: input.condition,
    context: input.context,
  };
  return tuple;
}
