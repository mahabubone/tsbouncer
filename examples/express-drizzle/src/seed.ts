import type { Tuple } from 'tsbouncer';

/**
 * The fixture: two tenants, one project tree, and a graph that exercises every
 * feature the model declares.
 *
 * Read the two halves separately. `organizations` through `documents` are ordinary
 * application rows — the kind of thing Drizzle queries and a migration owns.
 * `tuples` is the access graph: opaque strings, no foreign keys, no columns about
 * who may do what. An id in one half means nothing to the other except that the
 * string matches.
 */

export const organizations = [
  // seatsUsed is 4 against a grant that allowed 5, and 5 against one that allowed
  // 3. The same predicate, two answers, and the difference is entirely in the data.
  {
    id: 'acme',
    name: 'Acme Corp',
    plan: 'enterprise' as const,
    region: 'eu' as const,
    seatsUsed: 4,
  },
  {
    id: 'globex',
    name: 'Globex',
    plan: 'pro' as const,
    region: 'us' as const,
    seatsUsed: 5,
  },
];

export const users = [
  { id: 'alice', name: 'Alice', region: 'eu' as const, suspended: false },
  { id: 'bob', name: 'Bob', region: 'us' as const, suspended: false },
  { id: 'carol', name: 'Carol', region: 'eu' as const, suspended: false },
  { id: 'dave', name: 'Dave', region: 'us' as const, suspended: false },
  { id: 'erin', name: 'Erin', region: 'eu' as const, suspended: true },
  { id: 'frank', name: 'Frank', region: 'eu' as const, suspended: false },
  { id: 'mallory', name: 'Mallory', region: 'eu' as const, suspended: false },
  { id: 'dana', name: 'Dana', region: 'eu' as const, suspended: false },
  { id: 'heidi', name: 'Heidi', region: 'us' as const, suspended: false },
  { id: 'root', name: 'Instance Admin', region: 'us' as const, suspended: false },
];

export const projects = [
  { id: 'atlas', organizationId: 'acme', name: 'Atlas' },
  { id: 'beacon', organizationId: 'globex', name: 'Beacon' },
];

/**
 * The folder tree under `atlas`, plus a separate root for the other tenant.
 *
 * `parentId` here is the application's own column for rendering a tree in the UI.
 * It is *not* what authorization uses — that is the `parent` relation in the
 * tuples below. The two agree in this fixture and nothing keeps them agreeing, which
 * is worth noticing: the UI can be wrong about the tree while access stays correct,
 * and the tests below check the tuples, not the column.
 */
export const folders = [
  { id: 'root', projectId: 'atlas', parentId: null, name: 'Atlas' },
  { id: 'eng', projectId: 'atlas', parentId: 'root', name: 'Engineering' },
  { id: 'infra', projectId: 'atlas', parentId: 'eng', name: 'Infrastructure' },
  { id: 'design', projectId: 'atlas', parentId: 'root', name: 'Design' },
  { id: 'groot', projectId: 'beacon', parentId: null, name: 'Beacon' },
];

export const documents = [
  {
    id: '1',
    folderId: 'eng',
    title: 'Migration plan',
    region: 'eu' as const,
    onHold: false,
  },
  {
    id: '2',
    folderId: 'infra',
    title: 'Vendor contract',
    region: 'us' as const,
    onHold: false,
  },
  {
    id: '3',
    folderId: 'design',
    title: 'Brand refresh',
    region: 'eu' as const,
    onHold: false,
  },
  { id: '4', folderId: 'eng', title: 'Layoff memo', region: 'eu' as const, onHold: true },
  {
    id: '5',
    folderId: 'root',
    title: 'Public changelog',
    region: 'eu' as const,
    onHold: false,
  },
  { id: '6', folderId: 'groot', title: 'Pricing', region: 'us' as const, onHold: false },
];

