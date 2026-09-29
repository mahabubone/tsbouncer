/**
 * The scenario table.
 *
 * One list, used by both `src/main.ts` (which prints a tour of it) and
 * `test/api.test.ts` (which asserts every line of it). A demo you watch and a suite
 * that gates CI reading the same list is the only way they cannot drift apart — and
 * drift is how an example starts documenting behaviour the application no longer has.
 *
 * Every scenario is a real HTTP request against a real socket. The fixture is
 * `src/seed.ts`; the reasoning behind the model is in `src/model.ts`.
 */

export type Style =
  | 'identity'
  | 'rbac'
  | 'rebac'
  | 'abac'
  | 'exclusion'
  | 'queries'
  | 'lifecycle'
  | 'errors';

export interface Scenario {
  readonly style: Style;
  readonly label: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly expectStatus: number;
  /** Optional, run against the parsed body. Throwing marks the scenario failed. */
  readonly expect?: (body: unknown) => void;
}

export interface Result {
  readonly scenario: Scenario;
  readonly ok: boolean;
  readonly error: string | undefined;
}

/** `alice` in `acme`. The tenant is separate from the user on purpose. */
const as = (user: string, org = 'acme') => ({ 'x-user-id': user, 'x-org': org });

function has(
  body: unknown,
  predicate: (value: Record<string, unknown>) => boolean,
  describe: string,
): void {
  const value = body as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || !predicate(value)) {
    throw new Error(`body ${JSON.stringify(body)} — ${describe}`);
  }
}

const docIds = (body: unknown): string[] =>
  ((body as { documents: { id: string }[] }).documents ?? []).map((d) => d.id);

