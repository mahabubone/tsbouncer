import type { ConditionContext, ConditionDef, Model, ParamType } from './model.js';
import type { Tuple } from './store.js';

export interface ConditionDenied {
  readonly satisfied: false;
  readonly reason: string;
}

export type ConditionOutcome = { readonly satisfied: true } | ConditionDenied;

const SATISFIED: ConditionOutcome = Object.freeze({ satisfied: true });

/** Construct a denial. Keeps the literal's `false` discriminant honest. */
function deny(reason: string): ConditionDenied {
  return { satisfied: false, reason };
}

/**
 * Merge the two halves of a condition's inputs.
 *
 * A tuple carries the parameters the *writer* bound — `resourceRegion: 'eu'` is
 * part of the grant and is stored with it. The request carries what the *caller*
 * knows right now — `userTier: 'pro'` is not in the store at all.
 *
 * The tuple wins on a conflict. If both supply `resourceRegion`, the request is
 * trying to rewrite the constraint the grant was written with, and a condition
 * that let a caller override its own bounds would not be a condition.
 */
export function mergeContext(
  request: ConditionContext | undefined,
  bound: ConditionContext | undefined,
): ConditionContext {
  return { ...request, ...bound };
}

/**
 * Decide whether a conditional tuple holds.
 *
 * Every failure path is a denial, and each one carries the reason so `explain`
 * can say which. The order matters: an undeclared condition is checked before
 * anything else, because a tuple whose condition the model no longer knows about
 * must not be evaluated against a guess.
 */
export function evaluateTupleCondition(
  model: Model,
  tuple: Tuple,
  request?: ConditionContext,
): ConditionOutcome {
  const name = tuple.condition;
  if (name === undefined) return SATISFIED;

  const def = model.conditions[name];
  if (def === undefined) {
    return deny(`condition ${JSON.stringify(name)} is not declared by the model`);
  }

  const merged = mergeContext(request, tuple.context);

  const declared = checkParams(def, merged);
  if (declared !== undefined) return declared;

  return runPredicate(def, merged);
}

/**
 * Check the declared parameter schema, when there is one.
 *
 * This is the only place a *missing* key can be detected: a JavaScript predicate
 * reading an absent key just gets `undefined` and quietly returns false, which
 * is indistinguishable from a genuine denial. Declaring params turns that
 * silence into a reason.
 */
function checkParams(
  def: ConditionDef,
  merged: ConditionContext,
): ConditionDenied | undefined {
  const params = def.options.params;
  if (params === undefined) return undefined;

  for (const [key, expected] of Object.entries(params)) {
    if (!(key in merged)) {
      return deny(
        `condition ${def.name} needs ${JSON.stringify(key)}, which no tuple or request supplied`,
      );
    }
    const typeError = checkType(def.name, key, merged[key], expected);
    if (typeError !== undefined) return typeError;
  }
  return undefined;
}

function checkType(
  name: string,
  key: string,
  value: unknown,
  expected: ParamType | unknown,
): ConditionDenied | undefined {
  if (typeof expected !== 'string') return undefined;
  if (expected === 'string' || expected === 'number' || expected === 'boolean') {
    if (typeof value === expected) return undefined;
    return deny(
      `condition ${name} expected ${key} to be a ${expected}, got ${describe(value)}`,
    );
  }
  return undefined;
}

function runPredicate(def: ConditionDef, merged: ConditionContext): ConditionOutcome {
  try {
    return def.predicate(merged) ? SATISFIED : deny(`${def.name} returned false`);
  } catch (error) {
    return deny(
      `condition ${def.name} threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Check a tuple's own context against the declared schema at write time.
 *
 * Catching `region: 'eu'` typo'd as `regoin: 'eu'` here is worth far more than
 * discovering at check time that a condition silently denied.
 */
export function validateBoundContext(
  model: Model,
  tuple: Tuple,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const name = tuple.condition;
  if (name === undefined) {
    if (tuple.context !== undefined && Object.keys(tuple.context).length > 0) {
      return { ok: false, reason: 'context was supplied without a condition' };
    }
    return { ok: true };
  }

  const def = model.conditions[name];
  if (def === undefined) return { ok: true };

  const params = def.options.params;
  if (params === undefined) return { ok: true };

  const bound = tuple.context ?? {};
  for (const key of Object.keys(bound)) {
    if (!(key in params)) {
      return {
        ok: false,
        reason: `condition ${name} does not declare a parameter ${JSON.stringify(key)}`,
      };
    }
  }
  for (const [key, expected] of Object.entries(params)) {
    if (!(key in bound)) continue;
    const typeError = checkType(name, key, bound[key], expected);
    if (typeError !== undefined) {
      return { ok: false, reason: typeError.reason.replace('expected', 'bound') };
    }
  }
  return { ok: true };
}
