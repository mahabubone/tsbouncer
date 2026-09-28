import { describe, expect, it } from 'vitest';
import {
  type AuthorizationError,
  acceptsSubject,
  createAuthz,
  defineCondition,
  defineModel,
  defineType,
  describeTuple,
  permission,
  relation,
  type SetNode,
  type Tuple,
  TupleValidationError,
  ttu,
  wildcard,
} from '../src/index.js';
import { model, setup } from './fixtures.js';
import { testStore } from './store.js';

describe('grant', () => {
  it('writes a valid tuple', async () => {
    const authz = setup();
    await authz.grant({
      subject: 'user:alice',
      relation: 'owner',
      resource: 'document:1',
    });
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
  });

  it('writes a userset subject', async () => {
    const authz = setup();
    await authz.grant({
      subject: 'team:eng#member',
      relation: 'editor',
      resource: 'document:1',
    });
    await authz.grant({
      subject: 'user:alice',
      relation: 'member',
      resource: 'team:eng',
    });
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
  });

  it('writes a wildcard subject', async () => {
    const authz = setup();
    await authz.grant({
      subject: 'user:*',
      relation: 'anyone',
      resource: 'document:1',
    });
    expect(await authz.can('user:zoe', 'document.public', 'document:1')).toBe(true);
  });

  it('rejects an unknown resource type', async () => {
    const authz = setup();
    await expect(
      authz.grant({ subject: 'user:a', relation: 'owner', resource: 'nope:1' }),
    ).rejects.toThrow(/not declared by the model/);
  });

  it('rejects an unknown subject type', async () => {
    const authz = setup();
    await expect(
      authz.grant({ subject: 'ghost:x', relation: 'owner', resource: 'document:1' }),
    ).rejects.toThrow(/subject type/);
  });

  it('rejects an unknown relation', async () => {
    const authz = setup();
    await expect(
      authz.grant({ subject: 'user:a', relation: 'nope', resource: 'document:1' }),
    ).rejects.toThrow(/has no relation/);
  });

  it('rejects writing against a permission', async () => {
    const authz = setup();
    await expect(
      authz.grant({ subject: 'user:a', relation: 'read', resource: 'document:1' }),
    ).rejects.toThrow(/only written against relations/);
  });

  it('rejects a subject type the relation does not accept', async () => {
    const authz = setup();
    await expect(
      authz.grant({ subject: 'team:eng', relation: 'owner', resource: 'document:1' }),
    ).rejects.toThrow(/does not accept/);
  });

  it('rejects a userset the relation does not name', async () => {
    const authz = setup();
    await expect(
      authz.grant({
        subject: 'team:eng#owner',
        relation: 'owner',
        resource: 'document:1',
      }),
    ).rejects.toThrow(/does not accept/);
  });

  it('rejects an undeclared condition', async () => {
    const authz = setup();
    await expect(
      authz.grant({
        subject: 'user:a',
        relation: 'owner',
        resource: 'document:1',
        condition: 'ghost',
      }),
    ).rejects.toThrow(/condition .* is not declared/);
  });

  it('accepts a declared condition', async () => {
    // Built on its own rather than by extending the shared model: a built
    // `TypeDefinition` holds `SetNode`s, but `defineModel` wants the
    // `SetExpression`s the builders produce, so the two cannot be mixed.
    const conditional = createAuthz({
      model: defineModel({
        types: {
          user: defineType({}),
          doc: defineType({
            relations: { owner: relation(['user']) },
            permissions: { read: permission.or('owner') },
          }),
        },
        conditions: { always: defineCondition('always', () => true) },
      }),
      store: testStore(),
    });
    await expect(
      conditional.grant({
        subject: 'user:a',
        relation: 'owner',
        resource: 'doc:1',
        condition: 'always',
      }),
    ).resolves.toBeUndefined();
  });

  it('reports a stable error code', async () => {
    const authz = setup();
    try {
      await authz.grant({ subject: 'user:a', relation: 'nope', resource: 'document:1' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TupleValidationError);
      expect((error as AuthorizationError).code).toBe('invalid_tuple');
    }
  });
});

describe('write', () => {
  it('validates every tuple before writing any', async () => {
    const authz = setup();
    await expect(
      authz.write([
        { subject: 'user:alice', relation: 'owner', resource: 'document:1' },
        { subject: 'user:alice', relation: 'nope', resource: 'document:1' },
      ]),
    ).rejects.toThrow(TupleValidationError);
    // The good tuple must not have been persisted by the time the bad one failed.
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(false);
  });

  it('can skip validation', async () => {
    const authz = createAuthz({ model, store: testStore(), validate: false });
    await expect(
      authz.write([{ subject: 'user:alice', relation: 'nope', resource: 'document:1' }]),
    ).resolves.toBeUndefined();
  });
});

describe('revoke', () => {
  it('removes a tuple', async () => {
    const authz = setup();
    await authz.grant({
      subject: 'user:alice',
      relation: 'owner',
      resource: 'document:1',
    });
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
    await authz.revoke({
      subject: 'user:alice',
      relation: 'owner',
      resource: 'document:1',
    });
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(false);
  });

  it('validates before deleting', async () => {
    const authz = setup();
    await expect(
      authz.revoke({ subject: 'user:alice', relation: 'nope', resource: 'document:1' }),
    ).rejects.toThrow(TupleValidationError);
  });
});

describe('withStore', () => {
  it('shares the model and targets the new store', async () => {
    const authz = setup();
    const other = testStore([
      { subject: 'user:alice', relation: 'owner', resource: 'document:1' },
    ]);
    const scoped = authz.withStore(other);
    expect(await scoped.can('user:alice', 'document.read', 'document:1')).toBe(true);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(false);
    expect(scoped.model).toBe(authz.model);
  });

  it('does not reuse a decision computed against the outer store', async () => {
    // The memo is per-request, so a store swap can never return a stale answer.
    const outer = setup();
    await outer.grant({
      subject: 'user:alice',
      relation: 'owner',
      resource: 'document:1',
    });
    expect(await outer.can('user:alice', 'document.read', 'document:1')).toBe(true);

    const empty = outer.withStore(testStore());
    expect(await empty.can('user:alice', 'document.read', 'document:1')).toBe(false);
  });

  it('rejects a malformed store', () => {
    const authz = setup();
    expect(() => authz.withStore({} as never)).toThrow(TypeError);
  });
});

describe('client construction', () => {
  it('rejects a missing model', () => {
    expect(() =>
      createAuthz({ model: undefined as never, store: testStore() }),
    ).toThrow();
  });

  it('rejects a malformed store', () => {
    expect(() => createAuthz({ model, store: { read: () => {} } as never })).toThrow();
  });
});

describe('introspection', () => {
  it('lists types, relations, and permissions', () => {
    const authz = setup();
    expect(authz.types().sort()).toEqual([
      'archive',
      'document',
      'folder',
      'team',
      'user',
    ]);
    expect(authz.relations('document')).toContain('owner');
    expect(authz.permissions('document')).toEqual([
      'read',
      'write',
      'public',
      'inherited',
    ]);
  });

  it('throws for an unknown type', () => {
    const authz = setup();
    expect(() => authz.relations('nope')).toThrow(/unknown type/);
    expect(() => authz.permissions('nope')).toThrow(/unknown type/);
  });
});

describe('acceptsSubject through a rewrite', () => {
  it('accepts a subject a delegating relation admits', async () => {
    // `steward = or(owner, user)` is a relation whose expression references
    // another member, so validation has to follow the reference rather than
    // stopping at the `computed` node and rejecting a valid grant.
    const authz = setup();
    await expect(
      authz.grant({ subject: 'user:alice', relation: 'steward', resource: 'document:1' }),
    ).resolves.toBeUndefined();
  });

  it('still rejects a subject no branch admits', async () => {
    const authz = setup();
    await expect(
      authz.grant({ subject: 'team:eng', relation: 'steward', resource: 'document:1' }),
    ).rejects.toThrow(/does not accept/);
  });

  it('accepts a subject through an intersection', async () => {
    const authz = setup();
    await expect(
      authz.grant({
        subject: 'user:alice',
        relation: 'superuser',
        resource: 'document:1',
      }),
    ).resolves.toBeUndefined();
    await expect(
      authz.grant({ subject: 'team:eng', relation: 'superuser', resource: 'document:1' }),
    ).rejects.toThrow(/does not accept/);
  });

  it('decides an exclusion by its base, not its subtract side', async () => {
    // `banned` accepts users, so an intersection that required both would reject
    // every grant. The `except` side can only remove access, never gate it.
    const authz = setup();
    await expect(
      authz.grant({ subject: 'user:bob', relation: 'superuser', resource: 'document:1' }),
    ).resolves.toBeUndefined();
  });

  it('rejects a userset through a delegating relation', async () => {
    const authz = setup();
    await expect(
      authz.grant({
        subject: 'team:eng#member',
        relation: 'steward',
        resource: 'document:1',
      }),
    ).rejects.toThrow(/does not accept/);
  });
});

describe('evaluating a rewrite on a relation', () => {
  it('resolves a computed edge inside a relation', async () => {
    const authz = setup();
    await authz.grant({
      subject: 'user:alice',
      relation: 'steward',
      resource: 'document:1',
    });
    expect(await authz.can('user:alice', 'document.steward', 'document:1')).toBe(true);
  });

  it('honours an exclusion declared on a relation', async () => {
    const authz = setup();
    await authz.grant({ subject: 'user:bob', relation: 'owner', resource: 'document:1' });
    await authz.grant({
      subject: 'user:bob',
      relation: 'banned',
      resource: 'document:1',
    });
    expect(await authz.can('user:bob', 'document.superuser', 'document:1')).toBe(false);

    const allowed = setup();
    await allowed.grant({
      subject: 'user:carol',
      relation: 'owner',
      resource: 'document:1',
    });
    expect(await allowed.can('user:carol', 'document.superuser', 'document:1')).toBe(
      true,
    );
  });
});

describe('malformed stored subjects', () => {
  it('ignores a subject that is not a valid reference', async () => {
    // A store can hold anything. An unparseable subject must be skipped, not
    // thrown on — one bad row cannot take down a decision.
    const authz = createAuthz({ model, store: testStore(), validate: false });
    await authz.write([
      { subject: 'not a ref', relation: 'owner', resource: 'document:1' },
      { subject: 'user:alice', relation: 'owner', resource: 'document:1' },
    ]);
    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
  });
});

/**
 * Every edge shape `acceptsSubject` has to decide on: a plain direct edge, a
 * userset, a wildcard-only edge, a delegating relation, an intersection, an
 * exclusion, and a permission holding a tuple-to-userset.
 */
const edgeShapes = defineModel({
  types: {
    user: defineType({}),
    team: defineType({ relations: { member: relation(['user']) } }),
    folder: defineType({ relations: { viewer: relation(['user']) } }),
    doc: defineType({
      relations: {
        owner: relation(['user']),
        viaUserset: relation('user').or(relation('team', { through: 'member' })),
        viaWildcard: relation('user').or(wildcard('user')),
        onlyWildcard: wildcard('user'),
        delegating: permission.or('owner'),
        intersect: permission.allOf('owner', 'delegating'),
        excepted: permission.allOf('owner').except('banned'),
        banned: relation('user'),
        link: relation('folder'),
      },
      permissions: { read: permission.or('owner', ttu('link', 'viewer')) },
    }),
  },
});

describe('acceptsSubject', () => {
  const direct = (type: string, relation?: string) =>
    relation === undefined ? { type, id: 'x' } : { type, id: 'x', relation };

  const edgeOf = (name: string): SetNode => {
    const found = edgeShapes.types.doc?.relations[name];
    if (found === undefined) throw new Error(`model is missing relation ${name}`);
    return found;
  };
  const accepts = (name: string, type: string, relation?: string): boolean =>
    acceptsSubject(edgeShapes, 'doc', edgeOf(name), direct(type, relation), new Set());

  it('accepts a direct subject of the right type', () => {
    expect(accepts('owner', 'user')).toBe(true);
    expect(accepts('owner', 'folder')).toBe(false);
  });

  it('rejects a grant against a wildcard-only edge', () => {
    // `user:*` is not something a caller writes a grant against. A relation
    // that *also* has a plain direct branch still accepts a direct subject, so
    // the check is per branch rather than per relation.
    expect(accepts('onlyWildcard', 'user')).toBe(false);
    expect(accepts('viaWildcard', 'user')).toBe(true);
  });

  it('accepts a userset the edge names, and only that one', () => {
    expect(accepts('viaUserset', 'team', 'member')).toBe(true);
    expect(accepts('viaUserset', 'team', 'owner')).toBe(false);
  });

  it('follows a delegating relation', () => {
    expect(accepts('delegating', 'user')).toBe(true);
    expect(accepts('delegating', 'team')).toBe(false);
  });

  it('requires every branch of an intersection', () => {
    expect(accepts('intersect', 'user')).toBe(true);
    expect(accepts('intersect', 'team')).toBe(false);
  });

  it('decides an exclusion by its base', () => {
    // `banned` accepts users too, so requiring both would reject every grant.
    expect(accepts('excepted', 'user')).toBe(true);
  });

  it('rejects a subject for a permission holding a tuple-to-userset', () => {
    // A ttu is an edge on the *resource*, never something a subject carries.
    // The `or('owner')` branch is checked first and would accept a user, so the
    // ttu branch itself is what the test pins down.
    const read = edgeShapes.types.doc?.permissions.read;
    if (read === undefined) throw new Error('model is missing read');
    const ttuOnly = defineModel({
      types: {
        user: defineType({}),
        folder: defineType({ relations: { viewer: relation(['user']) } }),
        doc: defineType({
          relations: { link: relation('folder') },
          permissions: { read: permission.or(ttu('link', 'viewer')) },
        }),
      },
    });
    const node = ttuOnly.types.doc?.permissions.read;
    if (node === undefined) throw new Error('model is missing read');
    expect(acceptsSubject(ttuOnly, 'doc', node, direct('user'), new Set())).toBe(false);
    // Sanity: the mixed permission above does accept one.
    expect(acceptsSubject(edgeShapes, 'doc', read, direct('user'), new Set())).toBe(true);
  });

  it('cannot be handed a delegating cycle, because the model rejects one first', () => {
    // The runtime `seen` guard in acceptsSubject is defence in depth: a
    // self-referential delegation never survives `defineModel`, so no legal
    // model can reach it. The build-time check is the real guard.
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          doc: defineType({
            relations: {
              a: permission.or('b'),
              b: permission.or('a'),
              owner: relation(['user']),
            },
          }),
        },
      }),
    ).toThrow(/cycle/);
  });
});

