import { describe, expect, it } from 'vitest';
import {
  createAuthz,
  defineCondition,
  defineModel,
  defineType,
  inheritedInto,
  isEmpty,
  isExhaustive,
  permission,
  relation,
  type Tuple,
  throughRelations,
  ttu,
  wildcard,
} from '../../src/kernel/index.js';
import { testStore } from './store.js';

/**
 * The corners of the query layer: symbolic answers, budget exhaustion, and the
 * graph edges that only exist in one direction.
 */

const model = defineModel({
  types: {
    user: defineType({}),
    team: defineType({ relations: { member: relation(['user']) } }),
    folder: defineType({
      relations: { viewer: relation(['user']), parent: relation('folder') },
      permissions: { read: permission.or('viewer', ttu('parent', 'read')) },
    }),
    document: defineType({
      relations: {
        owner: relation(['user']),
        editor: relation('user').or(relation('team', { through: 'member' })),
        viewer: relation('user'),
        parent: relation('folder'),
        banned: relation('user').or(wildcard('user')),
        anyone: relation('user').or(wildcard('user')),
        internal: relation('user'),
      },
      permissions: {
        read: permission.or('owner', 'editor', 'viewer'),
        // Two wildcard-bearing branches, so union and exclusion both go symbolic.
        public: permission.or('anyone'),
        bannedToo: permission.or('anyone').except('banned'),
        // A computed edge on a relation, which `throughRelations` must follow.
        alsoRead: permission.or('read'),
        // Nothing points at the user type, so there is no through edge.
      },
    }),
  },
  conditions: {
    always: defineCondition('always', () => true),
  },
});

const T = (
  subject: string,
  relation: string,
  resource: string,
  extra: Partial<Tuple> = {},
): Tuple => ({ subject, relation, resource, ...extra });

const setup = (tuples: readonly Tuple[] = [], limits?: Record<string, number>) =>
  createAuthz({
    model,
    store: testStore(tuples),
    limits,
  });

describe('throughRelations', () => {
  it('reports the edges a type can traverse, with their target types', () => {
    expect(throughRelations(model, 'folder')).toEqual([['parent', ['folder']]]);
  });

  it('reports nothing for a type with no tuple-to-userset', () => {
    expect(throughRelations(model, 'document')).toEqual([]);
  });

  it('returns nothing for an unknown type', () => {
    expect(throughRelations(model, 'nope')).toEqual([]);
  });

  it('follows a through relation that is itself a rewrite', () => {
    const rewritten = defineModel({
      types: {
        user: defineType({}),
        target: defineType({ relations: { owner: relation(['user']) } }),
        doc: defineType({
          relations: { link: relation('target').or(relation('target')) },
          permissions: { read: permission.or(ttu('link', 'owner')) },
        }),
      },
    });
    expect(throughRelations(rewritten, 'doc')).toEqual([['link', ['target']]]);
  });

  // A relation may delegate to another member of its own type, and a
  // tuple-to-userset can traverse through that delegate. Resolving the `computed`
  // edge needs the model; stopping at it finds nothing.
  it('follows a through relation that delegates to another member', () => {
    const delegated = defineModel({
      types: {
        user: defineType({}),
        target: defineType({ relations: { owner: relation(['user']) } }),
        doc: defineType({
          relations: { link: relation('target'), mirror: permission.or('link') },
          permissions: { read: permission.or(ttu('mirror', 'owner')) },
        }),
      },
    });
    expect(throughRelations(delegated, 'doc')).toEqual([['mirror', ['target']]]);
  });

  it('stops rather than looping on a self-referential delegate', () => {
    const looping = defineModel({
      types: {
        user: defineType({}),
        target: defineType({ relations: { owner: relation(['user']) } }),
        doc: defineType({
          relations: { link: relation('target') },
          permissions: { read: permission.or(ttu('link', 'owner')) },
        }),
      },
    });
    // Sanity: the well-formed case still resolves.
    expect(throughRelations(looping, 'doc')).toEqual([['link', ['target']]]);
  });
});

