import { describe, expect, it } from 'vitest';
import { createAuthz, type ExplainNode, formatExplain } from '../src/index.js';
import { model, setup } from './fixtures.js';
import { testStore } from './store.js';

const T = (subject: string, relation: string, resource: string) => ({
  subject,
  relation,
  resource,
});

async function explainFor(
  tuples: Parameters<typeof setup>[0],
  request: { subject: string; permission: string; resource: string },
) {
  const authz = setup(tuples);
  return authz.explain(request);
}

function flatten(node: ExplainNode): ExplainNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

describe('explain shape', () => {
  it('reports the request it answered', async () => {
    const result = await explainFor([T('user:alice', 'owner', 'document:1')], {
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
    });
    expect(result).toMatchObject({
      allowed: true,
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
    });
  });

  it('cites the tuple that produced an allow', async () => {
    const result = await explainFor([T('user:alice', 'owner', 'document:1')], {
      subject: 'user:alice',
      permission: 'document.owner',
      resource: 'document:1',
    });
    const leaf = result.tree;
    expect(leaf.op).toBe('direct');
    expect(leaf.tuples).toEqual([T('user:alice', 'owner', 'document:1')]);
  });

  it('cites the query that produced a deny', async () => {
    const result = await explainFor([], {
      subject: 'user:alice',
      permission: 'document.owner',
      resource: 'document:1',
    });
    expect(result.tree.result).toBe(false);
    expect(result.tree.query).toMatchObject({
      relation: 'owner',
      resource: 'document:1',
    });
    expect(result.tree.tuples).toEqual([]);
  });

  it('shows both sides of an exclusion', async () => {
    const result = await explainFor(
      [
        T('user:bob', 'owner', 'document:1'),
        T('user:bob', 'editor', 'document:1'),
        T('user:bob', 'banned', 'document:1'),
      ],
      { subject: 'user:bob', permission: 'document.write', resource: 'document:1' },
    );
    expect(result.allowed).toBe(false);
    expect(result.tree.op).toBe('exclusion');
    // base and subtract are both present, so a reader can see which side matched
    expect(result.tree.children).toHaveLength(2);
  });

  it('does not stop an intersection at the first miss', async () => {
    const result = await explainFor([T('user:alice', 'owner', 'document:1')], {
      subject: 'user:alice',
      permission: 'document.write',
      resource: 'document:1',
    });
    const intersection = flatten(result.tree).find((n) => n.op === 'intersection');
    expect(intersection?.children).toHaveLength(2);
  });

  it('stops a union at the branch that allowed', async () => {
    const result = await explainFor([T('user:alice', 'owner', 'document:1')], {
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
    });
    const union = result.tree;
    expect(union.op).toBe('union');
    // The trace explains why it was *allowed*, so only the winning branch.
    expect(union.children).toHaveLength(1);
  });

  it('shows the query a userset read issued', async () => {
    const result = await explainFor(
      [
        T('team:eng#member', 'editor', 'document:1'),
        T('user:alice', 'member', 'team:eng'),
      ],
      { subject: 'user:alice', permission: 'document.editor', resource: 'document:1' },
    );
    const userset = flatten(result.tree).find((n) => n.op === 'userset');
    expect(userset?.result).toBe(true);
    expect(userset?.query).toMatchObject({ relation: 'editor', resource: 'document:1' });
    expect(userset?.tuples).toEqual([T('team:eng#member', 'editor', 'document:1')]);
  });

  it('explains an unevaluated condition', async () => {
    const result = await explainFor(
      [{ ...T('user:alice', 'owner', 'document:1'), condition: 'inRegion' }],
      { subject: 'user:alice', permission: 'document.owner', resource: 'document:1' },
    );
    expect(result.allowed).toBe(false);
    expect(result.tree.children[0]?.op).toBe('condition');
  });

  it('explains a tuple-to-userset by name', async () => {
    const result = await explainFor(
      [T('folder:9', 'parent', 'document:1'), T('user:alice', 'viewer', 'folder:9')],
      { subject: 'user:alice', permission: 'document.inherited', resource: 'document:1' },
    );
    expect(result.allowed).toBe(true);
    const ttu = flatten(result.tree).find((n) => n.op === 'ttu');
    expect(ttu?.through).toBe('parent');
    expect(ttu?.target).toBe('read');
  });

  it('is JSON-serializable', async () => {
    const result = await explainFor([T('user:alice', 'owner', 'document:1')], {
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
    });
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
    expect(JSON.parse(JSON.stringify(result)).allowed).toBe(true);
  });

  it('counts the reads it issued', async () => {
    const result = await explainFor([T('user:alice', 'owner', 'document:1')], {
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
    });
    expect(result.reads).toBeGreaterThan(0);
  });
});