describe('describeTuple', () => {
  it('renders a tuple readably', () => {
    const tuple: Tuple = { subject: 'user:alice', relation: 'viewer', resource: 'doc:1' };
    expect(describeTuple(tuple)).toBe('user:alice#viewer@doc:1');
  });
});

describe('the validate flag', () => {
  const model = defineModel({
    types: {
      user: defineType({}),
      doc: defineType({ relations: { owner: relation(['user']) } }),
    },
  });

  it('rejects a tuple against a name the model does not declare', async () => {
    const authz = createAuthz({ model, store: testStore([]) });
    await expect(
      authz.write([{ subject: 'user:alice', relation: 'ghost', resource: 'doc:1' }]),
    ).rejects.toThrow();
  });

  it('skips the model check when validation is turned off', async () => {
    const authz = createAuthz({ model, store: testStore([]), validate: false });
    // The store takes it; the model never sees it. That is the point of the
    // flag, and the reason it is not the default.
    await authz.write([{ subject: 'user:alice', relation: 'ghost', resource: 'doc:1' }]);
    expect(await authz.can('user:alice', 'doc.owner', 'doc:1')).toBe(false);
  });

  it('validates a replace as well as a tuple write', async () => {
    const authz = createAuthz({ model, store: testStore([]) });
    await expect(
      authz.delete({
        kind: 'replace',
        query: { resource: 'doc:1' },
        tuples: [{ subject: 'user:alice', relation: 'ghost', resource: 'doc:1' }],
      }),
    ).rejects.toThrow();
  });

  it('leaves a delete unvalidated', async () => {
    const authz = createAuthz({ model, store: testStore([]) });
    await expect(authz.delete({ kind: 'tuples', tuples: [] })).resolves.toBeUndefined();
  });
});