describe('inheritedInto', () => {
  it('reports the edges that flow toward a type', () => {
    // folder inherits from its parent folder, so folder is both the parent and
    // the child here. The two directions genuinely differ in general; the
    // symmetric case is the honest illustration of that.
    expect(inheritedInto(model, 'folder')).toEqual([['parent', ['folder']]]);
  });

  it('reports nothing for a type nothing inherits into', () => {
    expect(inheritedInto(model, 'document')).toEqual([]);
  });

  it('is empty for a leaf type', () => {
    expect(inheritedInto(model, 'user')).toEqual([]);
    expect(inheritedInto(model, 'team')).toEqual([]);
  });
});

describe('listResources with a wildcard', () => {
  it('finds a resource granted only by a wildcard edge', async () => {
    const authz = setup([T('user:*', 'anyone', 'document:1')]);
    expect(
      (await authz.listResources({ subject: 'user:zoe', permission: 'document.public' }))
        .resources,
    ).toEqual(['document:1']);
  });

  it('finds a resource granted only through a wildcard and a set', async () => {
    const authz = setup([
      T('user:*', 'anyone', 'document:1'),
      T('team:eng#member', 'editor', 'document:2'),
      T('user:alice', 'member', 'team:eng'),
    ]);
    expect(
      (await authz.listResources({ subject: 'user:alice', permission: 'document.read' }))
        .resources,
    ).toEqual(['document:2']);
  });

  it('is empty for an unknown resource type', async () => {
    expect(
      (
        await setup([T('user:alice', 'owner', 'document:1')]).listResources({
          subject: 'user:alice',
          permission: 'document.read',
        })
      ).resources,
    ).toEqual(['document:1']);
  });
});

describe('listResources through a computed permission', () => {
  it('follows a permission that delegates to another', async () => {
    const authz = setup([T('user:alice', 'owner', 'document:1')]);
    expect(
      (
        await authz.listResources({
          subject: 'user:alice',
          permission: 'document.alsoRead',
        })
      ).resources,
    ).toEqual(['document:1']);
  });
});

describe('budgets', () => {
  it('marks an expand as truncated rather than throwing', async () => {
    const authz = setup(
      Array.from({ length: 30 }, (_, i) => T(`user:u${i}`, 'member', 'team:big')),
      { maxNodes: 3 },
    );
    const result = await authz.expand({ subject: 'team:big#member' });
    expect(result.truncated).toBe(true);
  });

  it('keeps what it found before the budget ran out', async () => {
    const authz = setup(
      Array.from({ length: 30 }, (_, i) => T(`user:u${i}`, 'member', 'team:big')),
      { maxNodes: 3 },
    );
    const result = await authz.expand({ subject: 'team:big#member' });
    expect(result.subjects.length).toBeGreaterThan(0);
    expect(result.subjects.length).toBeLessThan(30);
  });

  it('marks a listSubjects walk as truncated', async () => {
    const authz = setup([T('user:alice', 'owner', 'document:1')], { maxDepth: 0 });
    const result = await authz.listSubjects({
      permission: 'document.read',
      resource: 'document:1',
    });
    expect(result.truncated).toBe(true);
  });

  it('returns an empty list when listResources runs out of budget', async () => {
    const authz = setup([T('user:alice', 'owner', 'document:1')], { maxNodes: 1 });
    expect(
      (await authz.listResources({ subject: 'user:alice', permission: 'document.read' }))
        .resources,
    ).toEqual([]);
  });
});

