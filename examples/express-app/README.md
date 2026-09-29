# express-app

A real documents API, running on real HTTP, demonstrating RBAC, ReBAC and ABAC
together — verified by Vitest against three different stores.

```bash
pnpm --filter @tsbouncer-examples/express-app start   # the tour
pnpm --filter @tsbouncer-examples/express-app test    # the same scenarios, asserted
```

## The situation

You have an Express app and a product that has outgrown "the document has an
owner". Now a document can be edited by anyone holding a role, inherited from a
folder, granted to a team, and gated on the caller's region — and one of them has
to still work when the next one arrives.

That is a real product, and modelling it as a single `owner_id` column stopped
being true some time ago. This is the API shape that replaces it.

## The three styles, on one model

Real systems are not pure. This one carries all three, because they compose:

| style | where it is | why |
| --- | --- | --- |
| **RBAC** | `role` + `relation('role', { through: 'holder' })` | a document names a *role*, not a person, so onboarding someone is one write and touches no document |
| **ReBAC** | folder tree, teams, sharing, wildcards | where most real access actually comes from |
| **ABAC** | two conditions on grants | a constraint the writer bound, and state only the caller has |

```ts
role: defineType({ relations: { holder: relation('user') } }),

document: defineType({
  relations: {
    owner: relation('user'),
    editor: relation('user')
      .or(relation('role', { through: 'holder' }))   // RBAC
      .or(relation('team', { through: 'member' }))   // ReBAC
      .or(wildcard('user')),                          // public
    viewer: relation('user').or(relation('team', { through: 'member' })),
    parent: relation('folder'),
    banned: relation('user').or(wildcard('user')),
  },
  permissions: {
    read: permission.or('owner', 'editor', 'viewer', ttu('parent', 'read')),
    write: permission.or(permission.allOf('owner', 'editor'), ttu('parent', 'write'))
      .except('banned'),
  },
}),
```

`write` has two ways in, and the difference is the point: **directly** it needs
`owner` *and* `editor`, so attaching an `editor` role to a document does not hand
out write to everyone holding it; **inherited**, it follows a tuple-to-userset to
the parent folder's `write`. A userset edge names a *relation*, and `write` is a
permission — which is exactly when you need a `ttu`.

## Two things a userset edge gets wrong at first

**The subject is a userset, not the object.** `relation('role', { through: 'holder' })`
means the tuple subject is the role *qualified by the relation the edge walks*:

```ts
{ subject: 'user:alice',           relation: 'holder', resource: 'role:acme:editor' },
{ subject: 'role:acme:editor#holder', relation: 'editor', resource: 'document:1' },
```

Two tuples: who holds the role, and which resources carry it. Write-time
validation rejects the shorter version, which is a useful error rather than a
silent deny.

**A permission cannot be inherited by a userset edge.** `through:` must name a
relation. Inheriting `write` from a folder is `ttu('parent', 'write')`, and the
model validator will tell you so at boot instead of at request time.

## The endpoints

| route | what it demonstrates |
| --- | --- |
| `GET /api/v1/me` | identity, plus a readable set via `listResources` |
| `GET /api/v1/documents` | inherited access, with `truncated` reported |
| `GET /api/v1/documents/:id` | `check` + an explicit 403 |
| `PATCH /api/v1/documents/:id` | `assert` + central error handling, and a 409 the graph does not own |
| `POST /api/v1/documents/:id/roles` | RBAC: attach a role to a resource |
| `POST /api/v1/roles/:role/holders` | RBAC: give someone the role; no document changes |
| `GET /api/v1/workspaces/:id` | tenant administration, including cross-tenant instance roles |
| `GET /api/v1/documents/:id/why` | `explain`, evaluated with the *asking* caller's context |
| `GET /api/v1/folders/:id/children` | the tree, for seeing how inheritance reaches a document |

Identity is one function. A real deployment reads a session there instead.

## What you will see

```
memory store

  app — the request lifecycle, which belongs to the application
  ok    no identity header is 401                        401
  ok    a bad region is 400, not 403                     400
  ...
  RBAC — role held by someone, attached to a resource
  ok    a role holder edits without the document naming them 200
  ok    a user with no grant is refused the same document 403
  ok    write needs owner and editor, so a role alone is not enough 403
  ...
  ABAC — constraints the writer bound, and state the caller supplies
  ok    region-bound grant holds for a matching caller   200
  ok    the same grant fails for the wrong region        403
  ok    the same grant holds once the caller is in that region 200
  ok    a query parameter cannot forge the caller region 403
  ok    a suspended account loses an otherwise valid grant 403
```

43 scenarios, run against **memory, a JSON file, and SQLite** — one app, three
stores, no code path that knows which.

## The scenarios that are worth pausing on

**`write needs owner and editor, so a role alone is not enough`** — bob holds
`acme:editor`, and that role is attached to `document:1` as an editor. He reads
it. He cannot write it. The intersection is doing real work.

**`a query parameter cannot forge the caller region`** — ABAC context comes from
headers the app reads, so `?callerRegion=us` changes nothing. The bound half lives
on the tuple; the live half is supplied by the app, never by the client.

**`a legal hold is 409, not 403`** — the graph *allows* the write (alice reaches
it through the folder), and the document is on hold. Two different questions, so
two different statuses, and the app owns the second one.

**`a user with no grant is refused the same document`** / **`an owner who is not
an editor reads her document`** / **`but ownership alone does not carry write`**
— the pairs are deliberate. An exclusion, a permission, or a wildcard is only
proven against the case next to it that says the opposite.

## Vitest

`test/api.test.ts` boots the app on an ephemeral port and makes real `fetch`
calls. It is not supertest and it does not call a handler directly.

```ts
describe.each(['memory', 'json', 'sqlite'])('API on the %s store', (store) => {
  // runs all 43 scenarios, reporting every failure rather than the first
});

describe('authorization invariants', () => {
  it('a denied check and a rejected write are different statuses');
  it('listing and reading agree, including for conditioned grants');
  it('a client cannot forge the ABAC context it is evaluated against');
  // ...
});
```

The scenario table in `src/scenarios.ts` is the single source: `main.ts` walks it
and prints, the suite asserts it. The tour you read is the thing CI checks.

The invariant tests are separate on purpose — they run on a fresh app each, so
editing the tour cannot quietly unmake them.

## The error handler is the part people get wrong

`isAuthorizationError` is true for a **denied check** *and* for a **rejected
write**. Mapping both to 403 is how a typo in a request body reports itself as
"you are not allowed", with nothing in the logs to say the server is at fault.
There is a scenario for each branch.

## Why the app is not in `packages/`

A framework adapter is the one thing that has to be rewritten for every framework,
and it is why a library ends up with `express/`, `fastify/`, and `hono/`
directories saying nearly the same thing. What is demonstrated here — a route
handler calling one `can` — is what a library should leave you.
