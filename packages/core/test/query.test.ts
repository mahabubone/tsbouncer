import { describe, expect, it } from 'vitest';
import {
  createAuthz,
  defineCondition,
  defineModel,
  defineType,
  isExhaustive,
  permission,
  relation,
  type Tuple,
  ttu,
  wildcard,
} from '../src/index.js';
import { testStore } from './store.js';

/**
 * `expand`, `listResources`, and `listSubjects` — the three operations the API
 * declared and the engine did not have.
 *
 * `listResources` is enumerate-and-check and therefore exact. `listSubjects` is
 * the inverse direction, and the interesting cases are the ones where the answer
 * is not a finite list at all.
 */

const model = defineModel({
  types: {
    user: defineType({}),
    team: { relations: { member: relation(['user']) } },
    archive: {
      relations: { viewer: relation(['user']), parent: relation('folder') },
      permissions: { read: permission.or('viewer', ttu('parent', 'read')) },
    },
    folder: {
      relations: {
        viewer: relation('user').or(relation('team', { through: 'member' })),
        parent: relation('archive'),
      },
      permissions: { read: permission.or('viewer', ttu('parent', 'read')) },
    },
    document: {
      relations: {
        owner: relation(['user']),
        editor: relation('user').or(relation('team', { through: 'member' })),
        viewer: relation('user').or(relation('team', { through: 'member' })),
        parent: relation('folder'),
        banned: relation('user').or(wildcard('user')),
        internal: relation(['user']),
        anyone: relation('user').or(wildcard('user')),
      },
      permissions: {
        read: permission.or('owner', 'editor', 'viewer'),
        write: permission.allOf('owner', 'editor').except('banned'),
        public: permission.or('anyone'),
        inherited: permission.or(ttu('parent', 'read')),
        // An intersection with no exclusion, so the answer is the intersection.
        both: permission.allOf('owner', 'editor'),
        // `internal` is a plain user edge, so the subtraction is concrete and the
        // symbolic base survives. `banned` carries a wildcard and would subtract
        // everyone.
        wide: permission.allOf('owner').except('internal'),
      },
    },
  },
  conditions: {
    always: defineCondition('always', () => true),
    strict: defineCondition('strict', (ctx) => ctx.region === 'eu', {
      params: { region: 'string' as const },
    }),
  },
});

const T = (
  subject: string,
  relation: string,
  resource: string,
  extra: Partial<Tuple> = {},
): Tuple => ({ subject, relation, resource, ...extra });

function setup(tuples: readonly Tuple[] = []) {
  return createAuthz({ model, store: testStore(tuples) });
}

// ---------------------------------------------------------------------------

