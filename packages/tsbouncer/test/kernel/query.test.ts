import { describe, expect, it } from 'vitest';
import {
  createAuthz,
  DEFAULT_LIMITS,
  defineCondition,
  defineModel,
  defineType,
  isExhaustive,
  listResources,
  permission,
  type ReadTupleQuery,
  relation,
  type Tuple,
  type TupleStore,
  ttu,
  wildcard,
} from '../../src/kernel/index.js';
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

  it('excludes members whose condition does not hold', async () => {
    const authz = setup([
      T('user:alice', 'member', 'team:eng', {
        condition: 'strict',
        context: { region: 'eu' },
      }),
      T('user:bob', 'member', 'team:eng', {
        condition: 'strict',
        context: { region: 'us' },
      }),
    ]);
    // The tuple's binding wins: no request context can admit bob.
    const result = await authz.expand(
      { subject: 'team:eng#member' },
      { context: { region: 'eu' } },
    );
    expect(result.subjects).toEqual(['user:alice']);
  });

  it('fills missing condition params from the request context', async () => {
    const authz = setup([T('user:alice', 'member', 'team:eng', { condition: 'strict' })]);
    const allowed = await authz.expand(
      { subject: 'team:eng#member' },
      { context: { region: 'eu' } },
    );
    expect(allowed.subjects).toEqual(['user:alice']);
    const denied = await authz.expand(
      { subject: 'team:eng#member' },
      { context: { region: 'us' } },
    );
    expect(denied.subjects).toEqual([]);
  });

  it('agrees with can() over a concrete set', async () => {
    const subjects = ['user:alice', 'user:bob', 'user:carol'];
    const authz = setup([
      T('user:alice', 'member', 'team:eng'),
      T('user:bob', 'member', 'team:eng', {
        condition: 'strict',
        context: { region: 'us' },
      }),
    ]);
    const expanded = await authz.expand({ subject: 'team:eng#member' });
    for (const subject of subjects) {
      const allowed = await authz.can(subject, 'team.member', 'team:eng');
      expect(
        expanded.subjects.includes(subject),
        `${subject} expanded/allowed agree`,
      ).toBe(allowed);
    }
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

  it('walks a chain that repeats a type, which is the same-type case', async () => {
    /*
     * The test above walks document → folder → archive, so each hop has its own
     * type. A real folder tree is self-referential: folder → folder → folder, with
     * the leaves hanging off the bottom. That is the case the walk used to get
     * wrong.
     *
     * It memoised the edges it had already followed on `type:relation`, so two
     * folders of the same type shared one token: the first folder's `parent` edges
     * were walked and the second folder's never were. Everything below the second
     * folder was therefore never a candidate, and `can` allowed documents that
     * `listResources` did not list — the exact list/check disagreement this file is
     * about, arrived at from the query layer rather than the evaluator.
     */
    const selfModel = defineModel({
      types: {
        user: defineType({}),
        team: defineType({ relations: { member: relation('user') } }),
        folder: defineType({
          relations: {
            viewer: relation('user').or(relation('team', { through: 'member' })),
            // Self-referential, which is the whole point: `folder` -> `folder`.
            parent: relation('folder'),
          },
          permissions: { read: permission.or('viewer', ttu('parent', 'read')) },
        }),
        document: defineType({
          relations: { parent: relation('folder') },
          permissions: { read: permission.or(ttu('parent', 'read')) },
        }),
      },
    });

    // `alice` is a viewer of folder:eng only. document:1 sits directly in it;
    // document:2 and document:3 sit one folder further down, and are reachable
    // only if the walk keeps going after it has already followed `folder:parent`.
    const deep = [
      T('user:alice', 'viewer', 'folder:eng'),
      T('folder:root', 'parent', 'folder:eng'),
      T('folder:eng', 'parent', 'folder:infra'),
      T('folder:eng', 'parent', 'document:1'),
      T('folder:infra', 'parent', 'document:2'),
      T('folder:infra', 'parent', 'document:3'),
    ];
    const authz = createAuthz({ model: selfModel, store: testStore(deep) });

    const { resources } = await authz.listResources({
      subject: 'user:alice',
      permission: 'document.read',
    });

    // Asserted against `can` rather than against a literal, so the two paths are
    // held to each other instead of to this list.
    for (const resource of ['document:1', 'document:2', 'document:3']) {
      expect(await authz.can('user:alice', 'document.read', resource)).toBe(true);
      expect(resources, `${resource} is readable but was not listed`).toContain(resource);
    }
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

  // A 5s default timeout is for unit tests; this one evaluates 600 candidates
  // twice over 1,200 rows, which is slow on purpose (fewer rows would fit one
  // scan page and prove nothing). Under parallel load it needs headroom.
  it('pages the set-grant scan on stores with cursors, without changing the answer', {
    timeout: 60_000,
  }, async () => {
    // 600 teams put 1,200 rows behind read({}) — past one scan page — so a
    // store advertising pagination must be walked by cursor rather than in one
    // round trip. The paged answer has to equal the unpaged one exactly: paging
    // the scan is a transport detail, and a transport detail that changes
    // decisions is a bug.
    const teams = Array.from({ length: 600 }, (_, i) => `team:t${i}`);
    const tuples: Tuple[] = teams.flatMap((team, i) => [
      T('user:alice', 'member', team),
      T(`${team}#member`, 'editor', `document:${i}`),
    ]);
    const request = { subject: 'user:alice', permission: 'document.read' };
    // Generous on both axes: this test is about the node budget and the paging,
    // not the wall clock, and instrumented runs are slower than plain ones.
    const limits = { ...DEFAULT_LIMITS, maxNodes: 200_000, maxDurationMs: 60_000 };

    const control = await createAuthz({
      model,
      store: testStore(tuples),
      limits,
    }).listResources(request);
    expect(control.truncated).toBe(false);
    expect(control.resources).toHaveLength(600);

    const pagedQueries: ReadTupleQuery[] = [];
    const base = testStore(tuples);
    const paged: TupleStore = {
      ...base,
      capabilities: Object.freeze({ ...base.capabilities, pagination: true }),
      async read(query: ReadTupleQuery = {}) {
        const { limit, cursor, ...rest } = query;
        const items = (await base.read(rest)).items;
        const offset = cursor === undefined ? 0 : Number(cursor);
        const page =
          limit === undefined ? items.slice(offset) : items.slice(offset, offset + limit);
        const next = offset + page.length;
        pagedQueries.push(query);
        return {
          items: page,
          cursor: next < items.length ? String(next) : undefined,
        };
      },
    };
    const result = await createAuthz({ model, store: paged, limits }).listResources(
      request,
    );

    expect(result).toEqual(control);
    expect(pagedQueries.some((q) => q.cursor !== undefined)).toBe(true);
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
    // Here `banned` really does hold a `user:*` tuple, so every user is banned
    // and the honest answer is nobody. The contrast with the next test is the
    // point: a *stored* wildcard subtracts everyone, a merely *declared* one
    // does not.
    const result = await setup([
      T('user:alice', 'owner', 'document:1'),
      T('user:alice', 'editor', 'document:1'),
      T('user:*', 'banned', 'document:1'),
    ]).listSubjects({
      permission: 'document.write',
      resource: 'document:1',
    });
    expect(result.members).toEqual([]);
    expect(result.allOfTypes).toEqual([]);
  });

  it('subtracts the except side to an empty set', async () => {
    // alice satisfies `owner` but not `editor`, so the intersection is already
    // empty before the exclusion. The exclusion is asserted separately, below,
    // with a base that is non-empty.
    const result = await setup([
      T('user:alice', 'owner', 'document:1'),
      T('user:alice', 'editor', 'document:1'),
      T('user:alice', 'banned', 'document:1'),
    ]).listSubjects({ permission: 'document.write', resource: 'document:1' });
    expect(result.members).toEqual([]);
  });

  it('keeps the base when the banned relation is empty', async () => {
    // `banned` is declared wildcard in the fixture model, and has no tuple here.
    // Declaring the edge says the relation accepts a `user:*` subject; it does not
    // ban everyone. Reading it otherwise made `listSubjects` contradict `can`.
    const result = await setup([
      T('user:alice', 'owner', 'document:1'),
      T('user:alice', 'editor', 'document:1'),
    ]).listSubjects({ permission: 'document.write', resource: 'document:1' });
    expect(result.members).toEqual(['user:alice']);
    expect(result.excluded).toEqual([]);
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

/**
 * A permission that costs more to evaluate than it does to find.
 *
 * The candidate walk over one document is two reads; `read` here is an
 * intersection, so every one of its four edges is visited even after the first
 * fails. Any `maxNodes` between the two therefore finishes the walk and stops
 * the evaluation, which is the only shape in which `truncated` can be set by
 * something other than the walk.
 */
const expensiveModel = defineModel({
  types: {
    user: defineType({}),
    doc: defineType({
      relations: {
        owner: relation(['user']),
        editor: relation(['user']),
        viewer: relation(['user']),
        internal: relation(['user']),
      },
      permissions: { read: permission.allOf('owner', 'editor', 'viewer', 'internal') },
    }),
  },
});

const expensiveTuples: Tuple[] = [
  { subject: 'user:alice', relation: 'owner', resource: 'doc:0' },
];

/**
 * A store that counts its own reads.
 *
 * The budget is a promise about *cost*, and the only way to hold a store to it
 * is to count the calls rather than trust the ceiling.
 */
function countingStore(seed: readonly Tuple[]): TupleStore & { readonly reads: number } {
  const inner = testStore(seed);
  const state = { reads: 0 };
  return {
    capabilities: inner.capabilities,
    async read(query) {
      state.reads += 1;
      return inner.read(query);
    },
    async write(input) {
      await inner.write(input);
    },
    async delete(input) {
      await inner.delete(input);
    },
    get reads(): number {
      return state.reads;
    },
  };
}

describe('listResources reports truncation', () => {
  const tuples: Tuple[] = Array.from({ length: 40 }, (_, i) => ({
    subject: 'user:alice',
    relation: 'owner',
    resource: `doc:${i}`,
  }));

  it('says the list is partial when the budget cuts it short', async () => {
    // One node is spent on the candidate walk before any resource is evaluated,
    // so nothing gets as far as a decision. The flag is the part that matters:
    // without it this is indistinguishable from "alice can read nothing".
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

  it('bounds the whole request, not just the walk', async () => {
    // `maxNodes` documents itself as per-request, and a caller setting it to
    // bound request cost expects a bound. Each candidate used to start a fresh
    // `Budget`, so the total was `walk + 40 × per-candidate` and a ceiling of 5
    // still cost 32 store reads. Everything a request does — the walk *and* every
    // evaluation — now spends from one pot.
    for (const maxNodes of [2, 5, 10, 25, 50]) {
      const store = countingStore(tuples);
      const result = await listResources(
        flatModel,
        store,
        { subject: 'user:alice', member: 'owner', resourceType: 'doc' },
        { ...DEFAULT_LIMITS, maxNodes },
      );
      expect(store.reads, `maxNodes=${maxNodes}`).toBeLessThanOrEqual(maxNodes);
      expect(result.resources.every((r) => r.startsWith('doc:'))).toBe(true);
    }
  });

  it('flags a cut the walk never saw, because it happened in an evaluation', async () => {
    // The walk over this dataset costs two store reads, and `read` — an
    // intersection of four direct edges — needs more charges than that to
    // finish. A ceiling anywhere in between therefore completes the walk and
    // cuts the evaluation, which is the one case the flag exists for.
    //
    // `evaluate` converts its own limit error into "not allowed", so this used
    // to come back as a *complete* list of nothing: no resources, no truncation,
    // and a caller free to conclude alice can read nothing. The catch that was
    // meant to notice could never fire, because the error never left
    // `evaluate`.
    for (const maxNodes of [3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const store = countingStore(expensiveTuples);
      const result = await listResources(
        expensiveModel,
        store,
        { subject: 'user:alice', member: 'read', resourceType: 'doc' },
        { ...DEFAULT_LIMITS, maxNodes },
      );
      expect(store.reads, `maxNodes=${maxNodes}`).toBeLessThanOrEqual(maxNodes);
      expect(result.resources, `maxNodes=${maxNodes}`).toEqual([]);
      expect(result.truncated, `maxNodes=${maxNodes}`).toBe(true);
    }
  });

  it('stops calling it truncated once the request really did finish', async () => {
    // The other side of the same ceiling: a budget with room for both halves
    // reports a complete answer, so the flag means work was cut and not merely
    // that a limit was configured.
    const store = countingStore(expensiveTuples);
    const result = await listResources(
      expensiveModel,
      store,
      { subject: 'user:alice', member: 'read', resourceType: 'doc' },
      { ...DEFAULT_LIMITS, maxNodes: 50 },
    );
    expect(result.truncated).toBe(false);
    expect(result.resources).toEqual([]);
  });

  it('returns nothing for a resource type the model does not declare', async () => {
    // Reachable through the public `listResources`, which takes a `resourceType`
    // outright rather than deriving one from a permission string the way the
    // client does. Returning an empty, *untruncated* list is the honest answer:
    // there is nothing to enumerate, and nothing was cut.
    const result = await listResources(
      flatModel,
      testStore(tuples),
      {
        subject: 'user:alice',
        member: 'owner',
        resourceType: 'ghost',
      },
      DEFAULT_LIMITS,
    );
    expect(result).toEqual({ resources: [], truncated: false });
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
