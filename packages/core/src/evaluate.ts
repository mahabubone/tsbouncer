import { evaluateTupleCondition } from './conditions.js';
import { EvaluationLimitError } from './errors.js';
import type { ExplainNode, ExplainOp } from './explain.js';
import { Budget, type EvaluationLimits } from './limits.js';
import type { ConditionContext, Model, SetNode } from './model.js';
import {
  formatRef,
  type ParsedRef,
  parseRef,
  type RefPosition,
  WILDCARD,
} from './refs.js';
import type { ReadTupleQuery, Tuple, TupleStore } from './store.js';

export interface EvaluationRequest {
  readonly model: Model;
  readonly store: TupleStore;
  readonly subject: ParsedRef;
  /** Relation or permission name on the resource's type. */
  readonly member: string;
  readonly resource: ParsedRef;
  readonly context?: ConditionContext | undefined;
  readonly limits: EvaluationLimits;
}

export interface EvaluationOutcome {
  readonly allowed: boolean;
  readonly tree: ExplainNode;
  readonly reads: number;
}

interface Ctx {
  readonly model: Model;
  readonly store: TupleStore;
  readonly subjectRef: string;
  readonly subjectType: string;
  readonly budget: Budget;
  readonly context: ConditionContext | undefined;
  /**
   * Per-request memo, keyed `subject#member@resource`.
   *
   * Scoped to a single `evaluate` call, so `withStore(trx)` — which builds a new
   * client — can never read a result computed against another store. A memo that
   * outlived a store swap is the subtlest bug this design can produce.
   */
  readonly memo: Map<string, Outcome>;
  /** Member keys currently on the stack, for cycle detection. */
  readonly active: Set<string>;
  reads: number;
}

interface Outcome {
  readonly allowed: boolean;
  readonly tree: ExplainNode;
}

/**
 * Evaluate `subject` against `member` on `resource`.
 *
 * This is the whole engine. It never throws for a data condition: an exhausted
 * budget, a cycle, an unevaluated condition, and a missing tuple all resolve to
 * *not allowed*. A decision this library cannot make must never be the
 * permissive one.
 */
export async function evaluate(request: EvaluationRequest): Promise<EvaluationOutcome> {
  const ctx: Ctx = {
    model: request.model,
    store: request.store,
    subjectRef: formatRef(request.subject),
    subjectType: request.subject.type,
    budget: new Budget(request.limits),
    context: request.context,
    memo: new Map(),
    active: new Set(),
    reads: 0,
  };

  const node = resolveMember(request.model, request.resource.type, request.member);
  const outcome = await visit(ctx, node, request.resource, request.member, 0);
  return { allowed: outcome.allowed, tree: outcome.tree, reads: ctx.reads };
}

/** Look up a relation or permission, throwing if the model does not declare it. */
export function resolveMember(model: Model, typeName: string, member: string): SetNode {
  const type = model.types[typeName];
  const found = type?.relations[member] ?? type?.permissions[member];
  if (found === undefined) {
    throw new Error(
      `type ${typeName} declares no relation or permission named ${JSON.stringify(member)}`,
    );
  }
  return found;
}

/**
 * Evaluate one *member* — a relation or permission — and cache the answer.
 *
 * Exactly one memo frame is opened per member, at its top-level node. The
 * structural nodes inside a member's expression (`union`, `intersection`,
 * `exclusion`) are walked by `step` and deliberately do **not** open frames.
 *
 * Keying every node individually looks tidier and is wrong: an exclusion's base
 * would inherit the exclusion's own key, `editor = user | team#member` would
 * collide with itself, and the cycle guard would deny access that plainly
 * exists. A member's answer is a pure function of `(subject, member, resource)`,
 * so one frame per member is both the simplest and the only correct granularity.
 */
async function visit(
  ctx: Ctx,
  node: SetNode,
  resource: ParsedRef,
  member: string,
  depth: number,
): Promise<Outcome> {
  const key = `${ctx.subjectRef}#${member}@${formatRef(resource)}`;

  const memoized = ctx.memo.get(key);
  if (memoized !== undefined) return memoized;

  if (ctx.active.has(key)) {
    return {
      allowed: false,
      tree: trace('cycle', false, { reason: `re-entered ${key}` }),
    };
  }

  ctx.active.add(key);
  try {
    ctx.budget.node();
    ctx.budget.depth(depth);
    const outcome = await step(ctx, node, resource, member, depth);
    ctx.memo.set(key, outcome);
    return outcome;
  } catch (error) {
    if (error instanceof EvaluationLimitError) {
      return {
        allowed: false,
        tree: trace('limit', false, { limit: error.limit, reason: error.message }),
      };
    }
    throw error;
  } finally {
    ctx.active.delete(key);
  }
}

