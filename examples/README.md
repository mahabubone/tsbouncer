# Examples

Every example is a real, runnable program with assertions — not a snippet. If one
of these breaks, CI fails, so they cannot rot into fiction. They are also typechecked,
which is how the conditions example was caught reading `unknown` where it declared a
`number`.

Each example has its own README explaining what it shows, what output to expect, and
the one thing about it worth reading twice.

```bash
pnpm examples          # run them all
pnpm --filter @tsbouncer-examples/vanilla start
```

| example | the situation | what it shows |
| --- | --- | --- |
| [`hand-rolled`](./hand-rolled) | you already have a `canRefund()` and it is quietly wrong | replacing it: a cross-tenant leak and a ban bypass, both fixed |
| [`express-app`](./express-app) | you have an Express app and a product that outgrew `owner_id` | a real documents API over real HTTP — RBAC, ReBAC and ABAC together, on three stores |
| [`vanilla`](./vanilla) | a small document tool with teams, folders, and public docs | the smallest useful model: ownership, usersets, wildcards, exclusion, inheritance |
| [`multi-tenant`](./multi-tenant) | you just onboarded customer forty | per-tenant ids, with no tenancy anywhere in the engine |
| [`tuple-to-userset`](./tuple-to-userset) | support asks why a folder grant stopped working | access inheriting down a tree, and the direction of a `parent` tuple |
| [`conditions`](./conditions) | you sell per-seat access | attribute-gated access, and why the tuple's bound parameters are authoritative |
| [`json-store`](./json-store) | a fixture, a seed script, and a demo env | authorization state as a human-readable, git-friendly file |

If you read one, read [`hand-rolled`](./hand-rolled) — it is the case for the
library. If you are wiring this into something you already have, read
[`express-app`](./express-app). [`vanilla`](./vanilla) is the shortest useful
program and the one to start from once you believe the case.

## Two things that surprise people

**A relation is a property of its resource, so the parent is the subject.**
`{ subject: 'folder:backend', relation: 'parent', resource: 'document:api' }`
reads "document:api's parent is folder:backend". Write-time validation rejects the
reverse, but it is still the single most common mistake with this model — the
`tuple-to-userset` example says so out loud.

**A direct team subject is not its members.** `team:eng` written directly grants
the team *object*; `team:eng#member` grants everyone who is a member. They are
different grants with the same relation name, which is why the `vanilla` example
carries an assertion for each.
