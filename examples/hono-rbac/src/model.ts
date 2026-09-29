import { defineModel, defineType, permission, relation } from 'tsbouncer';

/**
 * Role-based access control, and nothing else.
 *
 * This model is deliberately the plainest one in the repository: three types, one
 * idea. If you are new to relationship-based authorization, this is the shape to
 * internalise before the folder trees in the Express example.
 *
 * The idea is that **a document never names a person.**
 *
 *   { subject: 'user:alice', relation: 'editor', resource: 'document:3' }
 *
 * is the version that does not scale, because onboarding someone is a write per
 * document. Here a document names a *role*, and the role names its holders:
 *
 *   { subject: 'role:acme:editor', relation: 'editor', resource: 'document:3' }
 *
 * `relation('role', { through: 'holder' })` is what turns that into "every user
 * who holds this role". Assigning a person to a role is one write that affects
 * every document the role is attached to, which is the entire point of RBAC.
 *
 * A userset edge must name a **relation**, never a permission — `holder` is a
 * relation, so this works, and `use` below is a permission, so it would not.
 */
export const model = defineModel({
  types: {
    user: defineType({}),

    /**
     * A role is a real object with real holders, not a string on a user record.
     * That is what makes "who is an editor?" answerable, and it is what lets a
     * role be attached to a document without the document knowing who holds it.
     */
    role: defineType({
      relations: { holder: relation('user') },
      // Not used for authorization here. It exists so the type has a permission of
      // its own, which is a reminder that roles are objects and not magic words.
      permissions: { use: permission.or('holder') },
    }),

    document: defineType({
      relations: {
        owner: relation('user'),
        editor: relation('user').or(relation('role', { through: 'holder' })),
        viewer: relation('user').or(relation('role', { through: 'holder' })),
      },
      permissions: {
        read: permission.or('owner', 'editor', 'viewer'),
        write: permission.or('owner', 'editor'),
        /**
         * Who may change *who has access*. Ownership only — an editor can change
         * the content of a document, never its access list. Splitting these is the
         * difference between a document system and a security incident.
         */
        manage: permission.or('owner'),
      },
    }),
  },
});