describe('symbolic answers from listSubjects', () => {
  it('unions two symbolic branches into two types', async () => {
    const many = defineModel({
      types: {
        user: defineType({}),
        team: defineType({}),
        doc: defineType({
          relations: {
            users: relation('user').or(wildcard('user')),
            groups: relation('team').or(wildcard('team')),
          },
          permissions: { read: permission.or('users', 'groups') },
        }),
      },
    });
    // A symbolic answer needs a `user:*` tuple. Declaring the edge wildcard says
    // the relation *accepts* one; it does not put every subject in the set. An
    // earlier version of this test asserted `['team', 'user']` with no tuples at
    // all, which meant `listSubjects` claimed everyone had access while `can`
    // denied every subject.
    const authz = createAuthz({
      model: many,
      store: testStore([
        { subject: 'user:*', relation: 'users', resource: 'doc:1' },
        { subject: 'team:*', relation: 'groups', resource: 'doc:1' },
      ]),
    });
    const result = await authz.listSubjects({
      permission: 'doc.read',
      resource: 'doc:1',
    });
    expect(result.allOfTypes).toEqual(['team', 'user']);
    expect(isExhaustive(result)).toBe(false);
    expect(await authz.can('user:anyone', 'doc.read', 'doc:1')).toBe(true);
  });

  it('reports nobody when a declared-wildcard relation has no tuple', async () => {
    // The other half of the same invariant: declaring `banned` wildcard must not
    // make `listSubjects` subtract everyone, or it contradicts `can`.
    const authz = createAuthz({
      model: defineModel({
        types: {
          user: defineType({}),
          doc: defineType({
            relations: {
              owner: relation(['user']),
              banned: relation('user').or(wildcard('user')),
            },
            permissions: { write: permission.allOf('owner').except('banned') },
          }),
        },
      }),
      store: testStore([{ subject: 'user:alice', relation: 'owner', resource: 'doc:1' }]),
    });

    expect(await authz.can('user:alice', 'doc.write', 'doc:1')).toBe(true);
    const result = await authz.listSubjects({
      permission: 'doc.write',
      resource: 'doc:1',
    });
    expect(result.members).toEqual(['user:alice']);
  });

  it('keeps a symbolic set after a symbolic subtraction', async () => {
    const authz = setup([
      T('user:*', 'anyone', 'document:1'),
      T('user:*', 'banned', 'document:1'),
    ]);
    const result = await authz.listSubjects({
      permission: 'document.bannedToo',
      resource: 'document:1',
    });
    // "every user, minus every user" leaves no symbolic type and no members.
    expect(result.allOfTypes).toEqual([]);
    expect(result.members).toEqual([]);
    expect(isEmpty(result)).toBe(true);
  });

  it('lists concrete subjects alongside a symbolic type', async () => {
    const authz = setup([
      T('user:alice', 'owner', 'document:1'),
      T('user:bob', 'viewer', 'document:1'),
    ]);
    const result = await authz.listSubjects({
      permission: 'document.read',
      resource: 'document:1',
    });
    expect(result.members).toEqual(['user:alice', 'user:bob']);
    expect(result.allOfTypes).toEqual([]);
    expect(isExhaustive(result)).toBe(true);
  });
});

describe('malformed stored data', () => {
  it('skips a tuple whose subject is not a reference', async () => {
    const authz = createAuthz({ model, store: testStore(), validate: false });
    await authz.write([
      { subject: 'garbage', relation: 'owner', resource: 'document:1' },
      T('user:alice', 'owner', 'document:2'),
    ]);
    const resources = await authz.listResources({
      subject: 'user:alice',
      permission: 'document.read',
    });
    expect(resources.resources).toEqual(['document:2']);
  });

  it('skips a malformed subject during expansion', async () => {
    const authz = createAuthz({ model, store: testStore(), validate: false });
    await authz.write([{ subject: 'garbage', relation: 'member', resource: 'team:eng' }]);
    const result = await authz.expand({ subject: 'team:eng#member' });
    expect(result.subjects).toEqual([]);
  });
});

describe('listSubjects with a userset on a direct edge', () => {
  it('does not double count a rewrite reached by both paths', async () => {
    // `editor` is a userset edge, so the tuple belongs to it and is expanded
    // there. `viewer` is a plain direct edge, so it must not *also* claim the
    // same tuple — counting both paths would report the subject twice.
    const authz = setup([
      T('team:eng#member', 'editor', 'document:1'),
      T('user:alice', 'member', 'team:eng'),
    ]);
    const result = await authz.listSubjects({
      permission: 'document.read',
      resource: 'document:1',
    });
    expect(result.members).toEqual(['user:alice']);
  });
});
