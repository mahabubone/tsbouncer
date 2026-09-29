import { describe, expect, it } from 'vitest';
import {
  createAuthz,
  defineCondition,
  defineModel,
  defineType,
  permission,
  relation,
  type SubjectSet,
  wildcard,
} from '../../src/kernel/index.js';
import { setup, T } from './fixtures.js';

/**
 * `can`, `listResources`, and `listSubjects` must agree.
 *
 * They are three code paths over one graph, and nothing structurally stops one
 * from adopting a different reading of the model. That is not hypothetical:
 * `listSubjects` once treated a *declared* wildcard edge as "every subject of
 * this type" while `can` required a stored `user:*` tuple, so an empty `banned`
 * relation made the access list report nobody while every decision said allowed.
 * The failure is silent, it lives in the query layer rather than the evaluator,
 * and no single-path test catches it.
 *
 * These assert the *relationships between* the answers rather than their literal
 * values, so they keep holding as the model grows.
 */

const model = defineModel({
  types: {
    user: defineType({}),
    team: defineType({ relations: { member: relation(['user']) } }),
    doc: defineType({
      relations: {
        owner: relation(['user']),
        editor: relation('user').or(relation('team', { through: 'member' })),
        // Both are declared wildcard. Only `anyone` gets a stored `user:*` tuple
        // in the seed, which is exactly the distinction under test.
        banned: relation('user').or(wildcard('user')),
        anyone: relation('user').or(wildcard('user')),
      },
      permissions: {
        read: permission.or('owner', 'editor', 'anyone'),
        write: permission.or('owner', 'editor').except('banned'),
      },
    }),
  },
});

const seed = [
  T('user:alice', 'owner', 'doc:1'),
  T('user:alice', 'editor', 'doc:1'),
  T('user:mallory', 'banned', 'doc:1'),
  T('user:alice', 'member', 'team:eng'),
  T('user:bob', 'member', 'team:eng'),
  T('user:*', 'anyone', 'doc:2'),
];

const SUBJECTS = ['user:alice', 'user:bob', 'user:mallory', 'user:dana'] as const;
const RESOURCES = ['doc:1', 'doc:2'] as const;
const PERMISSIONS = ['read', 'write'] as const;

/** A client over the local model, seeded with an arbitrary dataset. */
const client = (tuples: readonly ReturnType<typeof T>[] = seed) =>
  createAuthz({ model, store: setup(tuples).store });

/** A set that claims to be a complete list, and so can be compared exactly. */
const isComplete = (set: SubjectSet): boolean =>
  set.allOfTypes.length === 0 && !set.truncated;

describe('query-path agreement', () => {
  for (const name of PERMISSIONS) {
    it(`listSubjects agrees with can on ${name}`, async () => {
      const authz = client();
      for (const resource of RESOURCES) {
        const set = await authz.listSubjects({ permission: `doc.${name}`, resource });
        if (!isComplete(set)) continue;

        for (const subject of SUBJECTS) {
          const allowed = await authz.can(subject, `doc.${name}`, resource);
          expect(set.members.includes(subject), `${subject}/${resource}/${name}`).toBe(
            allowed,
          );
        }
      }
    });
  }

  it('listResources reports nothing can() denies', async () => {
    for (const subject of SUBJECTS) {
      const authz = client();
      const { resources } = await authz.listResources({
        subject,
        permission: 'doc.read',
      });
      for (const resource of resources) {
        expect(
          await authz.can(subject, 'doc.read', resource),
          `${subject} was listed for ${resource} but can() denies it`,
        ).toBe(true);
      }
    }
  });

  it('listResources omits nothing can() allows, when not truncated', async () => {
    for (const subject of SUBJECTS) {
      const authz = client();
      const { resources, truncated } = await authz.listResources({
        subject,
        permission: 'doc.read',
      });
      if (truncated) continue;

      for (const resource of RESOURCES) {
        if (await authz.can(subject, 'doc.read', resource)) {
          expect(
            resources,
            `${subject} can read ${resource} but it was not listed`,
          ).toContain(resource);
        }
      }
    }
  });

  it('a declared-wildcard relation with no tuple excludes nobody', async () => {
    // The concrete shape of the original bug, kept as a named regression: a ban
    // list that is simply empty must not read as "everyone is banned".
    const authz = client([
      T('user:alice', 'owner', 'doc:1'),
      T('user:alice', 'editor', 'doc:1'),
    ]);
    const set = await authz.listSubjects({ permission: 'doc.write', resource: 'doc:1' });

    expect(set.members).toEqual(['user:alice']);
    expect(set.allOfTypes).toEqual([]);
    expect(await authz.can('user:alice', 'doc.write', 'doc:1')).toBe(true);
  });

  it('a stored wildcard tuple does exclude everyone', async () => {
    // The contrast case. The difference is the tuple, not the declaration.
    const authz = client([
      T('user:alice', 'owner', 'doc:1'),
      T('user:alice', 'editor', 'doc:1'),
      T('user:*', 'banned', 'doc:1'),
    ]);
    const set = await authz.listSubjects({ permission: 'doc.write', resource: 'doc:1' });

    expect(set.members).toEqual([]);
    expect(set.allOfTypes).toEqual([]);
    expect(await authz.can('user:alice', 'doc.write', 'doc:1')).toBe(false);
  });
});

