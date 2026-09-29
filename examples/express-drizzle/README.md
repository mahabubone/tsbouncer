# A real-world documents API — Express, Drizzle ORM, SQLite

A product that outgrew `owner_id`: a role system from the old monolith, a folder
tree from the file manager, sharing, legal hold, data residency, a seat limit, and
an account suspension switch. All live at once, over a real database, with
authorization as a separate concern from the rows.

```bash
pnpm --filter @tsbouncer-examples/express-drizzle start   # the tour: 50 live requests
pnpm --filter @tsbouncer-examples/express-drizzle test    # the same scenarios, plus invariants
```

## The one structural decision

**Domain rows here, access edges in the tuple table.**

```ts
// src/db/schema.ts — the application's tables, queried with Drizzle
export const documents = sqliteTable('documents', { /* id, folderId, title, region, onHold */ });

// …and the authorization table, built by the store's factory
export const tsbouncerTuples = sqliteTsbouncerTuples();
```

There is no `owner_id` on `documents`, and no `can_read` boolean. A document knows
its title and its folder; who may read it is a set of tuples that reference it by
id. The two halves share nothing but a string, so changing the access rules is not
a migration.

| file | what it answers |
| --- | --- |
| [`src/model.ts`](./src/model.ts) | the access model: 7 types, 3 conditions, and where they interact |
| [`src/seed.ts`](./src/seed.ts) | the fixture, grouped by which style of authorization is doing the work |
| [`src/db/schema.ts`](./src/db/schema.ts) | the tables, and the one the store owns |
| [`src/http.ts`](./src/http.ts) | identity, request context, and the one `requirePermission` call |
| [`src/app.ts`](./src/app.ts) | the routes, the transactional move, and the diagnostics |
| [`src/scenarios.ts`](./src/scenarios.ts) | 50 live requests, shared with the test suite |
| [`drizzle/0000_init.sql`](./drizzle/0000_init.sql) | the committed migration |

## Four things that are easy to get wrong

**1. A `parent` tuple names the parent as its subject.**

```ts
{ subject: 'folder:root', relation: 'parent', resource: 'folder:eng' }
//   folder:eng's parent is folder:root
```

The evaluator resolves `ttu('parent', …)` by reading `{ relation: 'parent', resource: <this object> }`
and taking the *subject* of what it finds. Written the other way round it validates
cleanly and every inheritance rule in the system quietly resolves to nothing.

**2. A wildcard edge accepts no direct subject.** `shared: wildcard('user')` rejects
`user:*` at write time, so a relation that has to hold a wildcard also declares the
direct edge: `shared: relation('user').or(wildcard('user'))`.

**3. The ban beats the wildcard, and beats ownership.** Document 5 is public
(`user:*` on `shared`) and Mallory is banned from it, so she gets 403 while every
other user gets 200. This is the behaviour every "publish" feature has needed since
the first one, and it is a consequence of evaluating both sides of the exclusion
rather than returning early on the branch that succeeded.

**4. A condition's unbound parameters come from the request — so they must come
from your database.** `sameRegion` compares the region the grant was written with
against the region the *request* reports. `resolveCaller` reads that from the
`organizations` table, never from a query parameter, and there is a scenario that
tries to forge it:

```
a client cannot forge the context it is judged against   403
```

Bound parameters are the opposite: a grant's own `context` is authoritative, and a
request that supplies the same key is ignored rather than winning.

## One route worth reading twice

Moving a document has to change two things that must agree — the `folder_id` column
and the `parent` relation authorization walks — or you have an orphaned grant or a
document whose access nobody can explain:

```ts
let pending: Promise<unknown> | undefined;
db.transaction((tx) => {
  tx.update(documents).set({ folderId }).where(eq(documents.id, id)).run();
  void drizzleStore(tx, tsbouncerTuples).delete({ /* the old parent edge */ });
  pending = drizzleStore(tx, tsbouncerTuples).write({ /* the new one */ });
});
await pending;
```

The shape is not stylistic. `better-sqlite3` is synchronous and Drizzle *rejects* a
transaction callback that returns a promise; on an async driver the same callback
would commit before its work landed. The store detects which kind of client it is
holding by inspecting the client — not by probing a query builder, because builders
expose `run`/`all`/`execute` on both kinds and a probe classifies every async driver
as sync. On a client it does not recognise it refuses to start rather than guessing.

Two scenarios assert the transaction did its job: after the move the new folder's
owner can read the document, and the old path is gone.

## Why the migration is hand-maintained

`drizzle-kit` resolves the schema module with CommonJS semantics, and every package
in this repo is ESM-only with an `exports` map that has no `require` condition:

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../@tsbouncer/drizzle/package.json
```

Adding a `require` condition would mean shipping a dual build, which this repository
does not do. So `drizzle/0000_init.sql` is maintained by hand and
[`test/schema.test.ts`](./test/schema.test.ts) is what holds it to the Drizzle
schema: it fails if a column is missing, if a `NOT NULL` is missing, or if the
unique index over the key columns is downgraded. That guard is not decorative —
`organizations.region` was added to the schema and not to the SQL during
development, and the only symptom was a `SqliteError` on the first seed insert.

## What `explain` is for

```
GET /api/v1/documents/1/why?permission=document.read
```

returns the whole decision tree — every relation tried, what each resolved to, and
how many store reads it took. The route deliberately does **not** require the
permission it is explaining, because the tree describes the caller's own request and
the moment you need it is when the answer was no.

`GET /api/v1/documents/5/who` is the other half. Document 5 is public, so the answer
is symbolic — `allOfTypes: ['user']`, `members: []`, `excluded: ['user:mallory']` —
rather than an invented roster of everyone in the database. A set that claims to be
exhaustive and is not is the list-shaped version of a fail-open bug.

## Known limits, stated

- `listResources` enumerates candidates and checks each, so its cost grows with the
  number of resources of that type. The result carries `truncated` and the routes
  return it, but a large deployment wants a narrower index.
- `notSuspended` is a property of one grant, not a global account lock: a suspended
  user still reaches a document that is public by wildcard. A system that wants a
  hard lock puts the condition on every grant or refuses the request in middleware
  before authorization is asked. Both are legitimate; neither happens by accident,
  and there is a test that pins the current behaviour down.
- `x-user-id` and `x-org` stand in for a session and a resolved host. In production
  neither is a client-chosen header; `src/http.ts` says so where it matters.
