import {
  defineCondition,
  defineModel,
  defineType,
  permission,
  relation,
  ttu,
  wildcard,
} from '@tsbouncer/core';

/**
 * A model that carries all three authorization styles at once, because real
 * systems are not pure — they are mostly ReBAC with RBAC bolted on and ABAC
 * where the rules genuinely depend on state you cannot model as an edge.
 *
 *   RBAC   `role` + a userset edge. Attach a role to a document and every holder
 *          of that role gains the permission. The document does not name users.
 *   ReBAC  folder inheritance, team membership, sharing. The interesting shapes.
 *   ABAC   two conditions on grants: one whose constraints the writer bound, and
 *          one decided entirely by request state.
 *
 * The layers compose, which is the point: a role can be attached to a folder, and
 * the folder's readers inherit it.
 */
export const model = defineModel({
  types: {
    user: defineType({}),

    /**
     * RBAC. A document that names `role:acme:editor` does not know or care who
     * holds it, so onboarding someone is a write against the role rather than a
     * change to every document.
     *
     * `holder` is both the assignment and the thing a userset edge walks: the
     * subject is the role object, and the edge resolves to that role's holders.
     * A userset `through:` must name a relation, not a permission.
     */
    role: defineType({
      relations: { holder: relation('user') },
      permissions: { use: permission.or('holder') },
    }),

    team: defineType({
      relations: { member: relation('user') },
      permissions: { read: permission.or('member') },
    }),

    /**
     * ReBAC. `administer` is workspace-scoped, so an instance role and a tenant
     * role are the same edge at a different level.
     */
    workspace: defineType({
      relations: {
        // An admin may be a named user or the holder of a role, which is how an
        // *instance* role administers a *tenant* without the tenant naming anyone.
        admin: relation('user').or(relation('role', { through: 'holder' })),
        member: relation('user').or(relation('role', { through: 'holder' })),
        banned: relation('user').or(wildcard('user')),
      },
      permissions: {
        administer: permission.or('admin', 'member').except('banned'),
      },
    }),

    /** ReBAC again: a tree, with permissions inherited downward. */
    folder: defineType({
      relations: {
        owner: relation('user').or(relation('team', { through: 'member' })),
        parent: relation('folder'),
      },
      permissions: {
        read: permission.or('owner', ttu('parent', 'read')),
        write: permission.or('owner', ttu('parent', 'write')),
      },
    }),

    document: defineType({
      relations: {
        owner: relation('user'),
        // Two styles on one relation: RBAC through a role, ReBAC through a team,
        // plus the wildcard that makes a document public.
        editor: relation('user')
          .or(relation('role', { through: 'holder' }))
          .or(relation('team', { through: 'member' }))
          .or(wildcard('user')),
        viewer: relation('user').or(relation('team', { through: 'member' })),
        parent: relation('folder'),
        banned: relation('user').or(wildcard('user')),
      },
      permissions: {
        read: permission.or('owner', 'editor', 'viewer', ttu('parent', 'read')),
        /**
         * Two ways in, and the difference between them matters:
         *
         *   - directly, which needs `owner` **and** `editor`. A role alone is not
         *     enough, so attaching `editor` to a document does not hand out write
         *     to everyone who holds it.
         *   - inherited, via a tuple-to-userset to the parent folder's `write`.
         *     This is the only way a *permission* is inherited: a userset edge
         *     names a relation, and `write` is not one.
         *
         * `except` wraps both, and neither branch may short-circuit it.
         */
        write: permission
          .or(permission.allOf('owner', 'editor'), ttu('parent', 'write'))
          .except('banned'),
      },
    }),
  },

  conditions: {
    /**
     * ABAC, writer-bound half. The document's region is part of the grant, so it
     * is stored with the grant. The caller's region is not in the store at all —
     * it changes — so it arrives with the request.
     */
    sameRegion: defineCondition(
      'sameRegion',
      (ctx) => {
        const { region, callerRegion } = ctx;
        if (typeof region !== 'string' || typeof callerRegion !== 'string') return false;
        return region === callerRegion;
      },
      { params: { region: 'string' as const } },
    ),

    /**
     * ABAC, request-only half. No bound parameters, so the whole decision is made
     * of state the caller supplies. A suspended account therefore cannot be
     * rescued by any grant, and a missing key denies rather than passing.
     */
    notSuspended: defineCondition('notSuspended', (ctx) => ctx.suspended === false, {
      params: {},
    }),
  },
});
