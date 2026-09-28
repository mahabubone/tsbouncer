import { defineModel, defineType, permission, relation, ttu, wildcard } from 'tsbouncer';

/**
 * A small but complete model: direct ownership, team membership, a wildcard, and
 * an exclusion. If a shape is missing here it is probably not missing on purpose.
 */
export const model = defineModel({
  types: {
    user: defineType({}),

    team: defineType({
      relations: { member: relation(['user']) },
      permissions: { read: permission.or('member') },
    }),

    folder: defineType({
      // A userset edge: the members of a team are viewers.
      relations: {
        viewer: relation('user').or(relation('team', { through: 'member' })),
        parent: relation('folder'),
      },
      // Inherit read from the parent folder, so folders nest.
      permissions: { read: permission.or('viewer', ttu('parent', 'read')) },
    }),

    document: defineType({
      relations: {
        owner: relation(['user']),
        editor: relation('user').or(relation('team', { through: 'member' })),
        // A direct team edge: the team object itself, not its members.
        team: relation(['team']),
        parent: relation('folder'),
        // Wildcards: `user:*` on either of these covers every user.
        banned: relation('user').or(wildcard('user')),
        anyone: relation('user').or(wildcard('user')),
      },
      permissions: {
        // Reading is permissive — and inherits from the parent folder.
        read: permission.or('owner', 'editor', 'team', ttu('parent', 'read')),
        write: permission.allOf('owner', 'editor').except('banned'),
        // Public to everyone, including users who do not exist yet.
        public: permission.or('anyone'),
      },
    }),
  },
});