describe('expand', () => {
  const tuples = [
    T('user:alice', 'member', 'team:eng'),
    T('user:bob', 'member', 'team:eng'),
    T('team:eng#member', 'member', 'group:all'),
  ];

  it('returns a direct subject unchanged', async () => {
    expect((await setup().expand({ subject: 'user:alice' })).subjects).toEqual([
      'user:alice',
    ]);
  });

  it('expands a userset to its members', async () => {
    const result = await setup(tuples).expand({ subject: 'team:eng#member' });
    expect(result.subjects).toEqual(['user:alice', 'user:bob']);
  });

  it('expands transitively', async () => {
    const result = await setup(tuples).expand({ subject: 'group:all#member' });
    expect(result.subjects).toContain('user:alice');
    expect(result.subjects).toContain('user:bob');
  });

  it('returns a wildcard as itself rather than inventing members', async () => {
    const result = await setup([T('user:*', 'member', 'team:everyone')]).expand({
      subject: 'team:everyone#member',
    });
    expect(result.subjects).toEqual(['user:*']);
  });

  it('terminates on a membership cycle', async () => {
    const cyclic = [
      T('user:alice', 'member', 'team:a'),
      T('team:a#member', 'member', 'team:b'),
      T('team:b#member', 'member', 'team:a'),
    ];
    const result = await setup(cyclic).expand({ subject: 'team:a#member' });
    // The intermediate usersets are steps, not answers, so only the leaf survives.
    expect(result.subjects).toEqual(['user:alice']);
  });

  it('marks a budgeted walk as truncated', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      T(`user:u${i}`, 'member', 'team:big'),
    );
    const authz = createAuthz({ model, store: testStore(many), limits: { maxNodes: 2 } });
    const result = await authz.expand({ subject: 'team:big#member' });
    expect(result.truncated).toBe(true);
    expect(result.subjects.length).toBeLessThan(40);
  });

  it('rejects a malformed subject', async () => {
    await expect(setup().expand({ subject: 'nope' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('listResources', () => {
  const tuples = [
    T('user:alice', 'owner', 'document:1'),
    T('user:alice', 'owner', 'document:2'),
    T('team:eng#member', 'editor', 'document:3'),
    T('user:alice', 'member', 'team:eng'),
    T('user:*', 'anyone', 'document:9'),
  ];

  it('finds what a subject can read directly', async () => {
    const result = await setup(tuples).listResources({
      subject: 'user:alice',
      permission: 'document.read',
    });
    // document:1 and document:2 are alice's own. document:3 is reached because
    // `team:eng#member editor document:3` grants to her through her membership,
    // and that tuple does not name her at all. document:9 carries a wildcard
    // `anyone` edge, but `read` does not include `anyone`, so it is not here.
    expect(result.resources).toEqual(['document:1', 'document:2', 'document:3']);
  });

  it('finds a wildcard grant when the permission covers it', async () => {
    const result = await setup(tuples).listResources({
      subject: 'user:alice',
      permission: 'document.public',
    });
    expect(result.resources).toEqual(['document:9']);
  });

  it('includes a tuple written against a set the subject belongs to', async () => {
    // The tuple is `team:eng#member editor document:3`, and alice reaches it
    // through `user:alice member team:eng`. A search that only looked for
    // tuples naming alice would miss it entirely.
    const result = await setup(tuples).listResources({
      subject: 'user:alice',
      permission: 'document.editor',
    });
    expect(result.resources).toEqual(['document:3']);
  });

  it('does not grant a userset the rights of its members', async () => {
    // The same distinction the evaluator enforces. `team:eng#member` is a set,
    // not a person, so it holds nothing of its own.
    const result = await setup(tuples).listResources({
      subject: 'team:eng#member',
      permission: 'document.read',
    });
    expect(result.resources).toEqual([]);
    expect(
      await setup(tuples).can('team:eng#member', 'document.read', 'document:3'),
    ).toBe(false);
  });

  it('returns nothing for a subject with no tuples', async () => {
    const result = await setup(tuples).listResources({
      subject: 'user:nobody',
      permission: 'document.read',
    });
    expect(result.resources).toEqual([]);
  });

  it('honours exclusion rather than reporting the grant', async () => {
    const withBan = [...tuples, T('user:alice', 'banned', 'document:2')];
    const result = await setup(withBan).listResources({
      subject: 'user:alice',
      permission: 'document.write',
    });
    // document:2 is owned but banned, so it is not listed as writable.
    expect(result.resources).toEqual([]);
  });

  it('lists a resource reachable only through inheritance', async () => {
    // document:5 has no tuple of its own; it inherits read from folder:7.
    const inherited = [
      T('folder:7', 'parent', 'document:5'),
      T('user:alice', 'viewer', 'folder:7'),
    ];
    const result = await setup(inherited).listResources({
      subject: 'user:alice',
      permission: 'document.inherited',
    });
    expect(result.resources).toEqual(['document:5']);
  });

  it('walks inheritance two levels up', async () => {
    const deep = [
      T('folder:7', 'parent', 'document:5'),
      T('archive:1', 'parent', 'folder:7'),
      T('user:alice', 'viewer', 'archive:1'),
    ];
    const result = await setup(deep).listResources({
      subject: 'user:alice',
      permission: 'document.inherited',
    });
    expect(result.resources).toEqual(['document:5']);
  });

  it('respects a condition', async () => {
    const conditioned = [
      { ...T('user:alice', 'owner', 'document:1'), condition: 'always' },
    ];
    const authz = createAuthz({
      model,
      store: testStore(conditioned),
    });
    const result = await authz.listResources({
      subject: 'user:alice',
      permission: 'document.read',
    });
    expect(result.resources).toEqual(['document:1']);
  });

  it('rejects an unknown permission', async () => {
    await expect(
      setup().listResources({ subject: 'user:a', permission: 'document.fly' }),
    ).rejects.toThrow(/no relation or permission/);
  });

  it('rejects a permission for a type the model does not declare', async () => {
    await expect(
      setup().listResources({ subject: 'user:a', permission: 'ghost.read' }),
    ).rejects.toThrow(/does not declare/);
  });
});

// ---------------------------------------------------------------------------

describe('listSubjects', () => {
  it('lists direct subjects', async () => {
    const result = await setup([T('user:alice', 'owner', 'document:1')]).listSubjects({
      permission: 'document.owner',
      resource: 'document:1',
    });
    expect(result.members).toEqual(['user:alice']);
    expect(result.allOfTypes).toEqual([]);
    expect(isExhaustive(result)).toBe(true);
  });

  it('follows a union', async () => {
    const result = await setup([
      T('user:alice', 'owner', 'document:1'),
      T('user:bob', 'viewer', 'document:1'),
    ]).listSubjects({ permission: 'document.read', resource: 'document:1' });
    expect(result.members).toEqual(['user:alice', 'user:bob']);
  });

  it('expands a userset into its members', async () => {
    const result = await setup([
      T('team:eng#member', 'editor', 'document:1'),
      T('user:alice', 'member', 'team:eng'),
      T('user:bob', 'member', 'team:eng'),
    ]).listSubjects({ permission: 'document.editor', resource: 'document:1' });
    expect(result.members).toEqual(['user:alice', 'user:bob']);
  });

  // A wildcard is "every user", which has no finite enumeration. Reporting a
  // truncated list of them would be a lie, so it stays symbolic.
  it('reports a wildcard as a symbolic type, not a list', async () => {
    const result = await setup([T('user:*', 'anyone', 'document:1')]).listSubjects({
      permission: 'document.public',
      resource: 'document:1',
    });
    expect(result.allOfTypes).toEqual(['user']);
    expect(result.members).toEqual([]);
    expect(isExhaustive(result)).toBe(false);
  });

  it('intersects the two branches, keeping only subjects with both', async () => {
    // alice is owner *and* editor; bob is only an owner, and an intersection
    // needs both. `write` is deliberately not used here: its `except banned`
    // carries a wildcard, which would subtract everyone.
    const result = await setup([
      T('user:alice', 'owner', 'document:1'),
      T('user:alice', 'editor', 'document:1'),
      T('user:bob', 'owner', 'document:1'),
    ]).listSubjects({ permission: 'document.both', resource: 'document:1' });
    expect(result.members).toEqual(['user:alice']);
  });

  it('subtracts a wildcard except side from everyone', async () => {
    // `write` excludes `banned`, which is declared wildcard — so every user is
    // banned and the honest answer is nobody.
    const result = await setup([T('user:alice', 'owner', 'document:1')]).listSubjects({
      permission: 'document.write',
      resource: 'document:1',
    });
    expect(result.members).toEqual([]);
    expect(result.allOfTypes).toEqual([]);
  });

  it('subtracts the except side', async () => {
    const result = await setup([
      T('user:alice', 'owner', 'document:1'),
      T('user:alice', 'editor', 'document:1'),
      T('user:alice', 'banned', 'document:1'),
    ]).listSubjects({ permission: 'document.write', resource: 'document:1' });
    expect(result.members).toEqual([]);
  });

  it('keeps a symbolic base symbolic after a subtraction', async () => {
    const result = await setup([
      T('user:*', 'owner', 'document:1'),
      T('user:alice', 'internal', 'document:1'),
    ]).listSubjects({ permission: 'document.wide', resource: 'document:1' });
    expect(result.allOfTypes).toEqual(['user']);
    expect(result.excluded).toEqual(['user:alice']);
  });

  it('follows inheritance backwards to a parent', async () => {
    const result = await setup([
      T('folder:7', 'parent', 'document:5'),
      T('user:alice', 'viewer', 'folder:7'),
    ]).listSubjects({ permission: 'document.inherited', resource: 'document:5' });
    expect(result.members).toEqual(['user:alice']);
  });

  it('respects a condition', async () => {
    const denied = await setup([
      {
        ...T('user:alice', 'owner', 'document:1'),
        condition: 'strict',
        context: { region: 'us' },
      },
    ]).listSubjects({ permission: 'document.owner', resource: 'document:1' });
    expect(denied.members).toEqual([]);

    const allowed = await setup([
      {
        ...T('user:alice', 'owner', 'document:1'),
        condition: 'strict',
        context: { region: 'eu' },
      },
    ]).listSubjects({ permission: 'document.owner', resource: 'document:1' });
    expect(allowed.members).toEqual(['user:alice']);
  });

  it('returns the empty set for a resource nobody holds anything on', async () => {
    const result = await setup().listSubjects({
      permission: 'document.read',
      resource: 'document:1',
    });
    expect(result.members).toEqual([]);
    expect(result.allOfTypes).toEqual([]);
  });

  it('is the inverse of can() over a concrete set', async () => {
    const subjects = ['user:alice', 'user:bob', 'user:carol'];
    const tuples = [
      T('user:alice', 'owner', 'document:1'),
      T('user:bob', 'viewer', 'document:1'),
    ];
    const authz = setup(tuples);
    const listed = await authz.listSubjects({
      permission: 'document.read',
      resource: 'document:1',
    });

    for (const subject of subjects) {
      const allowed = await authz.can(subject, 'document.read', 'document:1');
      expect(listed.members.includes(subject), `${subject} listed/allowed agree`).toBe(
        allowed,
      );
    }
  });

  it('rejects an unknown permission', async () => {
    await expect(
      setup().listSubjects({ permission: 'document.fly', resource: 'document:1' }),
    ).rejects.toThrow();
  });
});

/** A model with a single direct relation, for budget and shape checks. */
const flatModel = defineModel({
  types: {
    user: defineType({}),
    doc: defineType({ relations: { owner: relation(['user']) } }),
  },
});

describe('listResources reports truncation', () => {
  const tuples: Tuple[] = Array.from({ length: 40 }, (_, i) => ({
    subject: 'user:alice',
    relation: 'owner',
    resource: `doc:${i}`,
  }));

  it('says the list is partial when the budget cuts it short', async () => {
    // The budget applies per evaluated resource, so a limit of one node denies
    // each of the forty. The flag is the part that matters: without it this is
    // indistinguishable from "alice can read nothing".
    const authz = createAuthz({
      model: flatModel,
      store: testStore(tuples),
      limits: { maxNodes: 1 },
    });
    const result = await authz.listResources({
      subject: 'user:alice',
      permission: 'doc.owner',
    });
    expect(result.truncated).toBe(true);
    expect(result.resources).toEqual([]);
  });

  it('says the list is complete when it is', async () => {
    const authz = createAuthz({ model: flatModel, store: testStore(tuples) });
    const result = await authz.listResources({
      subject: 'user:alice',
      permission: 'doc.owner',
    });
    expect(result.truncated).toBe(false);
    expect(result.resources).toHaveLength(40);
  });

  it('refuses a permission on a type the model does not declare', async () => {
    // The client validates the permission before enumerating, so a typo fails
    // loudly instead of returning a confident empty list.
    const authz = createAuthz({ model: flatModel, store: testStore(tuples) });
    await expect(
      authz.listResources({ subject: 'user:alice', permission: 'ghost.owner' }),
    ).rejects.toThrow(/does not declare/);
  });
});
