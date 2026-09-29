# Examples

Two runnable applications. Both are real programs with assertions: `pnpm examples`
runs them, CI fails if one breaks, and each has a Vitest suite that asserts the same
scenario table the tour prints. The documentation site links to these files as the
source of truth — see the [guides](https://tsbouncer.dev/guides).

```bash
pnpm examples                                              # run both
pnpm --filter @tsbouncer-examples/hono-rbac start          # the simple one
pnpm --filter @tsbouncer-examples/express-drizzle start    # the real-world one
```

| example | the situation | what it shows |
| --- | --- | --- |
| [`hono-rbac`](./hono-rbac) | you are wiring this into a new service and want the smallest thing that works | [Hono](https://hono.dev) routes, RBAC, and the whole access graph in a JSON file you can read and commit |
| [`express-drizzle`](./express-drizzle) | you have a product that outgrew `owner_id` | Express, Drizzle ORM and SQLite, with ReBAC, RBAC and three ABAC conditions on one model |

Read them in that order. The first is the shape to internalise; the second is where
the interesting failures are.

## How they are verified

Each example has a `src/scenarios.ts` listing live HTTP requests — a method, a path,
headers, and the status and body assertions that must hold. `src/main.ts` prints that
table as a tour and exits non-zero if a line fails; `test/api.test.ts` asserts the
same table. A demo and a gate reading one list cannot drift apart, which is the only
reason either of them is worth trusting.

That has already paid for itself. Writing `express-drizzle` found a real bug in
`listResources`: a self-referential folder chain (`folder → folder → folder`) lost
everything below the second folder, because the walk memoised the edges it had
already followed on `type:relation`. `check` allowed those documents and
`listResources` did not list them — the list/check disagreement the query layer is
supposed to be immune to. It is fixed, with a regression test in `packages/core`.

## Two things that surprise people

**A userset edge needs a userset subject.** An RBAC grant is
`role:acme:editor#holder`, not `role:acme:editor` — the `#holder` is the relation
the model's edge walks. Write the bare role and validation rejects it with a message
that says exactly this, which is the good kind of mistake to make.

**The parent is the subject.** `{ subject: 'folder:root', relation: 'parent',
resource: 'folder:eng' }` reads "folder:eng's parent is folder:root". A relation is
a property of the thing it is read from. The other way round validates cleanly and
then every inheritance rule in the system resolves to nothing, with no error anywhere.
