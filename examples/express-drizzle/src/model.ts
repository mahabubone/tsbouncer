import {
  defineCondition,
  defineModel,
  defineType,
  permission,
  relation,
  ttu,
  wildcard,
} from '@tsbouncer/tsbouncer';

/**
 * A real system's access model, in one file.
 *
 * The premise: access rules were not designed up front, they accumulated. There is
 * a role system from the old monolith, a folder tree from the file manager, a
 * sharing feature, a legal hold, a data-residency requirement, a seat limit, and an
 * account suspension switch. All of them are live at once, and a real model has to
 * hold all of them without one quietly cancelling another.
 *
 * So this model carries all three styles deliberately, and the interesting part is
 * the places they *interact*:
 *
 *   RBAC   a `role` is an object with holders, attached to a project. Onboarding
 *          someone is one write, not one per document.
 *   ReBAC  folder inheritance via tuple-to-userset, team membership, direct
 *          ownership, a wildcard for published documents, and an exclusion that
 *          beats all of them.
 *   ABAC   three conditions: one with a constraint the writer bound to the grant,
 *          one decided only by request state, one that mixes both.
 */
export const model = defineModel({
  types: {
    user: defineType({}),

    /**
     * Tenancy.
     *
     * There is no tenancy anywhere in the engine — no `organization_id` on a
     * tuple, no cross-tenant rule, no special case for `*`. Isolation here is just
     * two organizations with disjoint ids and grants, which means it is enforced
     * by the data rather than by a feature nobody remembered to turn on.
     */
    organization: defineType({
      relations: {
        admin: relation('user').or(relation('role', { through: 'holder' })),
        member: relation('user').or(relation('role', { through: 'holder' })),
        // A wildcard here would ban every user on earth from administering, which
        // is not what anyone wants. It is written out anyway to make the
        // interaction with `except` visible: see `administer` below.
        banned: relation('user').or(relation('role', { through: 'holder' })),
      },
      permissions: {
        // Both roles administer, minus anyone banned. `except` is not a filter on
        // the way in — it is evaluated on *both* sides, and a banned admin is
        // refused even though the admin edge resolved.
        administer: permission.or('admin', 'member').except('banned'),
      },
    }),

    team: defineType({
      relations: { member: relation('user') },
      permissions: { read: permission.or('member') },
    }),

    role: defineType({
      relations: { holder: relation('user') },
      permissions: { use: permission.or('holder') },
    }),

    /**
     * RBAC attached to a resource, and the template for the rest of the model:
     * every relation takes a direct user, a role's holders, or a team's members.
     */
    project: defineType({
      relations: {
        owner: relation('user'),
        admin: relation('user').or(relation('role', { through: 'holder' })),
        editor: relation('user')
          .or(relation('role', { through: 'holder' }))
          .or(relation('team', { through: 'member' })),
        viewer: relation('user')
          .or(relation('role', { through: 'holder' }))
          .or(relation('team', { through: 'member' })),
        banned: relation('user'),
      },
      permissions: {
        read: permission.or('owner', 'admin', 'editor', 'viewer'),
        write: permission.or('owner', 'admin', 'editor'),
        manage: permission.or('owner', 'admin'),
        /**
         * Two conditions on the same permission, which is where this model earns
         * its keep:
         *
         *   - inheritance, so access granted on a project reaches its folders;
         *   - the ban, which is checked on *both* branches and therefore beats an
         *     inherited grant as well as a direct one.
         *
         * A hand-written check that returns early when the first branch succeeds
         * gets this exactly backwards, and that is the bug this library exists to
         * make impossible.
         */
        publish: permission.or('owner', 'admin', 'editor').except('banned'),
      },
    }),

    /**
     * A tree. `parent` is a relation on the *child*, which trips up almost
     * everyone: `{ subject: 'folder:root', relation: 'parent', resource: 'folder:eng' }`
     * reads "folder:eng's parent is folder:root", and write-time validation
     * rejects the reverse.
     *
     * Access flows *down* the tree through `ttu`, because the only way to inherit
     * is to walk from the child to its parent and ask that parent the same
     * question. A userset edge cannot do it: a userset edge names a relation, and
     * `read` here is a permission.
     */
    folder: defineType({
      relations: {
        owner: relation('user').or(relation('team', { through: 'member' })),
        parent: relation('folder'),
        viewer: relation('user').or(relation('team', { through: 'member' })),
        banned: relation('user'),
      },
      permissions: {
        read: permission.or('owner', 'viewer', ttu('parent', 'read')),
        write: permission.or('owner', ttu('parent', 'write')),
        manage: permission.or('owner', ttu('parent', 'manage')),
      },
    }),

    /**
     * The leaf, and where all four requirements meet.
     */
    document: defineType({
      relations: {
        owner: relation('user'),
        editor: relation('user')
          .or(relation('role', { through: 'holder' }))
          .or(relation('team', { through: 'member' })),
        viewer: relation('user')
          .or(relation('role', { through: 'holder' }))
          .or(relation('team', { through: 'member' })),
        /** The approver role, used by the dual-key rule on `publish` below. */
        approver: relation('user').or(relation('role', { through: 'holder' })),
        parent: relation('folder'),
        banned: relation('user'),
        /**
         * A published document, and a share list that can also name people.
         *
         * `user:*` on `shared` opens a document to every signed-in user, and the
         * banned edge still applies to individuals: a wildcard makes a resource
         * public, it does not make an exclusion unreachable.
         *
         * The union is not decoration, and it is worth knowing why. A *wildcard
         * edge accepts no direct subject* — write-time validation rejects
         * `{ subject: 'user:*', relation: 'shared', ... }` against a bare
         * `wildcard('user')` with "does not accept a user subject". So a relation
         * that has to hold `user:*` must also declare the direct edge, which is
         * what you want anyway: a share list that can name people and can also be
         * flipped to everyone.
         */
        shared: relation('user').or(wildcard('user')),
      },
      permissions: {
        read: permission
          .or('owner', 'editor', 'viewer', 'shared', ttu('parent', 'read'))
          .except('banned'),

        /**
         * Inherited from the folder, and that is the whole rule — with one thing
         * the model deliberately does *not* express.
         *
         * A document can be under legal hold, which blocks edits. That is state on
         * the document row, not an edge anyone grants, so the natural instinct is a
         * condition: `condition: 'notOnHold'`. Do not. A condition's unbound
         * parameters are supplied by the request, and a request is the one part of
         * this system an attacker writes. A hold enforced by a condition the
         * caller fills in is not a hold.
         *
         * The route in `app.ts` reads `documents.on_hold` and refuses with 423 after
         * the permission check. Row state is the application's job; edges are the
         * model's.
         */
        write: permission.or('owner', 'editor', ttu('parent', 'write')).except('banned'),

        manage: permission.or('owner', ttu('parent', 'manage')),

        /**
         * Who may countersign. Not a permission anyone is *granted* — it is the
         * question "who is an approver here?", which a route asks with
         * `listSubjects` so it can require a second, different person.
         */
        approve: permission.or('approver'),

        /**
         * Segregation of duties: publishing needs the owner *and* an approver, so a
         * compromised owner account cannot publish on its own.
         *
         * This is the model's only use of an intersection, and it is deliberately
         * an AND of two relations on the *same* document. Note what it is not: a
         * two-person workflow. That would need the second approver to be a
         * different subject from the first, which is a property of the request
         * rather than of a permission — see the `publish` route in `app.ts`.
         */
        publish: permission.allOf('owner', 'approver').except('banned'),
      },
    }),
  },

  conditions: {
    /**
     * Data residency, the writer-bound half.
     *
     * `region` is part of the *grant* — it was decided when the document was
     * shared, and it is stored with the tuple. The caller's region is not in the
     * store at all, because it changes per request, so it arrives as request
     * context.
     *
     * The two halves cannot be confused, and that is enforced rather than
     * documented: a request may fill in a missing key but can never overwrite a
     * bound one. If a caller could rewrite `region` to their own, the condition
     * would be theatre.
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
     * Suspension, the request-only half.
     *
     * No bound parameters, so the entire decision is made of state the caller
     * supplies — and therefore no grant can rescue a suspended account. A missing
     * or non-boolean `suspended` denies rather than passes, which is the only
     * defensible default for a switch whose purpose is to lock people out.
     */
    notSuspended: defineCondition('notSuspended', (ctx) => ctx.suspended === false, {
      params: {},
    }),

    /**
     * Both halves at once, and the reason conditions are a list and not a flag.
     *
     * The grant carries the seat allowance the project was bought with; the
     * request carries what the organization is actually using right now. A
     * `boolean`-and-`boolean` policy cannot express "within the allowance *they*
     * were given", only "if the feature flag is on".
     */
    withinSeatBudget: defineCondition(
      'withinSeatBudget',
      (ctx) => {
        const { seats, usedSeats } = ctx;
        if (typeof seats !== 'number' || typeof usedSeats !== 'number') return false;
        return usedSeats < seats;
      },
      { params: { seats: 'number' as const } },
    ),
  },
});
