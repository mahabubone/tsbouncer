import { describe, expect, it } from 'vitest';
import { createAuthz, type ExplainNode } from '../../src/kernel/index.js';
import { model, setup, T } from './fixtures.js';
import { testStore } from './store.js';

/**
 * Tuple-to-userset is the milestone PLAN.md rates high risk, so the cases below
 * lean hard on the failure modes: fan-out, loops, and a budget that has to bite
 * before a slow graph becomes a hang.
 */

function flatten(node: ExplainNode): ExplainNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

describe('one level', () => {
  it('grants through a parent', async () => {
    const authz = setup([
      T('folder:9', 'parent', 'document:1'),
      T('user:alice', 'viewer', 'folder:9'),
    ]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(true);
  });

  it('denies when the parent does not grant', async () => {
    const authz = setup([
      T('folder:9', 'parent', 'document:1'),
      T('user:alice', 'viewer', 'folder:9'),
    ]);
    expect(await authz.can('user:bob', 'document.inherited', 'document:1')).toBe(false);
  });

  it('denies when there is no parent at all', async () => {
    const authz = setup([T('user:alice', 'viewer', 'folder:9')]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(false);
  });

  it('denies when the parent tuple exists but the parent grants nobody', async () => {
    const authz = setup([T('folder:9', 'parent', 'document:1')]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(false);
  });

  it('does not reach a sibling folder', async () => {
    const authz = setup([
      T('folder:9', 'parent', 'document:1'),
      T('user:alice', 'viewer', 'folder:8'),
    ]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(false);
  });
});

describe('two levels', () => {
  it('walks down the archive chain', async () => {
    // document -> folder -> archive, because `folder.read` carries its own
    // tuple-to-userset. No extra permission on `document` is involved.
    const authz = setup([
      T('folder:9', 'parent', 'document:1'),
      T('archive:1', 'parent', 'folder:9'),
      T('user:alice', 'viewer', 'archive:1'),
    ]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(true);
  });

  it('denies when the grant is only at the top of the chain', async () => {
    // Being a viewer of the document is not the same as inheriting from it.
    const authz = setup([
      T('folder:9', 'parent', 'document:1'),
      T('user:alice', 'viewer', 'document:1'),
    ]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(false);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
  });
});

describe('fan-out', () => {
  it('grants when any parent grants', async () => {
    const authz = setup([
      T('folder:1', 'parent', 'document:1'),
      T('folder:2', 'parent', 'document:1'),
      T('folder:3', 'parent', 'document:1'),
      T('user:alice', 'viewer', 'folder:3'),
    ]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(true);
  });

  it('denies when no parent grants', async () => {
    const authz = setup([
      T('folder:1', 'parent', 'document:1'),
      T('folder:2', 'parent', 'document:1'),
      T('user:alice', 'viewer', 'folder:9'),
    ]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(false);
  });

  it('evaluates every parent so the trace shows all of them', async () => {
    const authz = setup([
      T('folder:1', 'parent', 'document:1'),
      T('folder:2', 'parent', 'document:1'),
    ]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.inherited',
      resource: 'document:1',
    });
    const ttu = flatten(result.tree).find((n) => n.op === 'ttu');
    expect(ttu?.children).toHaveLength(2);
  });
});

describe('multi-type through relation', () => {
  it('resolves the target against each parent own type', async () => {
    const authz = setup([
      T('archive:1', 'inherits', 'folder:9'),
      T('user:alice', 'viewer', 'archive:1'),
    ]);
    expect(await authz.can('user:alice', 'folder.read', 'folder:9')).toBe(true);
  });

  it('resolves against the other target type too', async () => {
    const authz = setup([
      T('folder:1', 'inherits', 'folder:9'),
      T('user:alice', 'viewer', 'folder:1'),
    ]);
    expect(await authz.can('user:alice', 'folder.read', 'folder:9')).toBe(true);
  });
});

describe('cycles', () => {
  it('denies instead of looping when parents form a cycle', async () => {
    // folder:9 -> archive:1 -> folder:9. The model validator only follows
    // same-type `computed` edges, so it cannot see this; the runtime guard must.
    const authz = setup([
      T('archive:1', 'parent', 'folder:9'),
      T('folder:9', 'parent', 'archive:1'),
    ]);
    expect(await authz.can('user:alice', 'folder.read', 'folder:9')).toBe(false);
  });

  it('still grants a real grant found before the loop', async () => {
    const authz = setup([
      T('user:alice', 'viewer', 'folder:9'),
      T('archive:1', 'parent', 'folder:9'),
      T('folder:9', 'parent', 'archive:1'),
    ]);
    expect(await authz.can('user:alice', 'folder.read', 'folder:9')).toBe(true);
  });

  it('reports the cycle in the trace', async () => {
    const authz = setup([
      T('archive:1', 'parent', 'folder:9'),
      T('folder:9', 'parent', 'archive:1'),
    ]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'folder.read',
      resource: 'folder:9',
    });
    expect(flatten(result.tree).some((n) => n.op === 'cycle')).toBe(true);
  });
});

describe('budget', () => {
  it('denies rather than hanging when the read budget runs out', async () => {
    const tuples = Array.from({ length: 20 }, (_, i) =>
      T(`folder:${i}`, 'parent', 'document:1'),
    );
    const authz = createAuthz({
      model,
      store: testStore(tuples),
      limits: { maxNodes: 4 },
    });
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.inherited',
      resource: 'document:1',
    });
    expect(result.allowed).toBe(false);
    expect(flatten(result.tree).some((n) => n.op === 'limit')).toBe(true);
  });

  it('denies rather than looping when the depth budget runs out', async () => {
    const authz = createAuthz({ model, store: testStore(), limits: { maxDepth: 1 } });
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.inherited',
      resource: 'document:1',
    });
    expect(result.allowed).toBe(false);
  });

  it('costs a read per parent rather than collapsing them together', async () => {
    const readsFor = async (count: number) => {
      const tuples = Array.from({ length: count }, (_, i) =>
        T(`folder:${i}`, 'parent', 'document:1'),
      );
      const result = await setup(tuples).explain({
        subject: 'user:alice',
        permission: 'document.inherited',
        resource: 'document:1',
      });
      return result.reads;
    };

    const none = await readsFor(0);
    const one = await readsFor(1);
    const three = await readsFor(3);

    // Fan-out is linear in the number of parents. The important property is that
    // three parents cost strictly more than one: if distinct parents shared a
    // memo entry, only the first would ever be examined.
    expect(none).toBe(1);
    expect(one).toBeGreaterThan(none);
    expect(three).toBeGreaterThan(one);
  });
});

describe('conditions fail closed', () => {
  it('inherits through a parent whose condition holds', async () => {
    const authz = setup([
      T('folder:9', 'parent', 'document:1', { condition: 'always' }),
      T('user:alice', 'viewer', 'folder:9'),
    ]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(true);
  });

  it('does not inherit through a parent whose condition does not hold', async () => {
    const authz = setup([
      T('folder:9', 'parent', 'document:1', {
        condition: 'strict',
        context: { region: 'us' },
      }),
      T('user:alice', 'viewer', 'folder:9'),
    ]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(false);
  });

  it('inherits when an unconditional parent tuple is also present', async () => {
    const authz = setup([
      T('folder:9', 'parent', 'document:1', {
        condition: 'strict',
        context: { region: 'us' },
      }),
      T('folder:8', 'parent', 'document:1'),
      T('user:alice', 'viewer', 'folder:8'),
    ]);
    expect(await authz.can('user:alice', 'document.inherited', 'document:1')).toBe(true);
  });
});

describe('explain', () => {
  it('names the traversed relation and the target', async () => {
    const authz = setup([
      T('folder:9', 'parent', 'document:1'),
      T('user:alice', 'viewer', 'folder:9'),
    ]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.inherited',
      resource: 'document:1',
    });
    const ttu = flatten(result.tree).find((n) => n.op === 'ttu');
    expect(ttu?.through).toBe('parent');
    expect(ttu?.target).toBe('read');
    expect(ttu?.result).toBe(true);
  });

  it('cites the parent tuple that carried the grant', async () => {
    const authz = setup([
      T('folder:9', 'parent', 'document:1'),
      T('user:alice', 'viewer', 'folder:9'),
    ]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.inherited',
      resource: 'document:1',
    });
    const ttu = flatten(result.tree).find((n) => n.op === 'ttu');
    expect(ttu?.tuples).toEqual([T('folder:9', 'parent', 'document:1')]);
  });

  it('records the query it issued', async () => {
    const authz = setup([T('folder:9', 'parent', 'document:1')]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.inherited',
      resource: 'document:1',
    });
    const ttu = flatten(result.tree).find((n) => n.op === 'ttu');
    expect(ttu?.query).toMatchObject({ relation: 'parent', resource: 'document:1' });
  });

  it('explains a missing parent', async () => {
    const authz = setup();
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.inherited',
      resource: 'document:1',
    });
    const ttu = flatten(result.tree).find((n) => n.op === 'ttu');
    expect(ttu?.reason).toMatch(/no parent tuple/);
  });

  it('explains a parent whose condition does not hold', async () => {
    const authz = setup([
      T('folder:9', 'parent', 'document:1', {
        condition: 'strict',
        context: { region: 'us' },
      }),
    ]);
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.inherited',
      resource: 'document:1',
    });
    const ttu = flatten(result.tree).find((n) => n.op === 'ttu');
    expect(ttu?.reason).toMatch(/condition does not hold/);
    expect(flatten(result.tree).some((n) => n.op === 'condition')).toBe(true);
  });
});
