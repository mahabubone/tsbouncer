import {
  createAuthz,
  defineModel,
  defineType,
  memoryStore,
  permission,
  relation,
} from 'tsbouncer';

/**
 * Multi-tenancy, with no tenancy anywhere in the engine.
 *
 * The engine understands `type:id` and `type:id#relation` and nothing else. It
 * never resolves a reference to a row, never asks what organisation an id
 * belongs to, and never needs a foreign key into your domain schema. Tenant
 * identity is therefore your decision to make, and the cheapest way to make it
 * is to put it in the id.
 *
 * The alternative — a first-class `org` column on every tuple — is a schema
 * decision that is painful to retrofit and that hardcodes one tenancy model into
 * the kernel. The layout below keeps the same guarantees while leaving that
 * choice reversible.
 */

const model = defineModel({
  types: {
    // A user *within* a tenant. Ids are scoped, not global.
    user: defineType({}),
    team: defineType({ relations: { member: relation(['user']) } }),
    project: defineType({
      relations: {
        owner: relation(['user']),
        member: relation('user').or(relation('team', { through: 'member' })),
        banned: relation(['user']),
      },
      permissions: {
        read: permission.or('owner', 'member'),
        // Writing needs ownership and is not revocable by leaving the team.
        write: permission.allOf('owner').except('banned'),
        admin: permission.or('owner'),
      },
    }),
  },
});

/** Tenant-aware id helpers. This is your code, not the library's. */
const ns = (org: string) => ({
  user: (id: string) => `user:${org}:${id}`,
  team: (id: string) => `team:${org}:${id}`,
  project: (id: string) => `project:${org}:${id}`,
});

const acme = ns('acme');
const globex = ns('globex');

const authz = createAuthz({ model, store: memoryStore() });

// Identically shaped ids in two tenants. Nothing in the engine keeps them apart
// except the id itself.
await authz.write([
  { subject: acme.user('ada'), relation: 'owner', resource: acme.project('api') },
  { subject: globex.user('ada'), relation: 'owner', resource: globex.project('api') },
  { subject: acme.user('bob'), relation: 'member', resource: acme.project('api') },
  { subject: globex.user('bob'), relation: 'member', resource: globex.project('api') },
]);

const cases: [string, string, string, boolean][] = [
  ['acme ada owns acme/api', acme.user('ada'), acme.project('api'), true],
  ['globex ada owns globex/api', globex.user('ada'), globex.project('api'), true],
  ['acme bob reads acme/api', acme.user('bob'), acme.project('api'), true],
  ['globex bob reads globex/api', globex.user('bob'), globex.project('api'), true],
  ['acme ada does not own globex/api', acme.user('ada'), globex.project('api'), false],
  ['globex ada does not own acme/api', globex.user('ada'), acme.project('api'), false],
  ['bare id matches nothing', 'user:ada', acme.project('api'), false],
];

let failures = 0;
for (const [label, subject, resource, expected] of cases) {
  const allowed = await authz.can(subject, 'project.read', resource);
  if (allowed !== expected) failures += 1;
  console.log(
    `${allowed === expected ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} ${allowed ? 'allowed' : 'denied'}`,
  );
}

// Because ids are opaque, one filtered read is enough to list a tenant's
// projects — which is what a real app does on its way to tenant scoping.
const acmeOnly = await authz.store.read({ resource: acme.project('api') });
const globexOnly = await authz.store.read({ resource: globex.project('api') });
console.log(
  `\nok    tenants are distinguishable   acme=${acmeOnly.items.length} globex=${globexOnly.items.length}`,
);

// Ownership is per tenant, so a ban in one cannot leak into the other.
await authz.grant({
  subject: acme.user('bob'),
  relation: 'banned',
  resource: acme.project('api'),
});
const bannedHere = await authz.can(
  acme.user('bob'),
  'project.write',
  acme.project('api'),
);
const bannedThere = await authz.can(
  globex.user('bob'),
  'project.write',
  globex.project('api'),
);
if (bannedHere || bannedThere) failures += 1;
console.log(
  `${!bannedHere ? 'ok  ' : 'FAIL'}  acme ban holds                  denied=${!bannedHere}`,
);
console.log(
  `${!bannedThere ? 'ok  ' : 'FAIL'}  globex is unaffected            denied=${!bannedThere}`,
);

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