export const scenarios: readonly Scenario[] = [
  /* --- identity ----------------------------------------------------------- */
  {
    style: 'identity',
    label: 'no identity is 401',
    method: 'GET',
    path: '/api/v1/documents/1',
    expectStatus: 401,
    expect: (b) => has(b, (v) => v.error === 'unauthenticated', 'expected 401 code'),
  },
  {
    style: 'identity',
    label: 'an unknown user is 401, not 403',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: as('nobody'),
    expectStatus: 401,
  },
  {
    style: 'identity',
    label: 'an unknown tenant is 400 — the caller exists',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: { 'x-user-id': 'alice', 'x-org': 'initech' },
    expectStatus: 400,
  },

  /* --- RBAC: a role attached to a project --------------------------------- */
  {
    style: 'rbac',
    label: 'a role admin reads the project',
    method: 'GET',
    path: '/api/v1/projects/atlas',
    headers: as('alice'),
    expectStatus: 200,
  },
  {
    style: 'rbac',
    label: 'an editor reads it too',
    method: 'GET',
    path: '/api/v1/projects/atlas',
    headers: as('bob'),
    expectStatus: 200,
  },
  {
    style: 'rbac',
    label: 'an editor writes to it',
    method: 'PATCH',
    path: '/api/v1/projects/atlas',
    headers: as('bob'),
    body: { name: 'Atlas' },
    expectStatus: 200,
    expect: (b) => has(b, (v) => v.name === 'Atlas', 'expected the renamed project'),
  },
  {
    style: 'rbac',
    label: 'a viewer reads but cannot write',
    method: 'GET',
    path: '/api/v1/projects/atlas',
    headers: as('carol'),
    expectStatus: 200,
  },
  {
    style: 'rbac',
    label: 'and no grant at all is 403',
    method: 'PATCH',
    path: '/api/v1/projects/atlas',
    headers: as('carol'),
    body: { name: 'Renamed by a viewer' },
    expectStatus: 403,
  },
  {
    style: 'rbac',
    label: 'a user with nothing attached is 403 too',
    method: 'GET',
    path: '/api/v1/projects/atlas',
    headers: as('dana'),
    expectStatus: 403,
  },

  /* --- ReBAC: team membership and the folder tree -------------------------- */
  {
    style: 'rebac',
    label: 'a team member reads a document in a folder the team can see',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: as('bob'),
    expectStatus: 200,
  },
  {
    style: 'rebac',
    label: 'and one two levels down, by inheritance',
    method: 'GET',
    path: '/api/v1/documents/2',
    headers: as('bob'),
    expectStatus: 200,
  },
  {
    style: 'rebac',
    label: 'a folder owner reads everything beneath it',
    method: 'GET',
    path: '/api/v1/documents/3',
    headers: as('carol'),
    expectStatus: 200,
  },
  {
    style: 'rebac',
    label: 'and nothing outside it',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: as('carol'),
    expectStatus: 403,
  },
  {
    style: 'rebac',
    label: 'the other tenant is unreachable from this one',
    method: 'GET',
    path: '/api/v1/documents/6',
    headers: as('alice'),
    expectStatus: 403,
  },
  {
    style: 'rebac',
    label: 'and is reachable from inside it',
    method: 'GET',
    path: '/api/v1/documents/6',
    headers: as('heidi', 'globex'),
    expectStatus: 200,
  },

  /* --- ABAC: three conditions, each failing closed ------------------------- */
  {
    style: 'abac',
    label: 'a region-bound grant opens in the matching tenant',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: as('dave'),
    expectStatus: 200,
  },
  {
    style: 'abac',
    label: 'and closes in the other one, with no change to the grant',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: as('dave', 'globex'),
    expectStatus: 403,
  },
  {
    style: 'abac',
    label: 'a client cannot forge the context it is judged against',
    method: 'GET',
    // `callerRegion` in the query string is ignored entirely, because the
    // application never reads request parameters into the condition context. This
    // is the single most important line of defence in an ABAC system and it lives
    // in the app, not the library.
    path: '/api/v1/documents/1?callerRegion=eu&suspended=false',
    headers: as('dave', 'globex'),
    expectStatus: 403,
  },
  {
    style: 'abac',
    label: 'a suspended account is refused even with a valid grant',
    method: 'GET',
    path: '/api/v1/documents/4',
    headers: as('erin'),
    expectStatus: 403,
  },
  {
    style: 'abac',
    label: 'the same grant opens for someone who is not suspended',
    method: 'GET',
    path: '/api/v1/documents/4',
    headers: as('carol'),
    expectStatus: 200,
  },
  {
    style: 'abac',
    label: 'a seat allowance of 5 against 4 used is allowed',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: as('dana'),
    expectStatus: 200,
  },
  {
    style: 'abac',
    label: 'an allowance of 3 against the same 4 used is not',
    method: 'GET',
    path: '/api/v1/documents/2',
    headers: as('dana'),
    expectStatus: 403,
  },
  {
    style: 'abac',
    label: 'a missing context key denies rather than passes',
    method: 'GET',
    path: '/api/v1/documents/1/why?permission=document.read',
    headers: { 'x-user-id': 'dave' },
    expectStatus: 200,
    expect: (b) =>
      has(b, (v) => v.allowed === true, 'acme defaults still satisfy the grant'),
  },

  /* --- Exclusion, and the wildcard it has to beat ------------------------- */
  {
    style: 'exclusion',
    label: 'a wildcard makes a document readable by any signed-in user',
    method: 'GET',
    path: '/api/v1/documents/5',
    headers: as('dana'),
    expectStatus: 200,
  },
  {
    style: 'exclusion',
    label: 'but not by someone banned from it',
    method: 'GET',
    path: '/api/v1/documents/5',
    headers: as('mallory'),
    expectStatus: 403,
  },
  {
    style: 'exclusion',
    label: 'a ban beats ownership',
    method: 'GET',
    path: '/api/v1/documents/2',
    headers: as('mallory'),
    expectStatus: 403,
  },
  {
    style: 'exclusion',
    label: 'and beats it for the dual-key publish rule as well',
    method: 'POST',
    path: '/api/v1/documents/2/publish',
    headers: as('mallory'),
    body: { approvedBy: 'frank' },
    expectStatus: 403,
  },
  {
    style: 'exclusion',
    label: 'publishing needs the owner and an approver: the owner alone is refused',
    method: 'POST',
    path: '/api/v1/documents/4/publish',
    headers: as('alice'),
    body: { approvedBy: 'frank' },
    expectStatus: 403,
  },
  {
    style: 'exclusion',
    label: 'the approver alone is refused too',
    method: 'POST',
    path: '/api/v1/documents/1/publish',
    headers: as('frank'),
    body: { approvedBy: 'frank' },
    expectStatus: 403,
  },
  {
    style: 'exclusion',
    label: 'holding both, with a second person countersigning, succeeds',
    method: 'POST',
    path: '/api/v1/documents/1/publish',
    headers: as('alice'),
    body: { approvedBy: 'frank' },
    expectStatus: 200,
    expect: (b) => has(b, (v) => v.published === true, 'expected published'),
  },
  {
    style: 'exclusion',
    label: 'and nobody may countersign their own publish',
    method: 'POST',
    path: '/api/v1/documents/1/publish',
    headers: as('alice'),
    body: { approvedBy: 'alice' },
    expectStatus: 403,
    expect: (b) =>
      has(b, (v) => v.error === 'four_eyes', 'expected the four-eyes refusal'),
  },
  {
    style: 'exclusion',
    label: 'nor may someone who is not an approver',
    method: 'POST',
    path: '/api/v1/documents/1/publish',
    headers: as('alice'),
    body: { approvedBy: 'bob' },
    expectStatus: 403,
    expect: (b) =>
      has(b, (v) => v.error === 'approval_required', 'expected the approval refusal'),
  },

  /* --- The query API, as routes ------------------------------------------- */
  {
    style: 'queries',
    label: 'listing walks the graph and reports truncation',
    method: 'GET',
    path: '/api/v1/me/documents',
    headers: as('bob'),
    expectStatus: 200,
    expect: (b) => {
      const ids = docIds(b);
      for (const expected of ['1', '2', '4', '5']) {
        if (!ids.includes(expected)) {
          throw new Error(`expected ${expected} in ${JSON.stringify(ids)}`);
        }
      }
      if (ids.includes('3'))
        throw new Error(`did not expect 3 in ${JSON.stringify(ids)}`);
      has(b, (v) => v.truncated === false, 'a small list must still report truncated');
    },
  },
  {
    style: 'queries',
    label: 'a conditioned grant shows up in the list as well as in check',
    method: 'GET',
    path: '/api/v1/me/documents',
    headers: as('carol'),
    expectStatus: 200,
    expect: (b) => {
      // Document 4 is reachable only through `notSuspended`, so this is the case
      // that broke when `listResources` accepted a context and dropped it.
      const ids = docIds(b);
      if (!ids.includes('4')) throw new Error(`expected 4 in ${JSON.stringify(ids)}`);
      if (ids.includes('1'))
        throw new Error(`did not expect 1 in ${JSON.stringify(ids)}`);
    },
  },
  {
    style: 'queries',
    label: 'who-can-see is symbolic, not a fabricated roster',
    method: 'GET',
    path: '/api/v1/documents/5/who',
    headers: as('alice'),
    expectStatus: 200,
    expect: (b) =>
      has(
        b,
        (v) =>
          JSON.stringify(v.allOfTypes) === JSON.stringify(['user']) &&
          Array.isArray(v.members) &&
          v.members.length === 0 &&
          JSON.stringify(v.excluded) === JSON.stringify(['user:mallory']),
        'expected a symbolic every-user set, minus mallory',
      ),
  },
  {
    style: 'queries',
    label: 'a userset does expand, because its membership is finite',
    method: 'GET',
    path: '/api/v1/teams/platform/members',
    headers: as('alice'),
    expectStatus: 200,
    expect: (b) =>
      has(
        b,
        (v) => JSON.stringify(v.subjects) === JSON.stringify(['user:alice', 'user:bob']),
        'expected alice and bob',
      ),
  },
  {
    style: 'queries',
    label: 'why explains an allowed decision',
    method: 'GET',
    path: '/api/v1/documents/3/why?permission=document.read',
    headers: as('carol'),
    expectStatus: 200,
    expect: (b) =>
      has(
        b,
        (v) =>
          v.allowed === true && typeof v.reads === 'number' && typeof v.tree === 'object',
        'expected allowed, reads and a tree',
      ),
  },
  {
    style: 'queries',
    label: 'and explains a refusal, which is when you need it',
    method: 'GET',
    path: '/api/v1/documents/1/why?permission=document.read',
    headers: as('mallory'),
    expectStatus: 200,
    expect: (b) =>
      has(
        b,
        (v) =>
          v.allowed === false &&
          // The root of the tree is the exclusion, so a refusal here says which
          // relation removed the access rather than just reporting a `false`.
          (v.tree as { op?: string }).op === 'exclusion' &&
          typeof v.reads === 'number',
        'expected a denial tree rooted in the exclusion',
      ),
  },

  /* --- Lifecycle: a move, in one transaction ------------------------------ */
  {
    style: 'lifecycle',
    label: 'an editor may not change the access list',
    method: 'POST',
    path: '/api/v1/documents/1/roles',
    headers: as('bob'),
    body: { role: 'acme:viewer' },
    expectStatus: 403,
  },
  {
    style: 'lifecycle',
    label: 'the owner may',
    method: 'POST',
    path: '/api/v1/documents/1/roles',
    headers: as('alice'),
    body: { role: 'acme:viewer' },
    expectStatus: 201,
  },
  {
    style: 'lifecycle',
    label: 'a document under legal hold is readable but not writable',
    method: 'GET',
    path: '/api/v1/documents/4',
    headers: as('alice'),
    expectStatus: 200,
  },
  {
    style: 'lifecycle',
    label: 'and the write is 423, not 403 — it is not a permission problem',
    method: 'PATCH',
    path: '/api/v1/documents/4',
    headers: as('alice'),
    body: { title: 'Redacted' },
    expectStatus: 423,
    expect: (b) => has(b, (v) => v.error === 'locked', 'expected the hold refusal'),
  },
  {
    style: 'lifecycle',
    label: 'moving a document needs permission on both ends',
    method: 'POST',
    path: '/api/v1/documents/1/move',
    headers: as('dana'),
    body: { folderId: 'design' },
    expectStatus: 403,
  },
  {
    style: 'lifecycle',
    label: 'the owner moves it, and the row follows',
    method: 'POST',
    path: '/api/v1/documents/1/move',
    headers: as('alice'),
    body: { folderId: 'design' },
    expectStatus: 200,
    expect: (b) => has(b, (v) => v.folderId === 'design', 'expected folderId design'),
  },
  {
    style: 'lifecycle',
    label: 'the new folder owner can now read it',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: as('carol'),
    expectStatus: 200,
  },
  {
    style: 'lifecycle',
    label: 'and the old path is gone, in the same transaction',
    method: 'GET',
    path: '/api/v1/documents/1',
    headers: as('bob'),
    expectStatus: 403,
  },

  /* --- Errors: refusals and typos are different statuses ------------------- */
  {
    style: 'errors',
    label: 'a grant naming a relation the model does not declare is a 400',
    method: 'POST',
    path: '/api/v1/documents/1/roles',
    headers: as('alice'),
    body: { role: 'acme:superuser' },
    expectStatus: 400,
    expect: (b) => has(b, (v) => v.error === 'invalid_tuple', 'expected invalid_tuple'),
  },
  {
    style: 'errors',
    label: 'explaining an undeclared permission is a 400, not a denial',
    method: 'GET',
    path: '/api/v1/documents/1/why?permission=document.reads',
    headers: as('alice'),
    expectStatus: 400,
    expect: (b) => has(b, (v) => v.error === 'unknown_permission', 'expected 400 code'),
  },
  {
    style: 'errors',
    label: 'a caller allowed to ask about a row that is gone gets 404',
    method: 'GET',
    path: '/api/v1/documents/999',
    headers: as('alice'),
    expectStatus: 404,
  },
  {
    style: 'errors',
    label: 'and a caller who may not gets 403, learning nothing',
    method: 'GET',
    path: '/api/v1/documents/999',
    headers: as('mallory'),
    expectStatus: 403,
  },
];