async function step(
  ctx: Ctx,
  node: SetNode,
  resource: ParsedRef,
  member: string,
  depth: number,
): Promise<Outcome> {
  switch (node.kind) {
    case 'direct':
      return direct(ctx, node, resource, member);

    case 'userset':
      return userset(ctx, node, resource, member, depth);

    case 'computed': {
      // A reference to another member. Resolving it here — rather than letting
      // `visit` receive the reference — keeps the invariant that `visit` only
      // ever holds a resolved member node, so the key it takes is always the name
      // of the member actually being evaluated.
      const target = resolveMember(ctx.model, resource.type, node.name);
      const child = await visit(ctx, target, resource, node.name, depth + 1);
      return {
        allowed: child.allowed,
        tree: trace('computed', child.allowed, {
          name: node.name,
          children: [child.tree],
        }),
      };
    }

    case 'ttu':
      return tupleToUserset(ctx, node, resource, depth);

    case 'union': {
      const children: ExplainNode[] = [];
      for (const child of node.children) {
        const result = await step(ctx, child, resource, member, depth + 1);
        children.push(result.tree);
        if (result.allowed)
          return { allowed: true, tree: trace('union', true, { children }) };
      }
      return { allowed: false, tree: trace('union', false, { children }) };
    }

    case 'intersection': {
      // Every child is evaluated, even once one has failed, so the trace
      // explains the whole expression instead of stopping at the first miss.
      const children: ExplainNode[] = [];
      let allowed = true;
      for (const child of node.children) {
        const result = await step(ctx, child, resource, member, depth + 1);
        children.push(result.tree);
        if (!result.allowed) allowed = false;
      }
      return { allowed, tree: trace('intersection', allowed, { children }) };
    }

    case 'exclusion': {
      // Both sides are always evaluated. Returning early on a satisfied base is
      // the bug this shape exists to prevent: `(a and b) except banned` would
      // then allow exactly the case the `except` was written to deny.
      const base = await step(ctx, node.base, resource, member, depth + 1);
      const subtract = await step(ctx, node.subtract, resource, member, depth + 1);
      const allowed = base.allowed && !subtract.allowed;
      return {
        allowed,
        tree: trace('exclusion', allowed, { children: [base.tree, subtract.tree] }),
      };
    }
  }
}

async function direct(
  ctx: Ctx,
  node: Extract<SetNode, { kind: 'direct' }>,
  resource: ParsedRef,
  member: string,
): Promise<Outcome> {
  if (ctx.subjectType !== node.type) {
    return {
      allowed: false,
      tree: trace('direct', false, {
        reason: `relation ${member} accepts a ${node.type}, but the subject is a ${ctx.subjectType}`,
      }),
    };
  }

  // A wildcard edge (`user:*`) grants to every subject of that type, so one read
  // asks for the exact subject *or* the wildcard. This is what a multi-value
  // filter is for; the stores build it as an OR of per-reference ANDs, so it can
  // never match a userset row by pairing one reference's type with another's id.
  const query: ReadTupleQuery = {
    subject: [ctx.subjectRef, `${node.type}:${WILDCARD}`],
    relation: member,
    resource: formatRef(resource),
  };

  const page = await read(ctx, query);
  const split = splitByCondition(ctx, page);

  if (split.satisfied.length > 0) {
    return {
      allowed: true,
      tree: trace('direct', true, {
        query,
        tuples: split.satisfied,
        children: split.failed,
      }),
    };
  }
  return {
    allowed: false,
    tree: trace('direct', false, { query, children: split.failed, reason: split.reason }),
  };
}

/**
 * Partition a page of tuples into the ones that hold and the ones that do not.
 *
 * Every edge kind downstream needs the same three answers: which tuples justified
 * an allow, which ones explain a denial, and one sentence saying why nothing did.
 * Doing it in one place is what keeps `direct`, `userset`, and the
 * tuple-to-userset from drifting apart on what "conditional" means.
 */
function splitByCondition(
  ctx: Ctx,
  tuples: readonly Tuple[],
): { satisfied: Tuple[]; failed: ExplainNode[]; reason: string } {
  const satisfied: Tuple[] = [];
  const failed: ExplainNode[] = [];

  for (const tuple of tuples) {
    const outcome = evaluateTupleCondition(ctx.model, tuple, ctx.context);
    if (outcome.satisfied) {
      satisfied.push(tuple);
    } else {
      failed.push(
        trace('condition', false, { name: tuple.condition, reason: outcome.reason }),
      );
    }
  }

  let reason = 'no matching tuples';
  if (tuples.length > 0 && failed.length > 0) {
    reason = 'every matching tuple is conditional and none of its conditions hold';
  }
  return { satisfied, failed, reason };
}

