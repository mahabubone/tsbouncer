# `tsbouncer` — v0.1 Implementation Plan

> **The bouncer for TypeScript/JS ESM-only apps.**
> Define authorization data, relationships, and policies; evaluate access — over pluggable storage. No HTTP, no auth, no framework adapters, no build step, no CLI.

## Locked decisions

| Area | Decision |
|---|---|
| Name | `tsbouncer` + `@tsbouncer/*` (both verified free on npm) |
| License | MIT, public |
| Module system | **ESM-only.** No CJS, no dual build. Node `>=20.11` |
| Model | Object literal + typed helpers, defined and validated **in code at runtime** |
| Multi-tenancy | Opaque refs — tenancy is entirely the app's concern |
| Store contract | Filtered reads only; capabilities declared, not sniffed |
| Conditions | JS function predicates in the model; name + context on the tuple; **fail closed** |
| `explain()` | JSON-serializable tree + text formatter |
| v0.1 eval scope | direct, userset, wildcards, union/intersection/**exclusion**, **TTU**, **conditions** |
| Typing | Pragmatic — brand + runtime validate + permission-string autocomplete |
| Out of scope | CLI, codegen, bundler, Kysely/Drizzle/Prisma, Redis/Mongo/TypeORM, cache, full compile-time inference, any framework adapter |

## Repo layout

```
tsbouncer/
├─ packages/
│  ├─ core/            @tsbouncer/core      zero deps, zero node:* imports
│  ├─ stores/memory/   @tsbouncer/memory
│  ├─ stores/json/     @tsbouncer/json      only package touching fs
│  ├─ testkit/         @tsbouncer/testkit   conformance suite
│  └─ tsbouncer/       tsbouncer            batteries-included re-export
├─ examples/           vanilla · json · multi-tenant-saas · conditions · ttu
├─ docs/
└─ pnpm-workspace.yaml
```

## Public API

```ts
// definition (runtime-validated at createKeyman)
defineModel, defineType, relation, permission, defineCondition

// client
createKeyman({ model, store })

// data        grant · revoke · write · delete · replace · export · import
// decisions   can(s,p,r) -> boolean
//             check({subject,permission,resource}, {context}) -> Decision
//             assert(...) -> throws AuthorizationError
//             explain(...) -> { allowed, tree, ... }  |  format(e) -> string
// graph       expand · listResources · listSubjects
// model       authz.model · .types · .relations · .permissions
// scoping     authz.withStore(trx)   // app-owned transactions
```

**Store contract — the only mandatory primitive is a filtered read.** `listObjects`, `expand`, and all reverse walks derive from it. No optional `check?` fast path: reimplementing wildcard/rewrite/TTU/exclusion semantics per-adapter is the most likely route to a subtly-wrong authz library, and it's the one thing I'm not letting into v0.1.

```ts
interface KeymanStore {
  read(q: ReadTupleQuery): Promise<Page<Tuple>>;  // filter by any subset of subject/relation/resource
  write(i: WriteInput): Promise<void>;            // { tuples, mode: 'insert'|'upsert' }
  delete(d: DeleteInput): Promise<void>;          // by key | by filter | replace-scoped
  capabilities: KeymanStoreCapabilities;
}
```

## Milestones

| # | Deliverable | Risk |
|---|---|---|
| M1 | `refs` · `defineModel` · runtime validation · `memoryStore` · **`testkit`** | low |
| M2 | check engine — direct, userset, union, intersection, exclusion, wildcard · `explain` | low |
| M3 | TTU traversal · limits · memo · cycle detection | **high** |
| M4 | conditions / ABAC, fail-closed | med |
| M5 | `jsonStore` (atomic temp+rename) — makes testkit pass again | med |
| M6 | root `tsbouncer` pkg · docs · examples · release | low |

**M1 before M2 deliberately:** prove the store contract with `memoryStore` + a conformance suite *before* building an engine on it. With no CLI, testkit is the primary quality gate, so it cannot come last.
**Cut line:** M1+M2+M5+M6 is a shippable alpha if M3/M4 overrun. They're in v0.1 as you decided; this is only the escape hatch.

## Correctness risks to design against up front

1. **Exclusion must not short-circuit.** `(owner and editor) except banned` fails silently if the evaluator returns on a satisfied base. Both sides must always be evaluated.
2. **Wildcard x exclusion.** `user:*` in a `banned` relation must still exclude individual users.
3. **TTU fan-out is multiplicative.** The node budget must be per-*request*, not per-branch, or a wide graph bypasses it.
4. **Memo scope.** The per-request memo must be keyed by store identity too — otherwise a `withStore(trx)` call returns results computed against the outer store. This is the subtlest bug available in this design.
5. **Conditions fail closed.** Missing key, thrown predicate, or unsatisfied -> not allowed, with the reason captured in `explain()`. Tuple-declared params are authoritative; request context only fills gaps.
6. **JSON write atomicity.** temp file + `fs.rename`, plus a serialized write queue to prevent interleaved mutations.

## Quality gates (CI)

typecheck · lint · test · build · `publint` · `arethetypeswrong` (ESM-only profile — **flag value to verify at setup**) · bundle-size check on `core` · testkit green for both stores.

## Phase 0 cleanup

`git init` · add `LICENSE` (doesn't exist yet) · fill the 0-byte stubs (`README`, `AGENTS`, `CHANGELOG`, `CONTRIBUTING`, `SECURITY`, `.gitignore`, `.node-version`) · rename the directory `keyman` -> `tsbouncer`.

**Housekeeping:** `IDEA.md` now contradicts the plan in three places — `@Keyman/*` naming (§17, §18), the optional `check?` store contract (§12), and the CLI (§16, §19). Keep it as the origin story and add `docs/architecture.md` recording the locked decisions, so the design doc doesn't mislead future readers or contributors.
