export type AuthorizationErrorCode =
  | 'invalid_reference'
  | 'invalid_model'
  | 'invalid_tuple'
  | 'invalid_store'
  | 'store_error'
  | 'cache_error'
  | 'access_denied'
  | 'evaluation_limit';

export interface AuthorizationErrorOptions {
  cause?: unknown;
  details?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Base class for every error thrown by this library.
 *
 * `code` is stable and part of the public API: match on it, do not match on
 * `message`. Errors thrown by user-supplied code (condition predicates, custom
 * store implementations) are wrapped in one of these rather than propagated.
 */
export class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: AuthorizationErrorCode,
    message: string,
    options: AuthorizationErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details;
  }
}

export class InvalidReferenceError extends AuthorizationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('invalid_reference', message, { details });
  }
}

export class ModelDefinitionError extends AuthorizationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('invalid_model', message, { details });
  }
}

export class TupleValidationError extends AuthorizationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('invalid_tuple', message, { details });
  }
}

export class StoreError extends AuthorizationError {
  constructor(message: string, options: AuthorizationErrorOptions = {}) {
    super('store_error', message, options);
  }
}

export class InvalidStoreError extends AuthorizationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('invalid_store', message, { details });
  }
}

export class CacheError extends AuthorizationError {
  constructor(message: string, options: AuthorizationErrorOptions = {}) {
    super('cache_error', message, options);
  }
}

/** Thrown by `authz.assert()` when a check resolves to not-allowed. */
export class AccessDeniedError extends AuthorizationError {
  readonly request: Readonly<{
    subject: string;
    permission: string;
    resource: string;
  }>;

  constructor(request: { subject: string; permission: string; resource: string }) {
    super(
      'access_denied',
      `${request.subject} is not allowed to ${request.permission} on ${request.resource}`,
      { details: { ...request } },
    );
    this.request = Object.freeze({ ...request });
  }
}

/**
 * Thrown when an evaluation exceeds the configured depth, node, or time budget.
 *
 * Fails closed: the engine converts this into a not-allowed decision rather than
 * surfacing it from `check()`. Only `explain()` reports it, as a distinct reason.
 */
export class EvaluationLimitError extends AuthorizationError {
  readonly limit: 'depth' | 'nodes' | 'deadline';
  readonly budget: number;

  constructor(limit: 'depth' | 'nodes' | 'deadline', budget: number) {
    super('evaluation_limit', `evaluation ${limit} budget exhausted (${budget})`, {
      details: { limit, budget },
    });
    this.limit = limit;
    this.budget = budget;
  }
}

export function isAuthorizationError(value: unknown): value is AuthorizationError {
  return value instanceof AuthorizationError;
}
