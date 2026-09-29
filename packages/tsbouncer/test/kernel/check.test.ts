import { describe, expect, it } from 'vitest';
import {
  createAuthz,
  DEFAULT_LIMITS,
  defineModel,
  defineType,
  evaluate,
  parseRef,
  relation,
  wildcard,
} from '../../src/kernel/index.js';
import { model, setup, T } from './fixtures.js';
import { testStore } from './store.js';

describe('direct edges', () => {
  it('allows a subject with a matching tuple', async () => {
    const authz = setup([T('user:alice', 'owner', 'document:1')]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
  });

  it('denies a subject without one', async () => {
    const authz = setup([T('user:alice', 'owner', 'document:1')]);
    expect(await authz.can('user:bob', 'document.read', 'document:1')).toBe(false);
  });

  it('does not leak across resources', async () => {
    const authz = setup([T('user:alice', 'owner', 'document:1')]);
    expect(await authz.can('user:alice', 'document.read', 'document:2')).toBe(false);
  });

  it('resolves a relation directly, not only through a permission', async () => {
    const authz = setup([T('user:alice', 'owner', 'document:1')]);
    expect(await authz.can('user:alice', 'document.owner', 'document:1')).toBe(true);
  });

  it('rejects a subject whose type the relation does not accept', async () => {
    const authz = setup([T('user:alice', 'owner', 'document:1')]);
    expect(await authz.can('team:eng', 'document.owner', 'document:1')).toBe(false);
  });
});

describe('userset edges', () => {
  const teamTuple = T('team:eng#member', 'editor', 'document:1');
  const membership = T('user:alice', 'member', 'team:eng');

  it('grants through a userset tuple', async () => {
    const authz = setup([teamTuple, membership]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
  });

  it('denies a non-member', async () => {
    const authz = setup([teamTuple, membership]);
    expect(await authz.can('user:bob', 'document.read', 'document:1')).toBe(false);
  });

  it('does not treat the userset itself as a member of itself', async () => {
    const authz = setup([teamTuple, membership]);
    expect(await authz.can('team:eng', 'document.read', 'document:1')).toBe(false);
  });

  it('does not confuse a direct team subject with a userset subject', async () => {
    // `document.viewer` is a *direct* team edge, so `team:eng viewer document:1`
    // grants the team object, not its members. `folder.viewer` is a *userset*
    // edge, so `team:eng#member viewer folder:9` grants the members. Opposite
    // meaning for the same relation name — the confusion worth testing.
    const directTeam = setup([
      T('team:eng', 'viewer', 'document:1'),
      T('user:alice', 'member', 'team:eng'),
    ]);
    expect(await directTeam.can('user:alice', 'document.read', 'document:1')).toBe(false);
    expect(await directTeam.can('team:eng', 'document.read', 'document:1')).toBe(true);

    const usersetTeam = setup([
      T('team:eng#member', 'viewer', 'folder:9'),
      T('user:alice', 'member', 'team:eng'),
    ]);
    expect(await usersetTeam.can('user:alice', 'folder.read', 'folder:9')).toBe(true);
  });

  it('grants members through a userset tuple', async () => {
    const authz = setup([
      T('team:eng#member', 'viewer', 'folder:9'),
      T('user:alice', 'member', 'team:eng'),
    ]);
    expect(await authz.can('user:alice', 'folder.read', 'folder:9')).toBe(true);
    expect(await authz.can('user:bob', 'folder.read', 'folder:9')).toBe(false);
  });

  it('ignores a userset naming a relation the model does not declare', async () => {
    const authz = setup([T('team:eng#ghost', 'editor', 'document:1')]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(false);
  });
});

describe('wildcards', () => {
  it('grants every subject of the type', async () => {
    const authz = setup([T('user:*', 'anyone', 'document:1')]);
    expect(await authz.can('user:alice', 'document.public', 'document:1')).toBe(true);
    expect(await authz.can('user:zoe', 'document.public', 'document:1')).toBe(true);
  });

  it('does not leak to another type', async () => {
    const authz = setup([T('user:*', 'owner', 'document:1')]);
    expect(await authz.can('team:eng', 'document.read', 'document:1')).toBe(false);
  });

  it('is not confused with a literal id', async () => {
    const authz = setup([T('user:*', 'owner', 'document:1')]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
  });
});

describe('intersection', () => {
  it('requires every branch', async () => {
    const both = setup([
      T('user:alice', 'owner', 'document:1'),
      T('user:alice', 'editor', 'document:1'),
    ]);
    expect(await both.can('user:alice', 'document.write', 'document:1')).toBe(true);

    const onlyOwner = setup([T('user:alice', 'owner', 'document:1')]);
    expect(await onlyOwner.can('user:alice', 'document.write', 'document:1')).toBe(false);
  });
});

describe('exclusion', () => {
  it('allows when the base holds and the exclusion does not', async () => {
    const authz = setup([
      T('user:alice', 'owner', 'document:1'),
      T('user:alice', 'editor', 'document:1'),
    ]);
    expect(await authz.can('user:alice', 'document.write', 'document:1')).toBe(true);
  });

  it('denies when the subject is on both sides of the except', async () => {
    // This is the case that breaks if the evaluator returns early on a
    // satisfied base: `(owner and editor) except banned` would then allow
    // exactly who the `except` was written to deny.
    const authz = setup([
      T('user:bob', 'owner', 'document:1'),
      T('user:bob', 'editor', 'document:1'),
      T('user:bob', 'banned', 'document:1'),
    ]);
    expect(await authz.can('user:bob', 'document.write', 'document:1')).toBe(false);
  });

  it('still denies when only the except side matches', async () => {
    const authz = setup([T('user:carol', 'banned', 'document:1')]);
    expect(await authz.can('user:carol', 'document.write', 'document:1')).toBe(false);
  });

  it('is not fooled by a wildcard on the excluded relation', async () => {
    // `user:*` on `banned` must exclude every individual user, including one
    // who is both owner and editor.
    const authz = setup([
      T('user:*', 'banned', 'document:1'),
      T('user:alice', 'owner', 'document:1'),
      T('user:alice', 'editor', 'document:1'),
    ]);
    expect(await authz.can('user:alice', 'document.write', 'document:1')).toBe(false);
  });

  it('does not let a wildcard grant override the exclusion', async () => {
    const authz = setup([
      T('user:*', 'anyone', 'document:1'),
      T('user:*', 'banned', 'document:1'),
    ]);
    expect(await authz.can('user:alice', 'document.write', 'document:1')).toBe(false);
  });
});

describe('union', () => {
  it('allows through any branch', async () => {
    const authz = setup([T('user:alice', 'viewer', 'document:1')]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
  });

  it('denies when no branch matches', async () => {
    const authz = setup([T('user:bob', 'viewer', 'document:1')]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(false);
  });
});

describe('fail closed', () => {
  it('denies a tuple whose condition is not evaluated yet', async () => {
    const authz = setup([
      T('user:alice', 'owner', 'document:1', {
        condition: 'inRegion',
        context: { region: 'eu' },
      }),
    ]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(false);
  });

  it('inherits through a parent folder', async () => {
    const authz = setup([
      T('folder:9', 'parent', 'document:1'),
      T('user:alice', 'viewer', 'folder:9'),
    ]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(true);
  });

  it('does not let a condition failure fall through to another branch', async () => {
    const authz = setup([
      T('user:alice', 'owner', 'document:1', { condition: 'inRegion' }),
      T('user:alice', 'editor', 'document:1'),
    ]);
    // `editor` is a separate union branch, so read is still allowed...
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
    // ...but `write` needs owner too, and the owner tuple is conditional.
    expect(await authz.can('user:alice', 'document.write', 'document:1')).toBe(false);
  });
});

describe('request validation', () => {
  it('rejects a wildcard subject', async () => {
    const authz = setup();
    await expect(authz.can('user:*', 'document.read', 'document:1')).rejects.toThrow(
      /wildcard subject/,
    );
  });

  it('rejects a resource whose type does not match the permission', async () => {
    const authz = setup();
    await expect(authz.can('user:a', 'document.read', 'folder:1')).rejects.toThrow(
      /applies to a/,
    );
  });

  it('rejects an unknown type', async () => {
    const authz = setup();
    await expect(authz.can('user:a', 'nope.read', 'nope:1')).rejects.toThrow();
  });

  it('rejects an unknown relation or permission', async () => {
    const authz = setup();
    await expect(authz.can('user:a', 'document.fly', 'document:1')).rejects.toThrow();
  });

  it('rejects a malformed reference', async () => {
    const authz = setup();
    await expect(authz.can('alice', 'document.read', 'document:1')).rejects.toThrow();
  });
});

describe('check and assert', () => {
  it('returns a decision object', async () => {
    const authz = setup([T('user:alice', 'owner', 'document:1')]);
    expect(
      await authz.check({
        subject: 'user:alice',
        permission: 'document.read',
        resource: 'document:1',
      }),
    ).toEqual({
      allowed: true,
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
      truncated: false,
    });
  });

  it('reports a budget-exhausted denial as truncated, not as a plain deny', async () => {
    const authz = createAuthz({
      model,
      store: testStore([T('user:alice', 'owner', 'document:1')]),
      limits: { maxNodes: 1 },
    });
    expect(
      await authz.check({
        subject: 'user:alice',
        permission: 'document.read',
        resource: 'document:1',
      }),
    ).toEqual({
      allowed: false,
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
      truncated: true,
    });
  });

  it('assert passes silently when allowed', async () => {
    const authz = setup([T('user:alice', 'owner', 'document:1')]);
    await expect(
      authz.assert({
        subject: 'user:alice',
        permission: 'document.read',
        resource: 'document:1',
      }),
    ).resolves.toBeUndefined();
  });

  it('assert throws an AccessDeniedError when denied', async () => {
    const authz = setup();
    await expect(
      authz.assert({
        subject: 'user:alice',
        permission: 'document.read',
        resource: 'document:1',
      }),
    ).rejects.toThrow(/not allowed/);
  });
});

describe('the evaluator boundary', () => {
  it('refuses a member the model does not declare', async () => {
    // `createAuthz` validates a permission before it ever reaches the evaluator,
    // so this arm is only reachable through the exported `evaluate`, which takes
    // a member name outright. Failing loudly here is what stops a typo'd
    // permission from being evaluated as an empty expression — which would deny
    // everything and look like a working model.
    await expect(
      evaluate({
        model,
        store: testStore(),
        subject: parseRef('user:alice'),
        member: 'ghost',
        resource: parseRef('document:1', 'object'),
        limits: DEFAULT_LIMITS,
      }),
    ).rejects.toThrow(/declares no relation or permission/);
  });
});

describe('the per-request memo', () => {
  it('answers a repeated question inside one evaluation without re-reading', async () => {
    // Two *separate* calls are two memos — `evaluate` scopes its map to one
    // invocation, which is what keeps `withStore(trx)` from reading a result
    // computed against another store. So the only way to take a hit is inside a
    // single evaluation, and `document.diamond` is built for it: `steward` and
    // `superuser` both resolve `owner`, so the second branch finds it already
    // answered.
    //
    // Each branch measured on its own pays for `owner` once. Together they must
    // pay for it once *between* them — exactly one read less than the sum of the
    // parts. The assertion the memo used to sit next to,
    // `second.reads <= first.reads`, is satisfied by a memo that never hits, or
    // by one whose key is so coarse it returns somebody else's answer; this is
    // the shape that cannot.
    const authz = setup([T('user:alice', 'owner', 'document:1')]);
    const ask = (permission: string) =>
      authz.explain({
        subject: 'user:alice',
        permission,
        resource: 'document:1',
      });

    const diamond = await ask('document.diamond');
    const steward = await ask('document.steward');
    const superuser = await ask('document.superuser');

    expect(diamond.allowed).toBe(true);
    expect(diamond.reads).toBe(steward.reads + superuser.reads - 1);
  });
});

describe('limits', () => {
  it('denies and reports when the read budget is exhausted', async () => {
    const authz = createAuthz({ model, store: testStore(), limits: { maxNodes: 1 } });
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
    });
    expect(result.allowed).toBe(false);
    expect(result.tree.op === 'limit' || result.tree.children.length > 0).toBe(true);
  });
});

describe('userset conditions fail closed', () => {
  it('grants through a userset tuple whose condition holds', async () => {
    const authz = setup([
      T('team:eng#member', 'editor', 'document:1', { condition: 'always' }),
      T('user:alice', 'member', 'team:eng'),
    ]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
  });

  it('does not grant through a userset tuple whose condition does not hold', async () => {
    const authz = setup([
      T('team:eng#member', 'editor', 'document:1', {
        condition: 'strict',
        context: { region: 'us' },
      }),
      T('user:alice', 'member', 'team:eng'),
    ]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(false);
  });

  it('still allows when an unconditional tuple is also present', async () => {
    const authz = setup([
      T('team:eng#member', 'editor', 'document:1', { condition: 'always' }),
      T('team:ops#member', 'editor', 'document:1'),
      T('user:alice', 'member', 'team:eng'),
      T('user:alice', 'member', 'team:ops'),
    ]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
  });

  it('explains why a conditional userset did not grant', async () => {
    const authz = setup([
      T('team:eng#member', 'editor', 'document:1', {
        condition: 'strict',
        context: { region: 'us' },
      }),
      T('user:alice', 'member', 'team:eng'),
    ]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.editor',
      resource: 'document:1',
    });
    expect(result.allowed).toBe(false);
    const userset = flattenOps(result.tree).find((n) => n.op === 'userset');
    expect(userset?.reason).toMatch(/condition/);
  });
});

function flattenOps(
  node: import('../../src/kernel/index.js').ExplainNode,
): import('../../src/kernel/index.js').ExplainNode[] {
  return [node, ...node.children.flatMap(flattenOps)];
}

describe('a wildcard edge', () => {
  const model = defineModel({
    types: {
      user: defineType({}),
      doc: defineType({ relations: { viewer: relation('user').or(wildcard('user')) } }),
    },
  });
  const authz = createAuthz({
    model,
    store: testStore([T('user:*', 'viewer', 'doc:1')]),
  });

  it('grants to every user of the type', async () => {
    expect(await authz.can('user:alice', 'doc.viewer', 'doc:1')).toBe(true);
  });

  it('does not grant to a different type', async () => {
    // `user:*` covers the user *type*, not every subject in the graph.
    expect(await authz.can('team:eng', 'doc.viewer', 'doc:1')).toBe(false);
  });
});