describe('formatExplain', () => {
  it('renders an allow with the tuple that caused it', async () => {
    const result = await explainFor([T('user:alice', 'owner', 'document:1')], {
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
    });
    const text = formatExplain(result);
    expect(text).toContain('ALLOWED');
    expect(text).toContain('user:alice');
    expect(text).toContain('document:123'.replace('123', '1'));
    expect(text).toContain('user:alice#owner@document:1');
  });

  it('renders a deny with the query that came back empty', async () => {
    const result = await explainFor([], {
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
    });
    const text = formatExplain(result);
    expect(text).toContain('DENIED');
    expect(text).toContain('no matching tuples');
  });

  it('renders a limit as a denial', async () => {
    const authz = createAuthz({ model, store: testStore(), limits: { maxNodes: 1 } });
    const result = await authz.explain({
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
    });
    expect(result.allowed).toBe(false);
    expect(flatten(result.tree).some((n) => n.op === 'limit')).toBe(true);
    expect(formatExplain(result)).toContain('limit');
  });

  it('renders a condition failure', async () => {
    const result = await explainFor(
      [{ ...T('user:alice', 'owner', 'document:1'), condition: 'inRegion' }],
      { subject: 'user:alice', permission: 'document.owner', resource: 'document:1' },
    );
    expect(formatExplain(result)).toContain('condition');
  });
});

describe('formatExplain branches', () => {
  it('renders a computed step with its member name', async () => {
    const result = await explainFor([T('user:alice', 'owner', 'document:1')], {
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
    });
    const text = formatExplain(result);
    expect(text).toMatch(/owner/);
    expect(text).toMatch(/[+-] /);
  });

  it('renders a userset step', async () => {
    const result = await explainFor(
      [
        T('team:eng#member', 'editor', 'document:1'),
        T('user:alice', 'member', 'team:eng'),
      ],
      { subject: 'user:alice', permission: 'document.editor', resource: 'document:1' },
    );
    const text = formatExplain(result);
    expect(text).toContain('userset');
    expect(text).toContain('team:eng#member#editor@document:1');
  });

  it('renders a userset with no candidates', async () => {
    const result = await explainFor([T('user:alice', 'editor', 'document:1')], {
      subject: 'user:bob',
      permission: 'document.editor',
      resource: 'document:1',
    });
    expect(formatExplain(result)).toContain('no tuple names a');
  });

  it('renders a tuple-to-userset with both names', async () => {
    const result = await explainFor([T('folder:9', 'parent', 'document:1')], {
      subject: 'user:alice',
      permission: 'document.inherited',
      resource: 'document:1',
    });
    expect(formatExplain(result)).toContain('ttu parent.read');
  });

  it('explains a conditional tuple as its own step', async () => {
    // A conditioned tuple is reported as a `condition` child rather than as a
    // citing tuple, so the reason a conditional grant failed is visible.
    const result = await explainFor(
      [
        {
          ...T('user:alice', 'owner', 'document:1'),
          condition: 'strict',
          context: { region: 'us' },
        },
      ],
      { subject: 'user:alice', permission: 'document.owner', resource: 'document:1' },
    );
    const text = formatExplain(result);
    expect(result.allowed).toBe(false);
    expect(text).toContain('condition');
    expect(text).toContain('strict');
    expect(text).toContain('returned false');
  });

  it('renders an intersection and an exclusion', async () => {
    const intersection = await explainFor([T('user:alice', 'owner', 'document:1')], {
      subject: 'user:alice',
      permission: 'document.write',
      resource: 'document:1',
    });
    expect(formatExplain(intersection)).toContain('intersection');

    const exclusion = await explainFor(
      [
        T('user:bob', 'owner', 'document:1'),
        T('user:bob', 'editor', 'document:1'),
        T('user:bob', 'banned', 'document:1'),
      ],
      { subject: 'user:bob', permission: 'document.write', resource: 'document:1' },
    );
    expect(formatExplain(exclusion)).toContain('except');
  });

  it('reports the read count', async () => {
    const result = await explainFor([T('user:alice', 'owner', 'document:1')], {
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
    });
    expect(formatExplain(result)).toMatch(/\d+ reads?/);
  });
});

describe('formatExplain', () => {
  const node = (op: ExplainNode['op'], result: boolean): ExplainNode => ({
    op,
    result,
    children: [],
    tuples: [],
  });

  const render = (op: ExplainNode['op'], result: boolean, reads = 0): string =>
    formatExplain({
      allowed: result,
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
      tree: node(op, result),
      reads,
    });

  it.each([
    ['direct', 'direct'],
    ['userset', 'userset'],
    ['union', 'union'],
    ['intersection', 'intersection'],
    // The formatter says "except", not "exclusion" — the domain word.
    ['exclusion', 'except'],
    ['condition', 'condition'],
    ['cycle', 'cycle'],
    ['limit', 'limit'],
  ] as const)('renders a %s node as %s', (op, label) => {
    expect(render(op, false)).toContain(label);
  });

  it('renders a computed node by the member it names', () => {
    const text = formatExplain({
      allowed: true,
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
      tree: { op: 'computed', result: true, children: [], tuples: [], name: 'owner' },
      reads: 0,
    });
    expect(text).toContain('owner');
  });

  it('names both ends of a tuple-to-userset', () => {
    const text = formatExplain({
      allowed: true,
      subject: 'user:alice',
      permission: 'document.read',
      resource: 'document:1',
      tree: {
        op: 'ttu',
        result: true,
        children: [],
        tuples: [],
        through: 'parent',
        target: 'read',
      },
      reads: 0,
    });
    expect(text).toContain('ttu parent.read');
  });

  it('marks a bare node with a sign', () => {
    expect(render('direct', true)).toContain('+ direct');
    expect(render('direct', false)).toContain('- direct');
  });

  it('omits the read count when there were none', () => {
    expect(render('direct', true, 0)).not.toContain('reads');
    expect(render('direct', true, 1)).toContain('1 read');
    expect(render('direct', true, 2)).toContain('2 reads');
  });
});