const user = (id: string) => `user:${id}` as const;
const doc = (id: string) => `document:${id}` as const;
const folder = (id: string) => `folder:${id}` as const;
const team = (id: string) => `team:${id}` as const;
const project = (id: string) => `project:${id}` as const;
const role = (id: string) => `role:${id}` as const;
/** The holders of a role — the subject an RBAC grant has to name. */
const holders = (id: string) => `role:${id}#holder` as const;
const members = (id: string) => `team:${id}#member` as const;

/**
 * The access graph.
 *
 * Grouped by which style of authorization is doing the work, because that is the
 * only way to read it. Nothing here is validated against the fixture's rows on
 * purpose: `user:alice` and `document:1` are strings, and the engine never resolves
 * them. A typo in an id is a permission that resolves to nobody.
 */
export const tuples: readonly Tuple[] = [
  /* --- RBAC: who holds a role, and what the role is attached to ------------- */
  { subject: user('alice'), relation: 'holder', resource: role('acme:admin') },
  { subject: user('bob'), relation: 'holder', resource: role('acme:editor') },
  { subject: user('carol'), relation: 'holder', resource: role('acme:viewer') },
  { subject: user('frank'), relation: 'holder', resource: role('acme:compliance') },
  { subject: user('root'), relation: 'holder', resource: role('instance:admin') },
  { subject: holders('acme:admin'), relation: 'admin', resource: project('atlas') },
  { subject: holders('acme:editor'), relation: 'editor', resource: project('atlas') },
  { subject: holders('acme:viewer'), relation: 'viewer', resource: project('atlas') },
  { subject: holders('instance:admin'), relation: 'admin', resource: project('beacon') },

  /* --- ReBAC: teams ------------------------------------------------------- */
  { subject: user('alice'), relation: 'member', resource: team('platform') },
  { subject: user('bob'), relation: 'member', resource: team('platform') },
  { subject: user('carol'), relation: 'member', resource: team('design') },
  { subject: members('platform'), relation: 'viewer', resource: folder('eng') },
  { subject: members('design'), relation: 'owner', resource: folder('design') },
  /*
   * Alice owns the top of the tree, so she inherits write and manage down through
   * every folder beneath it — which is the only reason she can move a document into
   * one. Ownership at the root is how a workspace administrator works, and it is
   * one grant rather than one per folder.
   */
  { subject: user('alice'), relation: 'owner', resource: folder('root') },

  /*
   * The tree. **The parent is the subject**, so read every line below as
   * "this folder's parent is the one named on the left":
   *
   *   { subject: 'folder:root', relation: 'parent', resource: 'folder:eng' }
   *     → folder:eng's parent is folder:root
   *
   * A relation is a property of the thing it is read from, and the evaluator
   * resolves `ttu('parent', …)` by reading `{ relation: 'parent', resource: <this
   * object> }` and taking the *subject* of what it finds. Writing the pair the
   * other way round is the single most common first mistake with this model: it
   * validates cleanly, and then every inheritance rule in the system quietly
   * resolves to nothing. There is no error. That is what makes it worth writing
   * down twice.
   */
  { subject: folder('root'), relation: 'parent', resource: folder('eng') },
  { subject: folder('eng'), relation: 'parent', resource: folder('infra') },
  { subject: folder('root'), relation: 'parent', resource: folder('design') },

  /* And the same rule for leaves: a folder is the parent, a document the child. */
  { subject: folder('eng'), relation: 'parent', resource: doc('1') },
  { subject: folder('infra'), relation: 'parent', resource: doc('2') },
  { subject: folder('design'), relation: 'parent', resource: doc('3') },
  { subject: folder('eng'), relation: 'parent', resource: doc('4') },
  { subject: folder('root'), relation: 'parent', resource: doc('5') },
  { subject: folder('groot'), relation: 'parent', resource: doc('6') },

  /* --- ReBAC: direct ownership ------------------------------------------- */
  { subject: user('alice'), relation: 'owner', resource: doc('1') },
  { subject: user('alice'), relation: 'owner', resource: doc('4') },
  { subject: user('alice'), relation: 'owner', resource: doc('5') },
  { subject: user('carol'), relation: 'owner', resource: doc('3') },
  { subject: user('mallory'), relation: 'owner', resource: doc('2') },
  { subject: user('heidi'), relation: 'owner', resource: doc('6') },

  /* --- Exclusion, and the wildcard it has to beat ------------------------- */
  /*
   * Mallory owns document 2 and is banned from it. Ownership is a real grant, the
   * ban is a real grant, and the ban wins because `except` is evaluated on both
   * sides of the union — a check that returned early on the first satisfied branch
   * would hand this account the document.
   */
  { subject: user('mallory'), relation: 'banned', resource: doc('2') },

  /*
   * A grant whose document row was hard-deleted. Every system that deletes a row
   * without cleaning up its grants has these, and it is the only case that reaches
   * a 404 through a route that authorizes first: Mallory is refused before the
   * lookup, so she cannot tell this id apart from one that never existed.
   */
  { subject: user('alice'), relation: 'owner', resource: doc('999') },

  /*
   * A published document. `user:*` on `shared` opens it to every signed-in user,
   * and the banned edge below still applies to individuals: a wildcard makes a
   * resource public, it does not make an exclusion unreachable.
   */
  { subject: 'user:*', relation: 'shared', resource: doc('5') },
  { subject: user('mallory'), relation: 'banned', resource: doc('5') },

  /* --- Segregation of duties: `document.publish` needs both relations ------ */
  // Alice holds the compliance role as well as owning document 1, which is what
  // makes her able to satisfy the dual-key rule at all. Holding both roles is a
  // *dual-key* permission, not a two-person workflow — the route adds the second
  // requirement separately.
  { subject: user('alice'), relation: 'holder', resource: role('acme:compliance') },
  { subject: holders('acme:compliance'), relation: 'approver', resource: doc('1') },
  /*
   * Mallory gets the second key too, so that the ban is the *only* thing stopping
   * a publish on document 2. Without this tuple the scenario would pass for the
   * wrong reason, and a test that passes for the wrong reason is worse than no test.
   */
  { subject: user('mallory'), relation: 'approver', resource: doc('2') },

  /* --- ABAC: one condition per grant, each with a different story ---------- */

  /*
   * Data residency. `region: 'eu'` was bound when the document was shared, so it
   * is stored with the grant. The caller's region is the *tenant's* region, which
   * the application reads from the organizations table — so dave is allowed in one
   * tenant and refused in the other, with no change to any grant.
   */
  {
    subject: user('dave'),
    relation: 'viewer',
    resource: doc('1'),
    condition: 'sameRegion',
    context: { region: 'eu' },
  },

  /*
   * Suspension. No bound parameters: the whole decision is made of the caller's own
   * state. Erin is suspended in the `users` table, so no grant can open document 4
   * to her. Carol holds the same grant and is not suspended, which is what makes
   * the denial about suspension rather than about the grant.
   */
  {
    subject: user('erin'),
    relation: 'viewer',
    resource: doc('4'),
    condition: 'notSuspended',
  },
  {
    subject: user('carol'),
    relation: 'viewer',
    resource: doc('4'),
    condition: 'notSuspended',
  },

  /*
   * Seat budget, and the reason conditions are a list. Dana holds the same relation
   * on two documents with different allowances: 5 against a tenant using 4 is
   * allowed, 3 against a tenant using 4 is not. The allowance was decided when the
   * grant was written; the usage is read live from the organizations table.
   */
  {
    subject: user('dana'),
    relation: 'viewer',
    resource: doc('1'),
    condition: 'withinSeatBudget',
    context: { seats: 5 },
  },
  {
    subject: user('dana'),
    relation: 'viewer',
    resource: doc('2'),
    condition: 'withinSeatBudget',
    context: { seats: 3 },
  },
];
