import { describe, expect, it } from 'vitest';
import {
  type ConditionDenied,
  createAuthz,
  defineCondition,
  defineModel,
  defineType,
  type ExplainNode,
  evaluateTupleCondition,
  mergeContext,
  relation,
  type Tuple,
} from '../src/index.js';
import { model, setup, T } from './fixtures.js';

function flatten(node: ExplainNode): ExplainNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

const owner = (
  subject: string,
  condition?: string,
  context?: Record<string, unknown>,
): Tuple => ({
  subject,
  relation: 'owner',
  resource: 'document:1',
  ...(condition === undefined ? {} : { condition, context }),
});

describe('a condition that holds', () => {
  it('grants a direct edge', async () => {
    const authz = setup([owner('user:alice', 'always')]);
    expect(await authz.can('user:alice', 'document.owner', 'document:1')).toBe(true);
  });

  it('grants when the tuple binds the parameter', async () => {
    const authz = setup([owner('user:alice', 'strict', { region: 'eu' })]);
    expect(await authz.can('user:alice', 'document.owner', 'document:1')).toBe(true);
  });

  it('grants when the request supplies the parameter', async () => {
    const authz = setup([owner('user:alice', 'strict')]);
    expect(
      await authz.check(
        { subject: 'user:alice', permission: 'document.owner', resource: 'document:1' },
        { context: { region: 'eu' } },
      ),
    ).toMatchObject({ allowed: true });
  });

  it('splits across the tuple and the request', async () => {
    // The canonical case: `resourceRegion` is bound by the writer, `userTier`
    // arrives with the request, and the predicate needs both.
    const authz = setup([owner('user:alice', 'inRegion', { resourceRegion: 'eu' })]);
    const request = {
      subject: 'user:alice',
      permission: 'document.owner',
      resource: 'document:1',
    };
    expect(await authz.check(request, { context: { userTier: 'pro' } })).toMatchObject({
      allowed: true,
    });
    expect(await authz.check(request, { context: { userTier: 'free' } })).toMatchObject({
      allowed: false,
    });
  });
});

describe('a condition that does not hold', () => {
  it('denies even though the tuple exists', async () => {
    const authz = setup([owner('user:alice', 'strict', { region: 'us' })]);
    expect(await authz.can('user:alice', 'document.owner', 'document:1')).toBe(false);
  });

  it('denies when the request supplies the wrong value', async () => {
    const authz = setup([owner('user:alice', 'strict')]);
    expect(
      await authz.check(
        { subject: 'user:alice', permission: 'document.owner', resource: 'document:1' },
        { context: { region: 'us' } },
      ),
    ).toMatchObject({ allowed: false });
  });

  it('denies when a declared parameter is supplied by nobody', async () => {
    const authz = setup([owner('user:alice', 'strict')]);
    expect(await authz.can('user:alice', 'document.owner', 'document:1')).toBe(false);
  });

  it('denies when a declared parameter has the wrong type', async () => {
    const authz = setup([owner('user:alice', 'strict', { region: 7 })]);
    expect(await authz.can('user:alice', 'document.owner', 'document:1')).toBe(false);
  });

  it('denies when the predicate throws', async () => {
    const authz = setup([owner('user:alice', 'explodes')]);
    expect(await authz.can('user:alice', 'document.owner', 'document:1')).toBe(false);
  });

  it('denies when the condition is no longer declared by the model', async () => {
    // Stored data can outlive a rename. An unknown condition must not be guessed at.
    const authz = setup([owner('user:alice', 'retired')]);
    expect(await authz.can('user:alice', 'document.owner', 'document:1')).toBe(false);
  });
});