async function userset(
  ctx: Ctx,
  node: Extract<SetNode, { kind: 'userset' }>,
  resource: ParsedRef,
  member: string,
  depth: number,
): Promise<Outcome> {
  // Tuples written for (relation, resource) name their usersets directly, so
  // this is a targeted read off the (relation, resource) index, not a scan.
  const query: ReadTupleQuery = { relation: member, resource: formatRef(resource) };
  const page = await read(ctx, query);

  // A conditional userset tuple gates the whole expansion, so it is held to the
  // same condition as the direct edge rather than being skipped outright.
  const split = splitByCondition(ctx, page);

  const candidates = split.satisfied
    .map((t) => ({ tuple: t, ref: tryRef(t.subject) }))
    .filter(
      (c): c is { tuple: Tuple; ref: ParsedRef } =>
        c.ref !== undefined &&
        c.ref.type === node.type &&
        c.ref.relation === node.relation,
    );

  if (candidates.length === 0) {
    return {
      allowed: false,
      tree: trace('userset', false, {
        query,
        children: split.failed,
        reason:
          page.length > 0
            ? 'no tuple names a matching userset whose condition holds'
            : `no tuple names a ${node.type}#${node.relation} subject`,
      }),
    };
  }

  const children: ExplainNode[] = [];
  for (const candidate of candidates) {
    // Recurse into the candidate's *object*, stripping the `#relation`. The
    // relation being tested lives on `team:eng`, not on `team:eng#member`;
    // keeping the suffix would search for tuples about the userset and find none.
    // The `userset` node already cites the tuple that named this candidate.
    const inner: ParsedRef = { type: candidate.ref.type, id: candidate.ref.id };
    const memberNode = resolveMember(ctx.model, inner.type, node.relation);
    const result = await visit(ctx, memberNode, inner, node.relation, depth + 1);
    children.push(result.tree);
    if (result.allowed) {
      return {
        allowed: true,
        tree: trace('userset', true, { query, children, tuples: [candidate.tuple] }),
      };
    }
  }
  return {
    allowed: false,
    tree: trace('userset', false, {
      query,
      children: [...children, ...split.failed],
    }),
  };
}

/**
 * Tuple-to-userset: follow `through` to a related object, then take `target` on
 * it. The Zanzibar form is `parent.folder#viewer`.
 *
 * This is a close cousin of a userset edge, and confusing the two is the bug
 * class here. Both issue the same read — tuples for `(relation, this object)` —
 * and both recurse into each tuple's **subject**. They differ in what that
 * subject means:
 *
 *   userset  the subject is a userset (`team:eng#member`): strip the `#relation`
 *            and re-enter that object under the relation the userset named.
 *   ttu      the subject is a plain object (`folder:9`): re-enter it under
 *            `target`, resolved against whatever type that object turns out to
 *            be, so a multi-type `through` needs no help from the model.
 *
 * The subject is what is traversed in both cases. Reading the *resource* here
 * would walk back up the edge and re-test the object we started from, which
 * silently denies every real grant.
 */
async function tupleToUserset(
  ctx: Ctx,
  node: Extract<SetNode, { kind: 'ttu' }>,
  resource: ParsedRef,
  depth: number,
): Promise<Outcome> {
  const query: ReadTupleQuery = { relation: node.through, resource: formatRef(resource) };
  const page = await read(ctx, query);

  // A conditional parent tuple gates the inheritance, so it is held to the same
  // condition as every other edge.
  const split = splitByCondition(ctx, page);

  const parents = split.satisfied
    .map((t) => ({ tuple: t, ref: tryRef(t.subject, 'subject') }))
    .filter(
      (c): c is { tuple: Tuple; ref: ParsedRef } =>
        // A traversal subject is a plain object. A userset here would make the
        // tuple a subject-rewrite, which is the `userset` node's job.
        c.ref !== undefined && c.ref.relation === undefined,
    );

  if (parents.length === 0) {
    return {
      allowed: false,
      tree: trace('ttu', false, {
        through: node.through,
        target: node.target,
        query,
        children: split.failed,
        reason:
          page.length > 0
            ? 'no traversable parent: the subject is a userset or its condition does not hold'
            : `no ${node.through} tuple for this object`,
      }),
    };
  }

  const children: ExplainNode[] = [];
  for (const parent of parents) {
    // The target is resolved against each parent's *own* type, so a multi-type
    // `through` relation works without the model having to say which it meant.
    const targetNode = resolveMember(ctx.model, parent.ref.type, node.target);
    const result = await visit(ctx, targetNode, parent.ref, node.target, depth + 1);
    children.push(result.tree);
    if (result.allowed) {
      return {
        allowed: true,
        tree: trace('ttu', true, {
          through: node.through,
          target: node.target,
          query,
          children: [...children, ...split.failed],
          tuples: [parent.tuple],
        }),
      };
    }
  }
  return {
    allowed: false,
    tree: trace('ttu', false, {
      through: node.through,
      target: node.target,
      query,
      children,
    }),
  };
}

async function read(ctx: Ctx, query: ReadTupleQuery): Promise<readonly Tuple[]> {
  ctx.budget.node();
  const page = await ctx.store.read(query);
  ctx.reads += 1;
  return page.items;
}

function tryRef(input: string, position: RefPosition = 'any'): ParsedRef | undefined {
  try {
    return parseRef(input, position);
  } catch {
    return undefined;
  }
}

function trace(
  op: ExplainOp,
  result: boolean,
  extra: Partial<ExplainNode> = {},
): ExplainNode {
  return {
    op,
    result,
    children: extra.children ?? [],
    tuples: extra.tuples ?? [],
    query: extra.query,
    name: extra.name,
    through: extra.through,
    target: extra.target,
    limit: extra.limit,
    reason: extra.reason,
  };
}
