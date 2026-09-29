# tuple-to-userset

Access inheriting down a tree, across types, to whoever owns it.

```bash
pnpm --filter @tsbouncer-examples/tuple-to-userset start
```

## The situation

Support says: *"why can't I open that document? I gave the whole team access to the
top-level folder months ago."*

Because granting access to `folder/root` four months ago means nothing about
`document/api` today, unless the rule that carries the access down the tree exists.
Hand-rolled, that is either a recursive function that never quite terminates, or
`owner_id IN (SELECT id FROM resources WHERE parent_id = ?)` — a recursive CTE in
your application code, written differently in every function that needs it.

## The shape of it

`ttu('parent', 'read')` means "follow `parent`, then take `read` over there". It is
the one shape that reads like a graph walk, and the one most easily implemented
backwards.

An org admin has no tuple on any document. They reach one by walking up to the
folder that names the org, and picking up `manage` there:

```
folder/root
  ├─ folder/engineering
  │    └─ folder/backend
  │         ├─ document/api
  │         └─ document/infra
  └─ folder/design
```

`document` has no `org` edge at all — it reaches its org through its parent chain.
One traversal is enough because permissions compose.

## The mistake to not make

**A relation is a property of its resource, so the parent is the subject.**

```ts
// "document:api's parent is folder:backend"
{ subject: 'folder:backend', relation: 'parent', resource: 'document:api' }
```

Write-time validation rejects the reverse rather than letting it deny silently later,
but it is still the single most common mistake with this model.

## What you'll see

```
ok    org admin reads a document               allowed
ok    org admin manages the folder it owns     allowed
ok    stranger reads nothing                   denied
```

followed by the full `explain()` trace for the allow, walking `document:api` →
`folder:backend` → `folder:engineering` → `folder:root` → `org:1`, and then the
denial for the stranger. The denial is the interesting half: it is the shape of the
graph that was searched and came back empty, not a guess about why.

Note that `parent` only accepts `folder`, so an org cannot appear in a parent chain.
Mixing a new type into a traversal the model does not allow is rejected at write
time, not discovered at check time.

## Why can't they open it?

The tree above is the shape most support questions are actually about. `explain` is
built for it — every leaf cites either the tuples that produced it or the query that
came back empty, so a denial names the edge that failed instead of asserting a guess:

```ts
import { formatExplain } from 'tsbouncer';

const result = await authz.explain({ subject, permission: 'document.read', resource });
if (!result.allowed) {
  // "ada is not allowed to document.read on document:api" — and here is the walk
  logger.info(formatExplain(result), { reads: result.reads });
}
```

The output is a plain JSON-serializable tree as well as text (`result.tree`), so the
same call can feed a support UI, a test assertion, or a log line. That is the
difference between a decision and a decision you can hand to someone else.

## Building a "what can I see?" list

The same traversal drives the positive direction, which is what a file browser
actually wants:

```ts
const { resources, truncated } = await authz.listResources({
  subject: `user:${session.userId}`,
  permission: 'document.read',
});

if (truncated) {
  // the budget ran out — this is a partial answer, so say so rather than
  // letting the UI present a short list as a complete one
}
```

`truncated` is not decoration. A query that runs out of budget part-way returns a
partial answer, and a bare array cannot distinguish "some of them" from "all of
them" — so the result is an object rather than an array, and the caller is
obligated to know which it got.

## Next

[`multi-tenant`](../multi-tenant) picks up the id-scoping question this example
only gestures at.