describe('context merge precedence', () => {
  it('lets the tuple win over the request', async () => {
    // If the request could override `region`, a caller could rewrite the
    // constraint the grant was written with, and the condition would be theatre.
    const authz = setup([owner('user:alice', 'strict', { region: 'eu' })]);
    expect(
      await authz.check(
        { subject: 'user:alice', permission: 'document.owner', resource: 'document:1' },
        { context: { region: 'us' } },
      ),
    ).toMatchObject({ allowed: true });
  });

  it('lets the request fill keys the tuple left out', () => {
    expect(mergeContext({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it('treats both sides as optional', () => {
    expect(mergeContext(undefined, undefined)).toEqual({});
    expect(mergeContext({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(mergeContext(undefined, { b: 2 })).toEqual({ b: 2 });
  });

  it('does not let the request mutate the caller objects', () => {
    const request = { a: 1 };
    const bound = { b: 2 };
    mergeContext(request, bound);
    expect(request).toEqual({ a: 1 });
    expect(bound).toEqual({ b: 2 });
  });
});

describe('several tuples, mixed conditional and not', () => {
  it('allows on the one that holds and cites it', async () => {
    const authz = setup([
      owner('user:alice', 'strict', { region: 'us' }),
      owner('user:alice', 'always'),
    ]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.owner',
      resource: 'document:1',
    });
    expect(result.allowed).toBe(true);
    expect(result.tree.tuples).toEqual([owner('user:alice', 'always')]);
  });

  it('denies when no condition holds', async () => {
    const authz = setup([
      owner('user:alice', 'strict', { region: 'us' }),
      owner('user:alice', 'explodes'),
    ]);
    expect(await authz.can('user:alice', 'document.owner', 'document:1')).toBe(false);
  });
});

describe('conditions across edge kinds', () => {
  it('gates a userset expansion', async () => {
    const authz = setup([
      T('team:eng#member', 'editor', 'document:1', { condition: 'always' }),
      T('user:alice', 'member', 'team:eng'),
    ]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
  });

  it('gates a tuple-to-userset parent', async () => {
    const authz = setup([
      T('folder:9', 'parent', 'document:1', { condition: 'always' }),
      T('user:alice', 'viewer', 'folder:9'),
    ]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(true);
  });

  it('gates a wildcard edge', async () => {
    const authz = setup([T('user:*', 'anyone', 'document:1', { condition: 'always' })]);
    expect(await authz.can('user:zoe', 'document.public', 'document:1')).toBe(true);
  });

  it('does not let a satisfied condition rescue a different subject', async () => {
    const authz = setup([
      T('user:alice', 'owner', 'document:1', { condition: 'always' }),
    ]);
    expect(await authz.can('user:bob', 'document.read', 'document:1')).toBe(false);
  });
});

describe('explain', () => {
  it('names the condition and the reason on a denial', async () => {
    const authz = setup([owner('user:alice', 'strict', { region: 'us' })]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.owner',
      resource: 'document:1',
    });
    const condition = flatten(result.tree).find((n) => n.op === 'condition');
    expect(condition?.name).toBe('strict');
    expect(condition?.reason).toMatch(/returned false/);
  });

  it('reports a thrown predicate without letting it escape', async () => {
    const authz = setup([owner('user:alice', 'explodes')]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.owner',
      resource: 'document:1',
    });
    const condition = flatten(result.tree).find((n) => n.op === 'condition');
    expect(condition?.reason).toMatch(/threw: boom/);
  });

  it('reports a missing parameter by name', async () => {
    const authz = setup([owner('user:alice', 'strict')]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.owner',
      resource: 'document:1',
    });
    const condition = flatten(result.tree).find((n) => n.op === 'condition');
    expect(condition?.reason).toMatch(/needs "region"/);
  });

  it('reports a mistyped parameter', async () => {
    const authz = createAuthz({ model, store: setup([]).store, validate: false });
    await authz.write([owner('user:alice', 'strict', { region: 7 })]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.owner',
      resource: 'document:1',
    });
    const condition = flatten(result.tree).find((n) => n.op === 'condition');
    expect(condition?.reason).toMatch(/expected region to be a string/);
  });

  it('reports an undeclared condition', async () => {
    const authz = createAuthz({ model, store: setup([]).store, validate: false });
    await authz.write([owner('user:alice', 'retired')]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.owner',
      resource: 'document:1',
    });
    const condition = flatten(result.tree).find((n) => n.op === 'condition');
    expect(condition?.reason).toMatch(/not declared by the model/);
  });
});

describe('write-time validation of bound context', () => {
  it('rejects a parameter the condition does not declare', async () => {
    const authz = setup();
    await expect(
      authz.grant({
        subject: 'user:alice',
        relation: 'owner',
        resource: 'document:1',
        condition: 'strict',
        context: { regoin: 'eu' },
      }),
    ).rejects.toThrow(/does not declare a parameter "regoin"/);
  });

  it('rejects a bound parameter of the wrong type', async () => {
    const authz = setup();
    await expect(
      authz.grant({
        subject: 'user:alice',
        relation: 'owner',
        resource: 'document:1',
        condition: 'strict',
        context: { region: 7 },
      }),
    ).rejects.toThrow(/bound region to be a string/);
  });

  it('accepts a parameter the condition does not read', async () => {
    // The schema governs what a *tuple* may bind, not everything the predicate
    // touches — `userTier` arrives with the request and is not bound here.
    const authz = setup();
    await expect(
      authz.grant({
        subject: 'user:alice',
        relation: 'owner',
        resource: 'document:1',
        condition: 'inRegion',
        context: { resourceRegion: 'eu' },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects context supplied with no condition', async () => {
    const authz = setup();
    await expect(
      authz.grant({
        subject: 'user:alice',
        relation: 'owner',
        resource: 'document:1',
        context: { region: 'eu' },
      }),
    ).rejects.toThrow(/without a condition/);
  });

  it('accepts any context when the condition declares no params', async () => {
    const authz = setup();
    await expect(
      authz.grant({
        subject: 'user:alice',
        relation: 'owner',
        resource: 'document:1',
        condition: 'always',
        context: { whatever: 'you like', n: 1 },
      }),
    ).resolves.toBeUndefined();
  });

  it('cannot bind context for an unknown condition, because it was never declared', async () => {
    const authz = setup();
    await expect(
      authz.grant({
        subject: 'user:alice',
        relation: 'owner',
        resource: 'document:1',
        condition: 'retired',
        context: { region: 'eu' },
      }),
    ).rejects.toThrow(/is not declared by the model/);
  });
});

describe('a condition with no declared params', () => {
  const looseModel = defineModel({
    types: {
      user: defineType({}),
      doc: defineType({ relations: { owner: relation(['user']) } }),
    },
    conditions: {
      // No `params`, so the predicate may read anything the caller supplies and
      // nothing is checked up front.
      anything: defineCondition('anything', (ctx) => ctx.flag === 'on'),
    },
  });

  it('lets the request satisfy a free-form context', async () => {
    const authz = createAuthz({
      model: looseModel,
      store: setup([]).store,
      validate: false,
    });
    await authz.write([
      { subject: 'user:a', relation: 'owner', resource: 'doc:1', condition: 'anything' },
    ]);
    const request = { subject: 'user:a', permission: 'doc.owner', resource: 'doc:1' };
    expect(await authz.check(request, { context: { flag: 'on' } })).toMatchObject({
      allowed: true,
    });
    expect(await authz.check(request, { context: { flag: 'off' } })).toMatchObject({
      allowed: false,
    });
  });

  it('accepts a bound context it has no schema for', async () => {
    const authz = createAuthz({ model: looseModel, store: setup([]).store });
    await expect(
      authz.grant({
        subject: 'user:a',
        relation: 'owner',
        resource: 'doc:1',
        condition: 'anything',
        context: { anything: 'goes', n: 1 },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('evaluateTupleCondition directly', () => {
  it('treats an unconditioned tuple as satisfied', () => {
    const outcome = evaluateTupleCondition(model, {
      subject: 'user:a',
      relation: 'owner',
      resource: 'document:1',
    });
    expect(outcome).toEqual({ satisfied: true });
  });

  it('carries a reason on every denial', () => {
    const outcome = evaluateTupleCondition(model, {
      subject: 'user:a',
      relation: 'owner',
      resource: 'document:1',
      condition: 'explodes',
    });
    expect(outcome.satisfied).toBe(false);
    expect((outcome as ConditionDenied).reason).toContain('threw: boom');
  });

  it('describes a non-Error throw', () => {
    const weird = defineModel({
      types: {
        user: defineType({}),
        doc: defineType({ relations: { o: relation(['user']) } }),
      },
      conditions: {
        weird: defineCondition('weird', () => {
          throw 'a bare string';
        }),
      },
    });
    const outcome = evaluateTupleCondition(weird, {
      subject: 'user:a',
      relation: 'o',
      resource: 'doc:1',
      condition: 'weird',
    });
    expect((outcome as ConditionDenied).reason).toContain('a bare string');
  });

  it('reports a null, array, or object value without crashing', () => {
    const odd = defineModel({
      types: {
        user: defineType({}),
        doc: defineType({ relations: { o: relation(['user']) } }),
      },
      conditions: {
        typed: defineCondition('typed', () => true, { params: { v: 'string' as const } }),
      },
    });
    for (const v of [null, [1], { a: 1 }, 5]) {
      const outcome = evaluateTupleCondition(odd, {
        subject: 'user:a',
        relation: 'o',
        resource: 'doc:1',
        condition: 'typed',
        context: { v },
      });
      expect(outcome.satisfied).toBe(false);
      expect((outcome as ConditionDenied).reason).toMatch(/to be a string/);
    }
  });

  it('leaves a non-string param descriptor unchecked', () => {
    const untyped = defineModel({
      types: {
        user: defineType({}),
        doc: defineType({ relations: { o: relation(['user']) } }),
      },
      conditions: {
        anyv: defineCondition('anyv', () => true, { params: { v: Object } }),
      },
    });
    const outcome = evaluateTupleCondition(untyped, {
      subject: 'user:a',
      relation: 'o',
      resource: 'doc:1',
      condition: 'anyv',
      context: { v: { anything: true } },
    });
    expect(outcome).toEqual({ satisfied: true });
  });
});
