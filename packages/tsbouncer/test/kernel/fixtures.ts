import type { Authz, Tuple } from '../../src/kernel/index.js';
import {
  createAuthz,
  defineCondition,
  defineModel,
  defineType,
  permission,
  relation,
  ttu,
  wildcard,
} from '../../src/kernel/index.js';
import { testStore } from './store.js';

/**
 * The model every engine test runs against.
 *
 * It is deliberately loaded with the shapes that are easy to get wrong: a
 * userset edge, a *direct* team edge with the same relation name, a wildcard, an
 * exclusion over an intersection, a delegating relation, and a tuple-to-userset
 * that is not implemented yet.
 */
export const model = defineModel({
  types: {
    user: defineType({}),
    team: defineType({ relations: { member: relation(['user']) } }),
    // The TTU chain. `folder.parent -> archive` and `archive.parent -> folder`
    // form a loop, which the model validator cannot see (it only follows
    // same-type `computed` edges) and the runtime cycle guard has to catch.
    archive: defineType({
      relations: { viewer: relation(['user']), parent: relation('folder') },
      permissions: { read: permission.or('viewer', ttu('parent', 'read')) },
    }),
    folder: defineType({
      // A userset edge: "the members of a team are viewers".
      relations: {
        viewer: relation('user').or(relation('team', { through: 'member' })),
        parent: relation('archive'),
        // A multi-type parent, so a tuple-to-userset can land on either.
        inherits: relation(['folder', 'archive']),
      },
      permissions: {
        read: permission.or('viewer', ttu('parent', 'read'), ttu('inherits', 'read')),
      },
    }),
    document: defineType({
      relations: {
        owner: relation(['user']),
        editor: relation('user').or(relation('team', { through: 'member' })),
        // A *direct* team edge: "the team object itself is a viewer". This is a
        // different grant from the userset edge above, and mixing them up is the
        // easiest mistake to make with this model.
        viewer: relation(['user', 'team']),
        parent: relation('folder'),
        banned: relation('user').or(wildcard('user')),
        anyone: relation('user').or(wildcard('user')),
        // A relation may delegate to another member of its own type, and may
        // carry a rewrite. Both are legal, and both have to be understood by
        // write-time subject validation as well as by the evaluator.
        steward: permission.or('owner', relation(['user'])),
        superuser: permission.allOf('owner').except('banned'),
      },
      permissions: {
        read: permission.or('owner', 'editor', 'viewer'),
        write: permission.allOf('owner', 'editor').except('banned'),
        public: permission.or('anyone'),
        // One level of inheritance from a parent folder. Because
        // `folder.read` carries its own tuple-to-userset, this also reaches two
        // levels down the archive chain with no extra permission here.
        inherited: permission.or(ttu('parent', 'read')),
        // A diamond: two branches that both resolve `owner`. Evaluating it
        // visits `owner` twice but must read the store once — the second visit
        // is the per-request memo hit, and a key that is too coarse returns the
        // *wrong* answer there rather than a slow one.
        diamond: permission.allOf('steward', 'superuser'),
      },
    }),
  },
  conditions: {
    // The canonical split: `resourceRegion` is bound by the tuple at write time,
    // `userTier` arrives with the request. Only the first is a declared param.
    inRegion: defineCondition(
      'inRegion',
      (ctx) => ctx.userTier === 'pro' && ctx.resourceRegion === 'eu',
      { params: { resourceRegion: 'string' } },
    ),
    always: defineCondition('always', () => true),
    explodes: defineCondition('explodes', () => {
      throw new Error('boom');
    }),
    strict: defineCondition('strict', (ctx) => ctx.region === 'eu', {
      params: { region: 'string' as const },
    }),
  },
});

export function T(
  subject: string,
  relation: string,
  resource: string,
  extra: Partial<Tuple> = {},
): Tuple {
  return { subject, relation, resource, ...extra };
}

export function setup(tuples: readonly Tuple[] = []): Authz {
  return createAuthz({ model, store: testStore(tuples) });
}
