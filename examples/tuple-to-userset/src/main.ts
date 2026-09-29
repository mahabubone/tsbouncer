import {
  createAuthz,
  defineModel,
  defineType,
  formatExplain,
  memoryStore,
  permission,
  relation,
  ttu,
} from 'tsbouncer';

/**
 * Inheritance down a tree: `read` flows from an ancestor to its descendants.
 *
 * `ttu('parent', 'read')` means "follow `parent`, then take `read` over there".
 * It is the one shape that reads like a graph walk, and the one most easily
 * implemented backwards.
 */

const model = defineModel({
  types: {
    user: defineType({}),
    org: defineType({
      relations: { admin: relation(['user']) },
      permissions: { manage: permission.or('admin') },
    }),
    folder: defineType({
      relations: {
        viewer: relation(['user']),
        parent: relation('folder'),
        org: relation('org'),
      },
      permissions: {
        // A viewer of any ancestor can read this folder, and so can anyone who
        // manages the org that owns it...
        read: permission.or('viewer', ttu('parent', 'read'), ttu('org', 'manage')),
        // ...and whoever manages the owning org manages and reads it. A document
        // inherits *this* permission through its own parent chain, so an org
        // admin reaches a document four edges down.
        manage: permission.or(ttu('org', 'manage')),
      },
    }),
    document: defineType({
      relations: {
        viewer: relation(['user']),
        parent: relation('folder'),
        org: relation('org'),
      },
      permissions: {
        read: permission.or('viewer', ttu('parent', 'read')),
        manage: permission.or(ttu('org', 'manage')),
      },
    }),
  },
});

// Note that `document` has no `org` edge at all: a document reaches its org by
// walking up to a folder that has one, through `ttu('parent', 'read')`. One
// traversal is enough because permissions compose.

const authz = createAuthz({ model, store: memoryStore() });

// A folder tree rooted at folder/root, with every folder pointing at one org.
//
// The tree is uniform on purpose: `parent` only accepts `folder`, so an org
// cannot appear in a parent chain. Ownership is a separate edge (`org`), reached
// by its own tuple-to-userset. Mixing a new type into a traversal the model
// does not allow is rejected at write time, not discovered at check time.
//
// folder/root
//   ├─ folder/engineering
//   │    └─ folder/backend
//   │         ├─ document/api
//   │         └─ document/infra
//   └─ folder/design
// Note the direction of every tuple: a relation is a property *of* the resource,
// so the parent is the subject. `{ subject: 'folder:backend', relation: 'parent',
// resource: 'document:api' }` reads "document:api's parent is folder:backend".
// Getting this backwards is the most common mistake with this model, and
// write-time validation rejects it rather than letting it deny silently later.
await authz.write([
  { subject: 'user:ada', relation: 'admin', resource: 'org:1' },
  { subject: 'org:1', relation: 'org', resource: 'folder:root' },
  { subject: 'folder:root', relation: 'parent', resource: 'folder:engineering' },
  { subject: 'folder:engineering', relation: 'parent', resource: 'folder:backend' },
  { subject: 'folder:backend', relation: 'parent', resource: 'document:api' },
  { subject: 'folder:backend', relation: 'parent', resource: 'document:infra' },
  { subject: 'folder:root', relation: 'parent', resource: 'folder:design' },
]);

// The permission has to match the resource's type, so folders and documents are
// checked separately. Asking for `document.read` on a folder is a type error,
// not a denial.
const cases: [string, string, string, string, boolean][] = [
  ['org admin reads a document', 'user:ada', 'document.read', 'document:api', true],
  ['org admin reads a sibling', 'user:ada', 'document.read', 'document:infra', true],
  ['org admin reads a folder', 'user:ada', 'folder.read', 'folder:design', true],
  ['org admin reads deep', 'user:ada', 'document.read', 'document:infra', true],
  [
    'org admin manages the folder it owns',
    'user:ada',
    'folder.manage',
    'folder:root',
    true,
  ],
  ['stranger reads nothing', 'user:bob', 'document.read', 'document:api', false],
  ['stranger manages nothing', 'user:bob', 'folder.manage', 'folder:root', false],
];
let failures = 0;
for (const [label, subject, permissionName, resource, expected] of cases) {
  const allowed = await authz.can(subject, permissionName, resource);
  if (allowed !== expected) failures += 1;
  console.log(
    `${allowed === expected ? 'ok  ' : 'FAIL'}  ${label.padEnd(40)} ${allowed ? 'allowed' : 'denied'}`,
  );
}

// A three-level inheritance walk, cited step by step.
const inherited = await authz.explain({
  subject: 'user:ada',
  permission: 'document.read',
  resource: 'document:api',
});
console.log('\nhow ada reaches document:api:');
console.log(formatExplain(inherited));

// And what a denial looks like: the query that came back empty, not a guess.
const denied = await authz.explain({
  subject: 'user:bob',
  permission: 'document.read',
  resource: 'document:api',
});
console.log(`\nwhy bob is denied (${denied.reads} reads):`);
console.log(formatExplain(denied));

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
