# Examples

Every example is a real, runnable program with assertions — not a snippet. If one
of these breaks, CI fails, so they cannot rot into fiction.

```bash
pnpm examples          # run them all
pnpm --filter @tsbouncer-examples/vanilla start
```

| example | what it shows |
| --- | --- |
| [`vanilla`](./vanilla) | the smallest useful model: ownership, teams, usersets, wildcards, exclusion, and inheritance |
| [`json-store`](./json-store) | authorization state as a human-readable, git-friendly file |
| [`conditions`](./conditions) | attribute-gated access, and why the tuple's bound parameters are authoritative |
| [`tuple-to-userset`](./tuple-to-userset) | access inheriting down a tree, and the direction of a `parent` tuple |
| [`multi-tenant`](./multi-tenant) | per-tenant ids, with no tenancy anywhere in the engine |

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
