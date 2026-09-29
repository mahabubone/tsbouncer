# A simple RBAC API — Hono, and a JSON file

The smallest thing that is actually a working application: [Hono](https://hono.dev)
routes, role-based access control, and authorization state in a file you can read.

Three types and one idea. **A document never names a person.** It names a *role*,
and the role names its holders, so onboarding someone is one write rather than one
per document.

```bash
pnpm --filter @tsbouncer-examples/hono-rbac start   # the tour
pnpm --filter @tsbouncer-examples/hono-rbac test    # the same scenarios, asserted
```

The tour starts the app on a random port, makes real HTTP requests against it, and
prints the JSON file at the end — because for this example the storage format is
half the point.

## What to read, in order

| file | what it answers |
| --- | --- |
| [`src/model.ts`](./src/model.ts) | how roles attach to a resource without naming anyone |
| [`src/data.ts`](./src/data.ts) | the tuples, and why the subject is `role:acme:editor#holder` |
| [`src/auth.ts`](./src/auth.ts) | identity, the 401/403 split, and the one guard function |
| [`src/app.ts`](./src/app.ts) | the routes, and the 403-before-404 ordering |
| [`src/server.ts`](./src/server.ts) | `jsonStore` in one line, and booting on port 0 |
| [`src/scenarios.ts`](./src/scenarios.ts) | 19 live requests, shared with the test suite |

## The one thing worth reading twice

An RBAC grant's subject is a **userset**, not the role:

```jsonc
{ "subject": "role:acme:editor#holder", "relation": "editor", "resource": "document:1" }
```

The model's edge is `relation('role', { through: 'holder' })`, so the tuple has to
name the relation that edge walks. The `#holder` is not decoration — drop it, and
write-time validation rejects the tuple with a message that says exactly this:

```
relation "editor" on "document" does not accept a "role" subject
```

This is the most common first mistake with the model, and it is caught at write
time rather than becoming a 403 nobody can explain.

## Two decisions in the routes worth copying

**Authorize before looking the row up.** Every route calls `requirePermission()`
first and only then looks for the document. A caller who may not read a document
therefore gets 403 whether or not it exists, so the API cannot be used to probe for
other people's data. Inverting those two lines is a free existence oracle.

**`document.manage` is not `document.write`.** Managing is owned by the owner;
editing is open to editors. A system where an editor can change who else has access
is a system where a compromised editor account exfiltrates the document.

## The three questions this library answers

```ts
// 1. may this subject? — the boolean the route needs
await authz.can('user:bob', 'document.read', 'document:1');

// 2. what may this subject? — a reverse walk, so a list route is not a filter
const { resources, truncated } = await authz.listResources({
  subject: 'user:bob',
  permission: 'document.read',
});

// 3. why not? — the whole decision tree, for the support question
const { allowed, tree, reads } = await authz.explain({
  subject: 'user:bob',
  permission: 'document.read',
  resource: 'document:1',
});
```

`truncated` is part of the contract: a budget that runs out mid-enumeration gives
you a partial list, and a bare array could not tell you. The route returns it even
when it is `false`.

## Storage, in one line

```ts
const authz = createAuthz({ model, store: jsonStore({ file: 'authz.json' }) });
```

Reads happen while the store is constructed; writes are already on disk when the
promise resolves, written to a temp file and renamed into place, so a crash cannot
leave a half-written access list. A missing file is an empty store, which is what
makes a checked-in fixture work. The directory has to exist — this store creates a
file, not a directory tree.

## Where this stops

There is no folder tree, no team membership, no inherited permissions, no
attributes, and no conditions here. That is deliberate: this is the shape to
internalise first. When the requirements outgrow it, read
[`../express-drizzle`](../express-drizzle) — the same library over a real database,
with ReBAC and ABAC on one model.
