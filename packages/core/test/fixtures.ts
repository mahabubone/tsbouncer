import type { Authz, Tuple } from '../src/index.js';
import {
  createAuthz,
  defineModel,
  defineType,
  permission,
  relation,
  ttu,
  wildcard,
} from '../src/index.js';
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
    folder: defineType({
      // A userset edge: "the members of a team are viewers".
      relations: { viewer: relation('user').or(relation('team', { through: 'member' })) },
      permissions: { read: permission.or('viewer') },
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
        inherited: permission.or(ttu('parent', 'read')),
      },
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
