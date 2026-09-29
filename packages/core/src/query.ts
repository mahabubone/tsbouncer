import { evaluateTupleCondition } from './conditions.js';
import { EvaluationLimitError } from './errors.js';
import { evaluate, resolveMember } from './evaluate.js';
import { Budget, type EvaluationLimits } from './limits.js';
import type { ConditionContext, Model, SetNode, TypeDefinition } from './model.js';
import {
  formatRef,
  type ParsedRef,
  parseRef,
  type RefPosition,
  WILDCARD,
} from './refs.js';
import type { ReadTupleQuery, Tuple, TupleStore } from './store.js';
import {
  difference,
  emptySet,
  intersectionAll,
  type SubjectSet,
  set,
  setOfType,
  unionAll,
} from './subjectset.js';

export interface ExpandResult {
  readonly subjects: readonly string[];
  /** A budget stopped the walk, so this is a lower bound. */
  readonly truncated: boolean;
}

interface QueryCtx {
  readonly model: Model;
  readonly store: TupleStore;
  readonly context: ConditionContext | undefined;
  readonly budget: Budget;
  truncated: boolean;
}

function createCtx(
  model: Model,
  store: TupleStore,
  context: ConditionContext | undefined,
  limits: EvaluationLimits,
): QueryCtx {
  return { model, store, context, budget: new Budget(limits), truncated: false };
}

