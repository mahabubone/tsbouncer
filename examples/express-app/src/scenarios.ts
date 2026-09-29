/**
 * The scenarios.
 *
 * One table, consumed twice: `main.ts` walks it and prints a tour, and
 * `test/api.test.ts` asserts it. They cannot drift, because there is only one
 * list, and the demo you read is the thing the test checks.
 *
 * Every entry is a real HTTP request against a real listening socket. Each is
 * labelled with the authorization style it exercises, because the point of the
 * API is that those styles compose rather than sit in separate products.
 */
/**
 * A minimal assertion, deliberately not vitest's `expect`.
 *
 * This module is imported by both the runnable demo and the test suite, so it
 * must not depend on a test runner — a shared table that can only be executed
 * under vitest is a table the README cannot promise. It implements only the two
 * matchers these scenarios use.
 */
function check(value: unknown) {
  const show = (v: unknown) => JSON.stringify(v);
  return {
    toBe(expected: unknown): void {
      if (value !== expected) {
        throw new Error(`expected ${show(expected)}, got ${show(value)}`);
      }
    },
    toEqual(expected: unknown): void {
      if (show(value) !== show(expected)) {
        throw new Error(`expected ${show(expected)}, got ${show(value)}`);
      }
    },
    toBeGreaterThan(minimum: number): void {
      if (typeof value !== 'number' || value <= minimum) {
        throw new Error(`expected a number greater than ${minimum}, got ${show(value)}`);
      }
    },
  };
}

export type Style = 'RBAC' | 'ReBAC' | 'ABAC' | 'app';

export interface Scenario {
  readonly label: string;
  readonly style: Style;
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
  /** Request headers. `x-user-id` is identity; the rest is request state. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly expectStatus: number;
  /** Extra assertions against the parsed response body. */
  readonly expect?: (body: Record<string, unknown>) => void;
}

const alice = { 'x-user-id': 'alice', 'x-region': 'eu' };
const bob = { 'x-user-id': 'bob', 'x-region': 'eu' };
const carol = { 'x-user-id': 'carol', 'x-region': 'us' };
const dave = { 'x-user-id': 'dave', 'x-region': 'eu' };
const erin = { 'x-user-id': 'erin', 'x-region': 'eu' };
const mallory = { 'x-user-id': 'mallory', 'x-region': 'eu' };
const frank = { 'x-user-id': 'frank', 'x-region': 'eu' };
const root = { 'x-user-id': 'root', 'x-region': 'us' };

const ids = (body: Record<string, unknown>): string[] =>
  (body.documents as ReadonlyArray<{ id: string }>).map((d) => d.id).sort();

