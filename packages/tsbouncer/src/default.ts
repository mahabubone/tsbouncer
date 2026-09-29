import type { Authz, EvaluationLimits, Model, TupleStore } from '@tsbouncer/core';
import { createAuthz } from '@tsbouncer/core';
import { jsonStore } from '@tsbouncer/json';
import { memoryStore } from '@tsbouncer/memory';

export interface CreateDefaultAuthzOptions {
  readonly model: Model;
  /**
   * Path to a JSON file. Omit it for a process-local store, which is what you
   * want in a test.
   *
   * The choice is deliberately not automatic from the environment: whether
   * authorization state should be durable is a decision about your application,
   * not something a library should infer from whether a file happens to exist.
   */
  readonly file?: string | undefined;
  readonly limits?: Partial<EvaluationLimits> | undefined;
}

/**
 * Build a client with a store chosen for you.
 *
 * This exists so the common case is one call, and so the two dependency-free
 * stores are reachable without importing each one by hand. Anything with a real
 * database behind it should call `createAuthz` with the store you already have.
 */
export function createDefaultAuthz(options: CreateDefaultAuthzOptions): Authz {
  const store: TupleStore =
    options.file === undefined ? memoryStore() : jsonStore({ file: options.file });
  return createAuthz({
    model: options.model,
    store,
    limits: options.limits,
  });
}

/** True when the chosen store survives the process. */
export function isPersistent(store: TupleStore): boolean {
  return store.capabilities.persistent;
}