/**
 * Conditions must reach the list queries.
 *
 * `ListResourcesQuery` and `ListSubjectsQuery` both declare a `context`, and the
 * query implementations both accept one — but the client built its internal input
 * without forwarding it. A conditionally-granted resource was therefore allowed
 * by `check` and missing from `listResources`, silently, with the public type
 * promising the option was honoured. A file browser built on that hides
 * documents the user can open.
 */
const conditional = defineModel({
  types: {
    user: defineType({}),
    doc: defineType({
      relations: { viewer: relation('user') },
      permissions: { read: permission.or('viewer') },
    }),
  },
  conditions: {
    sameRegion: defineCondition(
      'sameRegion',
      (ctx) => {
        const { region, callerRegion } = ctx;
        if (typeof region !== 'string' || typeof callerRegion !== 'string') return false;
        return region === callerRegion;
      },
      { params: { region: 'string' as const } },
    ),
  },
});

const conditionalTuples = [
  {
    subject: 'user:dana',
    relation: 'viewer',
    resource: 'doc:eu',
    condition: 'sameRegion',
    context: { region: 'eu' },
  },
  {
    subject: 'user:dana',
    relation: 'viewer',
    resource: 'doc:us',
    condition: 'sameRegion',
    context: { region: 'us' },
  },
  T('user:erin', 'viewer', 'doc:eu'),
];

const conditionalClient = (context?: Record<string, unknown>) => {
  const client = createAuthz({
    model: conditional,
    store: setup(conditionalTuples).store,
  });
  return { client, context };
};

describe('condition context reaches every query', () => {
  it('listResources applies the caller context', async () => {
    const { client, context } = conditionalClient({ callerRegion: 'eu' });

    const eu = await client.listResources({
      subject: 'user:dana',
      permission: 'doc.read',
      context,
    });
    expect(eu.resources).toEqual(['doc:eu']);

    const us = await client.listResources({
      subject: 'user:dana',
      permission: 'doc.read',
      context: { callerRegion: 'us' },
    });
    expect(us.resources).toEqual(['doc:us']);
  });

  it('listResources agrees with check for each conditioned resource', async () => {
    const { client, context } = conditionalClient({ callerRegion: 'eu' });
    const { resources } = await client.listResources({
      subject: 'user:dana',
      permission: 'doc.read',
      context,
    });
    for (const resource of resources) {
      const decision = await client.check(
        { subject: 'user:dana', permission: 'doc.read', resource },
        { context },
      );
      expect(decision.allowed).toBe(true);
    }
  });

  it('listSubjects applies the caller context', async () => {
    const { client, context } = conditionalClient({ callerRegion: 'eu' });

    // `doc:eu` has two grants: dana's, which is conditional on the caller's
    // region, and erin's, which is unconditional. So the wrong region removes
    // exactly one of them — which is the shape that matters.
    const eu = await client.listSubjects({
      permission: 'doc.read',
      resource: 'doc:eu',
      context,
    });
    expect([...eu.members].sort()).toEqual(['user:dana', 'user:erin']);

    const us = await client.listSubjects({
      permission: 'doc.read',
      resource: 'doc:eu',
      context: { callerRegion: 'us' },
    });
    expect([...us.members].sort()).toEqual(['user:erin']);
  });

  it('can() takes options, so a condition is expressible in the boolean form', async () => {
    // Without the fourth argument there was no way to ask this at all, and a
    // JavaScript caller who passed it anyway had it ignored — a deny that looked
    // like a policy decision.
    const { client, context } = conditionalClient({ callerRegion: 'eu' });

    expect(await client.can('user:dana', 'doc.read', 'doc:eu', { context })).toBe(true);
    expect(
      await client.can('user:dana', 'doc.read', 'doc:eu', {
        context: { callerRegion: 'us' },
      }),
    ).toBe(false);
  });

  it('an unconditioned grant is unaffected by context', async () => {
    const { client } = conditionalClient({ callerRegion: 'us' });
    const { resources } = await client.listResources({
      subject: 'user:erin',
      permission: 'doc.read',
      context: { callerRegion: 'us' },
    });
    expect(resources).toEqual(['doc:eu']);
  });
});