export const scenarios: readonly Scenario[] = [
  /* ---- identity and request lifecycle (the app's job) ------------------ */
  {
    label: 'no identity header is 401',
    style: 'app',
    method: 'GET',
    path: '/api/v1/me',
    expectStatus: 401,
    expect: (b) => check(b.error).toBe('unauthenticated'),
  },
  {
    label: 'a bad region is 400, not 403',
    style: 'app',
    method: 'GET',
    path: '/api/v1/me',
    headers: { 'x-user-id': 'alice', 'x-region': 'apac' },
    expectStatus: 400,
  },
  {
    label: 'identity resolves to a subject and a readable set',
    style: 'app',
    method: 'GET',
    path: '/api/v1/me',
    headers: alice,
    expectStatus: 200,
    expect: (b) => {
      check(b.userId).toBe('alice');
      check(Array.isArray(b.readableDocumentIds)).toBe(true);
    },
  },

  /* ---- ReBAC: direct, teams, sharing, inheritance, wildcard ------------- */
  {
    label: 'owner reads her document',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: alice,
    expectStatus: 200,
    expect: (b) => check(b.title).toBe('Roadmap'),
  },
  {
    label: 'a stranger is refused',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: mallory,
    expectStatus: 403,
  },
  {
    label: 'team membership grants edit through a userset',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents/2',
    headers: bob,
    expectStatus: 200,
  },
  {
    label: 'a non-member is refused the same document',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents/2',
    headers: dave,
    expectStatus: 403,
  },
  {
    label: 'a public document is readable by anyone',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents/3',
    headers: mallory,
    expectStatus: 200,
  },
  {
    label: 'read inherits down the folder tree',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents/4',
    headers: bob,
    expectStatus: 200,
  },
  {
    label: 'a sibling folder does not leak its grants',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents/4',
    headers: dave,
    expectStatus: 403,
  },
  {
    label: 'listing inherits, and reports truncation',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents',
    headers: bob,
    expectStatus: 200,
    expect: (b) => {
      check(b.truncated).toBe(false);
      // doc 1 via the role he holds, 2 via his team, 3 public, 4 via the folder.
      check(ids(b)).toEqual(['1', '2', '3', '4']);
    },
  },

  /* ---- RBAC: roles attached to resources, never to users --------------- */
  {
    label: 'a role holder edits without the document naming them',
    style: 'RBAC',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: bob,
    expectStatus: 200,
  },
  {
    label: 'a user with no grant is refused the same document',
    style: 'RBAC',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: frank,
    expectStatus: 403,
  },
  {
    label: 'write needs owner and editor, so a role alone is not enough',
    style: 'RBAC',
    method: 'PATCH',
    path: '/api/v1/documents/1',
    headers: bob,
    body: { title: 'renamed' },
    expectStatus: 403,
  },
  {
    label: 'the owner with the role can write',
    style: 'RBAC',
    method: 'PATCH',
    path: '/api/v1/documents/1',
    headers: alice,
    body: { title: 'Roadmap Q3' },
    expectStatus: 200,
    expect: (b) => check(b.title).toBe('Roadmap Q3'),
  },
  {
    label: 'a malformed patch is 400',
    style: 'app',
    method: 'PATCH',
    path: '/api/v1/documents/1',
    headers: alice,
    body: { nope: true },
    expectStatus: 400,
  },
  {
    label: 'a workspace member is not necessarily an admin',
    style: 'RBAC',
    method: 'GET',
    path: '/api/v1/workspaces/acme',
    headers: bob,
    expectStatus: 200,
    expect: (b) => check(b.id).toBe('acme'),
  },
  {
    label: 'an outsider cannot administer it at all',
    style: 'RBAC',
    method: 'GET',
    path: '/api/v1/workspaces/acme',
    headers: frank,
    expectStatus: 403,
  },
  {
    label: 'a workspace admin can',
    style: 'RBAC',
    method: 'GET',
    path: '/api/v1/workspaces/acme',
    headers: alice,
    expectStatus: 200,
    expect: (b) => check(b.plan).toBe('enterprise'),
  },
  {
    label: 'instance admin reaches a tenant it is not a member of',
    style: 'RBAC',
    method: 'GET',
    path: '/api/v1/workspaces/globex',
    headers: root,
    expectStatus: 200,
  },

  /* ---- ABAC: a constraint the writer bound ------------------------------ */
  {
    label: 'region-bound grant holds for a matching caller',
    style: 'ABAC',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: dave,
    expectStatus: 200,
  },
  {
    label: 'the same grant fails for the wrong region',
    style: 'ABAC',
    method: 'GET',
    path: '/api/v1/documents/2',
    headers: dave,
    expectStatus: 403,
  },
  {
    label: 'the same grant holds once the caller is in that region',
    style: 'ABAC',
    method: 'GET',
    path: '/api/v1/documents/2',
    headers: { 'x-user-id': 'dave', 'x-region': 'us' },
    expectStatus: 200,
    expect: (b) => check(b.title).toBe('Hiring plan'),
  },
  {
    label: 'a query parameter cannot forge the caller region',
    style: 'ABAC',
    method: 'GET',
    path: '/api/v1/documents/2?callerRegion=us&context=%7B%7D',
    headers: dave,
    expectStatus: 403,
  },
  {
    label: 'listing applies the same conditions',
    style: 'ABAC',
    method: 'GET',
    path: '/api/v1/documents',
    headers: dave,
    expectStatus: 200,
    expect: (b) => check(ids(b)).toEqual(['1', '3']),
  },

  /* ---- ABAC: decided entirely by request state -------------------------- */
  {
    label: 'a suspended account loses an otherwise valid grant',
    style: 'ABAC',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: { ...erin, 'x-suspended': 'true' },
    expectStatus: 403,
  },
  {
    label: 'the same account is fine when not suspended',
    style: 'ABAC',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: erin,
    expectStatus: 200,
  },

  {
    label: 'an owner who is not an editor reads her document',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents/5',
    headers: carol,
    expectStatus: 200,
  },
  {
    label: 'but ownership alone does not carry write',
    style: 'ReBAC',
    method: 'PATCH',
    path: '/api/v1/documents/5',
    headers: carol,
    body: { title: 'renamed' },
    expectStatus: 403,
  },

  /* ---- exclusion, and the pair that proves it --------------------------- */
  {
    label: 'a banned owner still reads',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents/2',
    headers: mallory,
    expectStatus: 200,
  },
  {
    label: 'a banned owner does not write',
    style: 'ReBAC',
    method: 'PATCH',
    path: '/api/v1/documents/2',
    headers: mallory,
    body: { title: 'hijacked' },
    expectStatus: 403,
  },
  {
    label: 'a legal hold is 409, not 403 — the graph allowed it',
    style: 'app',
    method: 'PATCH',
    path: '/api/v1/documents/5',
    // alice reaches `write` on this document through the folder it lives in, so
    // the graph says yes. The hold is the application's own state, refused
    // separately, which is why it is 409 and not 403.
    headers: alice,
    body: { title: 'changed' },
    expectStatus: 409,
    expect: (b) => check(b.error).toBe('on_hold'),
  },

  /* ---- cross-tenant isolation ------------------------------------------- */
  {
    label: 'an acme user cannot reach a globex document',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents/6',
    headers: alice,
    expectStatus: 403,
  },
  {
    label: 'a globex owner can',
    style: 'ReBAC',
    method: 'GET',
    path: '/api/v1/documents/6',
    headers: root,
    expectStatus: 200,
  },

  /* ---- writes, and the direction that makes roles worth having --------- */
  {
    label: 'a writer attaches a role to a document',
    style: 'RBAC',
    method: 'POST',
    path: '/api/v1/documents/3/roles',
    headers: alice,
    body: { role: 'acme:editor' },
    expectStatus: 403,
  },
  {
    label: 'an admin grants a role to a user',
    style: 'RBAC',
    method: 'POST',
    path: '/api/v1/roles/acme:viewer/holders',
    headers: alice,
    body: { userId: 'mallory' },
    expectStatus: 201,
  },
  {
    label: 'a non-admin cannot grant roles',
    style: 'RBAC',
    method: 'POST',
    path: '/api/v1/roles/acme:viewer/holders',
    headers: dave,
    body: { userId: 'mallory' },
    expectStatus: 403,
  },
  {
    label: 'an unknown relation is 400, not 403',
    style: 'app',
    method: 'POST',
    path: '/api/v1/documents/1/roles',
    headers: alice,
    body: { role: 'acme:viewer', relation: 'superuser' },
    expectStatus: 400,
    expect: (b) => check(b.error).toBe('invalid_tuple'),
  },

  /* ---- explain ----------------------------------------------------------- */
  {
    label: 'why returns a trace, not a guess',
    style: 'app',
    method: 'GET',
    path: '/api/v1/documents/1/why?subject=user:dave&permission=document.read',
    headers: alice,
    expectStatus: 200,
    expect: (b) => {
      check(b.allowed).toBe(true);
      check(typeof b.trace).toBe('object');
      check(b.trace === null).toBe(false);
    },
  },
  {
    label: 'why reports a denial with the reason',
    style: 'app',
    method: 'GET',
    path: '/api/v1/documents/1/why?subject=user:dave&permission=document.write',
    headers: alice,
    expectStatus: 200,
    expect: (b) => {
      check(b.allowed).toBe(false);
      check(b.reads).toBeGreaterThan(0);
    },
  },
  {
    label: 'why requires a subject',
    style: 'app',
    method: 'GET',
    path: '/api/v1/documents/1/why',
    headers: alice,
    expectStatus: 400,
  },

  /* ---- 404s -------------------------------------------------------------- */
  {
    label: 'a missing document is 404, before any permission question',
    style: 'app',
    method: 'GET',
    path: '/api/v1/documents/999',
    headers: alice,
    expectStatus: 404,
  },
  {
    label: 'the folder tree is browsable',
    style: 'app',
    method: 'GET',
    path: '/api/v1/folders/root/children',
    headers: alice,
    expectStatus: 200,
    expect: (b) => {
      const children = b.children as ReadonlyArray<{ id: string }>;
      check(children.map((c) => c.id).sort()).toEqual(['design', 'eng']);
    },
  },
];

/** Scenarios that mutate state, so a suite can order or isolate them. */
export const mutating = (s: Scenario): boolean => s.method !== 'GET';

export interface Result {
  readonly scenario: Scenario;
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly ok: boolean;
  readonly error: string | undefined;
}