/** Spend a node from the budget, recording truncation rather than throwing. */
function charge(ctx: QueryCtx, depth: number): boolean {
  try {
    ctx.budget.node();
    ctx.budget.depth(depth);
    return true;
  } catch (error) {
    if (error instanceof EvaluationLimitError) {
      ctx.truncated = true;
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// expand
// ---------------------------------------------------------------------------

/**
 * Expand a subject into the concrete subjects it contains.
 *
 * A userset is a membership edge, so expanding one is a graph closure over
 * membership tuples and nothing else — no permission algebra, and therefore no
 * symbolic answers.
 *
 * The result is the *leaves*: the direct subjects, not the intermediate usersets
 * on the way there. "Who does this group grant cover" is the question that gets
 * asked, and answering it with a list that starts with the thing you passed in
 * is not an answer. A wildcard is a leaf and stays symbolic, because "every
 * user" has no finite enumeration and a truncated list of one would be a lie.
 */
export async function expandSubjects(
  model: Model,
  store: TupleStore,
  subject: string,
  limits: EvaluationLimits,
): Promise<ExpandResult> {
  const ctx = createCtx(model, store, undefined, limits);
  const found = new Set<string>();
  const seen = new Set<string>();
  await walkSubject(ctx, parseRef(subject, 'subject'), found, seen, 0);
  return Object.freeze({
    subjects: Object.freeze([...found].sort()),
    truncated: ctx.truncated,
  });
}

/**
 * The transitive membership closure of a subject.
 *
 * `found` doubles as the `seen` set, which is what stops a team graph with a
 * cycle from looping; the budget is what stops a wide one from taking the
 * request down.
 */
async function walkSubject(
  ctx: QueryCtx,
  ref: ParsedRef,
  found: Set<string>,
  seen: Set<string>,
  depth: number,
): Promise<void> {
  if (!charge(ctx, depth)) return;
  const key = formatRef(ref);

  if (ref.relation === undefined) {
    if (!found.has(key)) found.add(key);
    return;
  }

  // A userset is a step, not an answer. Guarding on the seen set here is what
  // stops a membership cycle from looping.
  if (seen.has(key)) return;
  seen.add(key);
  const page = await read(ctx, {
    relation: ref.relation,
    resource: `${ref.type}:${ref.id}`,
  });
  for (const tuple of page) {
    const next = tryRef(tuple.subject, 'subject');
    if (next !== undefined) await walkSubject(ctx, next, found, seen, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// listResources
// ---------------------------------------------------------------------------

/**
 * A list that knows whether it is the whole truth.
 *
 * A bare array cannot say "these are some of them". Budget exhaustion part-way
 * through the enumeration would otherwise look identical to a small result
 * set, and a caller treating the short list as authoritative under-grants
 * silently. `truncated` is the difference between "here is everything" and
 * "here is what fit".
 */
export interface ResourceList {
  readonly resources: readonly string[];
  readonly truncated: boolean;
}

export interface ListResourcesInput {
  readonly subject: string;
  readonly member: string;
  readonly resourceType: string;
  readonly context?: ConditionContext | undefined;
}

/**
 * Everything `subject` could possibly hold `member` on.
 *
 * This enumerates *candidates* and then asks the evaluator about each one,
 * rather than inverting the permission algebra. Inversion is the research-hard
 * direction — that is what `listSubjects` is, and why it can return a symbolic
 * set — whereas enumerate-and-check is exact, and the budget is what bounds it.
 */
export async function listResources(
  model: Model,
  store: TupleStore,
  input: ListResourcesInput,
  limits: EvaluationLimits,
): Promise<ResourceList> {
  const ctx = createCtx(model, store, input.context, limits);
  if (model.types[input.resourceType] === undefined) {
    return Object.freeze({ resources: Object.freeze([]), truncated: false });
  }

  const subject = parseRef(input.subject, 'subject');
  const candidates = await candidateResources(ctx, subject, input.resourceType);
  const allowed: string[] = [];

  for (const resource of candidates) {
    try {
      const outcome = await evaluate({
        model,
        store,
        subject,
        member: input.member,
        resource: parseRef(resource, 'object'),
        context: input.context,
        limits,
      });
      if (outcome.allowed) allowed.push(resource);
    } catch (error) {
      if (error instanceof EvaluationLimitError) {
        ctx.truncated = true;
        continue;
      }
      throw error;
    }
  }

  return Object.freeze({
    resources: Object.freeze(allowed.sort()),
    truncated: ctx.truncated,
  });
}

/**
 * A superset of the resources `subject` might hold the member on.
 *
 * Two sources: tuples the subject is party to, and — because a
 * tuple-to-userset lets access flow *down* a tree — every object whose `through`
 * relation points at one of those. Walking that second edge is what makes
 * inherited access findable at all.
 */
async function candidateResources(
  ctx: QueryCtx,
  subject: ParsedRef,
  resourceType: string,
): Promise<Set<string>> {
  // Every object the subject is party to, of *any* type. Filtering to the
  // requested type here would be wrong: inherited access reaches a document
  // through a folder, and the folder has to stay in the walk to get there.
  const found = new Set<string>();
  const queue: string[] = [];

  const consider = (key: string): void => {
    if (found.has(key)) return;
    found.add(key);
    queue.push(key);
  };

  for (const member of await membershipClosure(ctx, subject)) {
    const ref = tryRef(member, 'subject');
    if (ref === undefined) continue;
    // One read covering the subject *and* the wildcard edge of its type, so
    // `user:* anyone document:9` is a candidate for alice even though the tuple
    // never mentions her. Same trick the evaluator uses.
    for (const tuple of await read(ctx, {
      subject: [member, `${ref.type}:${WILDCARD}`],
    })) {
      const resource = tryRef(tuple.resource, 'object');
      if (resource !== undefined) consider(formatRef(resource));
    }
  }

  // Tuples written against a *set* the subject belongs to. `team:eng#member
  // editor document:3` grants to alice through her membership, and the read
  // above cannot see it because alice is not that tuple's subject.
  //
  // There is no index for "subjects that are usersets" in the store contract, so
  // this reads the whole store. That is expensive, and the budget is what keeps
  // it bounded — but a `listResources` that quietly omits access the subject
  // really has is worse than an expensive one, because a UI built on it would
  // hide things the user can open.
  await collectSetGrants(ctx, subject, consider);

  // Walk the `through` edges in both directions across every type touched, so a
  // document four edges below an ancestor is still found.
  const seenThroughs = new Set<string>();
  while (queue.length > 0) {
    if (!charge(ctx, 0)) break;
    const known = queue.shift();
    if (known === undefined) break;
    const ref = tryRef(known, 'object');
    if (ref === undefined) continue;

    for (const [relation, accepted] of inheritedInto(ctx.model, ref.type)) {
      const token = `${ref.type}:${relation}`;
      if (seenThroughs.has(token)) continue;
      seenThroughs.add(token);

      // Objects that inherit *from* this one.
      for (const tuple of await read(ctx, { subject: known, relation })) {
        const child = tryRef(tuple.resource, 'object');
        if (child !== undefined && accepted.includes(child.type)) {
          consider(formatRef(child));
        }
      }
      // And what this one itself inherited from, so the walk can go up as well
      // as down and a cycle cannot hide anything.
      for (const tuple of await read(ctx, { relation, resource: known })) {
        const parent = tryRef(tuple.subject, 'subject');
        if (parent !== undefined && parent.relation === undefined) {
          consider(formatRef(parent));
        }
      }
    }
  }

  const result = new Set<string>();
  for (const key of found) {
    const ref = tryRef(key, 'object');
    if (ref !== undefined && ref.type === resourceType) result.add(key);
  }
  return result;
}

/**
 * Resources reachable only through a userset the subject belongs to.
 *
 * Grouped by userset first, so each set is expanded once rather than once per
 * tuple that names it.
 */
async function collectSetGrants(
  ctx: QueryCtx,
  subject: ParsedRef,
  consider: (key: string) => void,
): Promise<void> {
  const wanted = formatRef(subject);
  const bySet = new Map<string, Set<string>>();

  for (const tuple of await read(ctx, {})) {
    const ref = tryRef(tuple.subject, 'subject');
    if (ref === undefined || ref.relation === undefined) continue;
    const resource = tryRef(tuple.resource, 'object');
    if (resource === undefined) continue;
    const key = formatRef(ref);
    const bucket = bySet.get(key) ?? new Set<string>();
    bucket.add(formatRef(resource));
    bySet.set(key, bucket);
  }

  for (const [set, resources] of bySet) {
    if (!charge(ctx, 0)) return;
    const ref = tryRef(set, 'subject');
    if (ref === undefined) continue;
    const members = new Set<string>();
    const seen = new Set<string>();
    await walkSubject(ctx, ref, members, seen, 0);
    if (!members.has(wanted)) continue;
    for (const resource of resources) consider(resource);
  }
}

/**
 * Every subject to look for tuples under: the subject itself, plus every leaf
 * reachable through its memberships.
 *
 * The subject is kept even when it is a userset. Dropping it would mean asking
 * "what can this team see?" silently loses every tuple written against
 * `team:eng#member`, which is precisely the grant being asked about.
 */
async function membershipClosure(ctx: QueryCtx, subject: ParsedRef): Promise<string[]> {
  const self = formatRef(subject);
  if (subject.relation === undefined) return [self];
  const found = new Set<string>();
  const seen = new Set<string>();
  await walkSubject(ctx, subject, found, seen, 0);
  return [self, ...found];
}

/**
 * Every `through` relation reachable from a type, with the types it can point at.
 *
 * Read from the model rather than hardcoded, so a new tuple-to-userset is picked
 * up here without touching the query layer.
 */
export function throughRelations(model: Model, typeName: string): [string, string[]][] {
  const type: TypeDefinition | undefined = model.types[typeName];
  if (type === undefined) return [];

  const found = new Map<string, Set<string>>();
  // A tuple-to-userset is usually declared in a permission, so scanning only the
  // relations finds nothing in most real models.
  for (const node of Object.values({ ...type.relations, ...type.permissions })) {
    for (const inner of walkNodes(node)) {
      if (inner.kind !== 'ttu') continue;
      const edge = type.relations[inner.through];
      if (edge === undefined) continue;
      const targets = found.get(inner.through) ?? new Set<string>();
      for (const direct of directTypes(model, typeName, edge)) targets.add(direct);
      found.set(inner.through, targets);
    }
  }
  return [...found.entries()].map(([relation, types]) => [relation, [...types]]);
}

/**
 * The edges that flow *toward* objects of a type — the reverse of
 * `throughRelations`.
 *
 * `throughRelations(model, 'document')` answers "what can a document inherit
 * from", which is useless for finding a document that inherits from a folder.
 * That direction needs the *child* type's `through` relation: `document.parent`
 * accepts a `folder`, so a folder can be walked to the documents beneath it.
 * Getting these the wrong way round silently finds nothing, which is why both
 * are built from the model rather than assumed.
 */
export function inheritedInto(model: Model, typeName: string): [string, string[]][] {
  const found = new Map<string, Set<string>>();

  for (const [name, type] of Object.entries(model.types)) {
    for (const node of Object.values({ ...type.relations, ...type.permissions })) {
      for (const inner of walkNodes(node)) {
        if (inner.kind !== 'ttu') continue;
        const edge = type.relations[inner.through];
        if (edge === undefined) continue;
        for (const direct of directTypes(model, name, edge)) {
          if (direct !== typeName) continue;
          const children = found.get(inner.through) ?? new Set<string>();
          children.add(name);
          found.set(inner.through, children);
        }
      }
    }
  }

  return [...found.entries()].map(([relation, types]) => [relation, [...types]]);
}

function walkNodes(node: SetNode): SetNode[] {
  switch (node.kind) {
    case 'union':
    case 'intersection':
      return node.children.flatMap(walkNodes);
    case 'exclusion':
      return [node, ...walkNodes(node.base), ...walkNodes(node.subtract)];
    default:
      return [node];
  }
}

/**
 * The object types a relation edge points at, following `computed`.
 *
 * A relation is allowed to delegate to another member of its own type, so a
 * `computed` edge is followed rather than treated as a dead end. Without the
 * model there is no way to resolve one, which is why this takes the model even
 * though most edges are plain `direct` nodes.
 */
function directTypes(
  model: Model,
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
        ...new Set(node.children.flatMap((c) => directTypes(model, typeName, c, seen))),
      ];
    case 'exclusion':
      return directTypes(model, typeName, node.base, seen);
    case 'computed': {
      const key = `${typeName}#${node.name}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const type: TypeDefinition | undefined = model.types[typeName];
      const target = type?.relations[node.name];
      return target === undefined ? [] : directTypes(model, typeName, target, seen);
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// listSubjects
// ---------------------------------------------------------------------------

export interface ListSubjectsInput {
  readonly member: string;
  readonly resource: string;
  readonly resourceType: string;
  readonly context?: ConditionContext | undefined;
}

/**
 * Who holds `member` on `resource`?
 *
 * This walks the expression tree backwards from the resource, so it is the hard
 * direction. A wildcard edge expands to a symbolic type, and an intersection or
 * exclusion can produce a set that is not finitely enumerable. The result is a
 * `SubjectSet` rather than an array precisely so a symbolic answer is
 * representable, instead of being quietly truncated into a list that looks
 * complete.
 */
export async function listSubjects(
  model: Model,
  store: TupleStore,
  input: ListSubjectsInput,
  limits: EvaluationLimits,
): Promise<SubjectSet> {
  const ctx = createCtx(model, store, input.context, limits);
  const resource = parseRef(input.resource, 'object');
  const node = resolveMember(model, input.resourceType, input.member);
  const result = await expand(ctx, node, resource, input.member, 0);
  return Object.freeze({ ...result, truncated: ctx.truncated || result.truncated });
}

async function expand(
  ctx: QueryCtx,
  node: SetNode,
  resource: ParsedRef,
  member: string,
  depth: number,
): Promise<SubjectSet> {
  if (!charge(ctx, depth)) return emptySet(true);

  switch (node.kind) {
    case 'direct': {
      const found = await expandDirect(ctx, node, resource, member);
      // A stored `user:*` tuple means *every* subject of the type, not a list of
      // them, so the answer stays symbolic.
      //
      // `node.wildcard` — the edge being *declared* wildcard — deliberately does
      // **not** contribute here. It says the relation accepts a `user:*` subject;
      // it does not say every user is already a member. Including it made this
      // path disagree with `can` on the ordinary ban-list model: with
      // `banned: relation('user').or(wildcard('user'))` and no `banned` tuple,
      // `can` said allowed and `listSubjects` said nobody, so an access list
      // disagreed with the decisions it was supposed to summarise. A ban relation
      // is the common case, and it is how a "banned" row is allowed to be absent.
      if (found.wildcard) {
        return unionAll([setOfType(node.type), found.value]);
      }
      return found.value;
    }

    case 'userset': {
      const parts: SubjectSet[] = [];
      for (const tuple of await read(ctx, {
        relation: member,
        resource: formatRef(resource),
      })) {
        const ref = tryRef(tuple.subject, 'subject');
        if (ref === undefined || ref.type !== node.type || ref.relation !== node.relation)
          continue;
        if (!usable(ctx, tuple)) continue;
        const inner: ParsedRef = { type: ref.type, id: ref.id };
        parts.push(
          await expand(
            ctx,
            resolveMember(ctx.model, inner.type, node.relation),
            inner,
            node.relation,
            depth + 1,
          ),
        );
      }
      return unionAll(parts);
    }

    case 'computed':
      return expand(
        ctx,
        resolveMember(ctx.model, resource.type, node.name),
        resource,
        node.name,
        depth + 1,
      );

    case 'ttu': {
      const parts: SubjectSet[] = [];
      for (const tuple of await read(ctx, {
        relation: node.through,
        resource: formatRef(resource),
      })) {
        const ref = tryRef(tuple.subject, 'subject');
        if (ref === undefined || ref.relation !== undefined) continue;
        if (!usable(ctx, tuple)) continue;
        parts.push(
          await expand(
            ctx,
            resolveMember(ctx.model, ref.type, node.target),
            ref,
            node.target,
            depth + 1,
          ),
        );
      }
      return unionAll(parts);
    }

    case 'union': {
      const parts: SubjectSet[] = [];
      for (const child of node.children)
        parts.push(await expand(ctx, child, resource, member, depth + 1));
      return unionAll(parts);
    }

    case 'intersection': {
      const parts: SubjectSet[] = [];
      for (const child of node.children)
        parts.push(await expand(ctx, child, resource, member, depth + 1));
      return intersectionAll(parts);
    }

    case 'exclusion': {
      const base = await expand(ctx, node.base, resource, member, depth + 1);
      const subtract = await expand(ctx, node.subtract, resource, member, depth + 1);
      return difference(base, subtract);
    }
  }
}

interface DirectExpansion {
  readonly value: SubjectSet;
  readonly wildcard: boolean;
}

async function expandDirect(
  ctx: QueryCtx,
  node: Extract<SetNode, { kind: 'direct' }>,
  resource: ParsedRef,
  member: string,
): Promise<DirectExpansion> {
  const members: string[] = [];
  let wildcard = false;

  for (const tuple of await read(ctx, {
    relation: member,
    resource: formatRef(resource),
  })) {
    if (!usable(ctx, tuple)) continue;
    const ref = tryRef(tuple.subject, 'subject');
    if (ref === undefined || ref.type !== node.type) continue;
    // A userset subject on a direct edge is a rewrite, and the `userset` node
    // owns those. Counting it here too would double-count the expansion.
    if (ref.relation !== undefined) continue;
    if (ref.id === WILDCARD) {
      wildcard = true;
      continue;
    }
    members.push(formatRef(ref));
  }

  return { value: set(members, ctx.truncated), wildcard };
}

/**
 * A conditional tuple whose condition does not hold grants nobody.
 *
 * The engine owns condition evaluation, so this defers to it rather than
 * reimplementing the tuple/request merge — a second implementation would be a
 * second set of rules to keep in step.
 */
function usable(ctx: QueryCtx, tuple: Tuple): boolean {
  if (tuple.condition === undefined) return true;
  return evaluateTupleCondition(ctx.model, tuple, ctx.context).satisfied;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function read(ctx: QueryCtx, q: ReadTupleQuery): Promise<readonly Tuple[]> {
  if (!charge(ctx, 0)) return [];
  const page = await ctx.store.read(q);
  return page.items;
}

function tryRef(input: string, position: RefPosition = 'any'): ParsedRef | undefined {
  try {
    return parseRef(input, position);
  } catch {
    return undefined;
  }
}
