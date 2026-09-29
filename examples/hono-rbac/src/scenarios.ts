/**
 * The scenario table.
 *
 * One list, used by both `src/main.ts` (which prints a tour of it) and
 * `test/api.test.ts` (which asserts every line of it). A demo you watch and a
 * suite that gates CI reading the same list is the only way they cannot drift
 * apart — and drift here is how an example starts documenting behaviour the
 * application no longer has.
 */

export interface Scenario {
  /** Grouped in the printed output. */
  readonly style: 'identity' | 'roles' | 'ownership' | 'diagnostics';
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

const as = (user: string) => ({ 'x-user-id': user });

/** Assert helpers, so each scenario reads as one sentence. */
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

function ids(body: unknown): string[] {
  return ((body as { documents: { id: string }[] }).documents ?? []).map((d) => d.id);
}

export const scenarios: readonly Scenario[] = [
  // --- identity ------------------------------------------------------------
  {
    style: 'identity',
    label: 'an anonymous request is 401, not 403',
    method: 'GET',
    path: '/api/documents/1',
    expectStatus: 401,
    expect: (body) =>
      has(body, (b) => b.error === 'unauthenticated', 'expected 401 code'),
  },
  {
    style: 'identity',
    label: 'a known user reads what they own',
    method: 'GET',
    path: '/api/documents/1',
    headers: as('alice'),
    expectStatus: 200,
    expect: (body) =>
      has(body, (b) => b.title === 'Onboarding', 'expected the seeded title'),
  },

  // --- roles ---------------------------------------------------------------
  {
    style: 'roles',
    label: 'a role grants access to every document it is attached to',
    method: 'GET',
    path: '/api/documents/2',
    headers: as('bob'),
    expectStatus: 200,
  },
  {
    style: 'roles',
    label: 'and to the ones it was never attached to, once it is',
    method: 'POST',
    path: '/api/documents/4/roles',
    headers: as('alice'),
    body: { role: 'acme:editor' },
    expectStatus: 201,
  },
  {
    style: 'roles',
    label: 'the new holder can now read it — with no change to the document',
    method: 'GET',
    path: '/api/documents/4',
    headers: as('bob'),
    expectStatus: 200,
  },
  {
    style: 'roles',
    label: 'a viewer may read but not write',
    method: 'PATCH',
    path: '/api/documents/3',
    headers: as('carol'),
    body: { title: 'hijacked' },
    expectStatus: 403,
  },
  {
    style: 'roles',
    label: 'an editor may write',
    method: 'PATCH',
    path: '/api/documents/1',
    headers: as('bob'),
    body: { title: 'Onboarding (rev 2)' },
    expectStatus: 200,
    expect: (body) =>
      has(body, (b) => b.title === 'Onboarding (rev 2)', 'expected the patch'),
  },
  {
    style: 'roles',
    label: 'a stranger gets 403, and learns nothing else',
    method: 'GET',
    path: '/api/documents/2',
    headers: as('mallory'),
    expectStatus: 403,
    expect: (body) => has(body, (b) => b.error === 'forbidden', 'expected 403 code'),
  },
  {
    style: 'roles',
    label: 'listing answers from the graph, not a filter',
    method: 'GET',
    path: '/api/documents',
    headers: as('alice'),
    expectStatus: 200,
    expect: (body) => {
      const found = ids(body);
      if (!found.includes('1') || !found.includes('2')) {
        throw new Error(`expected documents 1 and 2, got ${JSON.stringify(found)}`);
      }
      has(
        body,
        (b) => b.truncated === false,
        'a small list must report truncated: false',
      );
    },
  },

  // --- ownership -----------------------------------------------------------
  {
    style: 'ownership',
    label: 'an editor may not change who has access',
    method: 'POST',
    path: '/api/documents/1/roles',
    headers: as('bob'),
    body: { role: 'acme:viewer' },
    expectStatus: 403,
  },
  {
    style: 'ownership',
    label: 'the owner may',
    method: 'POST',
    path: '/api/documents/1/roles',
    headers: as('alice'),
    body: { role: 'acme:viewer' },
    expectStatus: 201,
  },
  {
    style: 'ownership',
    label: 'and the role can be taken away again',
    method: 'DELETE',
    path: '/api/documents/1/roles/acme:viewer',
    headers: as('alice'),
    expectStatus: 204,
  },
  {
    style: 'ownership',
    label: 'creating a document makes you its owner',
    method: 'POST',
    path: '/api/documents',
    headers: as('dana'),
    body: { title: 'Quarterly plan' },
    expectStatus: 201,
  },
  {
    style: 'ownership',
    label: 'so the new owner can immediately change it',
    method: 'PATCH',
    path: '/api/documents/5',
    headers: as('dana'),
    body: { body: 'Draft.' },
    expectStatus: 200,
  },
  {
    style: 'ownership',
    label: 'and nobody else can',
    method: 'PATCH',
    path: '/api/documents/5',
    headers: as('bob'),
    body: { body: 'tampered' },
    expectStatus: 403,
  },
  {
    style: 'ownership',
    label: 'a grant whose row was hard-deleted is a 404',
    method: 'GET',
    path: '/api/documents/9',
    headers: as('alice'),
    expectStatus: 404,
    expect: (body) => has(body, (b) => b.error === 'not_found', 'expected 404 code'),
  },
  {
    style: 'ownership',
    label: 'and a refused caller still gets 403, not 404',
    // The order matters. Authorize before looking the row up, or this returns 404
    // and the API becomes an existence oracle: anyone can probe for documents.
    method: 'GET',
    path: '/api/documents/9',
    headers: as('mallory'),
    expectStatus: 403,
  },
  {
    style: 'ownership',
    label: 'a malformed request is a 400, not a 403',
    method: 'POST',
    path: '/api/documents/1/roles',
    headers: as('alice'),
    body: { role: 'acme:superuser' },
    expectStatus: 400,
    expect: (body) => has(body, (b) => b.error === 'invalid_role', 'expected 400 code'),
  },

  // --- diagnostics ---------------------------------------------------------
  {
    style: 'diagnostics',
    label: 'why returns the decision tree, not a guess',
    method: 'GET',
    path: '/api/documents/2/why',
    headers: as('carol'),
    expectStatus: 200,
    expect: (body) =>
      has(
        body,
        (b) =>
          b.allowed === true &&
          typeof b.reads === 'number' &&
          typeof b.tree === 'object' &&
          b.tree !== null,
        'expected allowed, reads and a tree',
      ),
  },
];
