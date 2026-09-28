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
| SQL stores | Kysely, Drizzle, Prisma as Tier 1 (promoted from v0.2 — see below) |
| Out of scope | CLI, codegen, bundler, Redis/Mongo/TypeORM, cache, full compile-time inference, any framework adapter |

**Scope change (post-M1).** Kysely/Drizzle/Prisma were originally deferred to v0.2 and
promoted to immediate. Two justifications: a store is independent of the evaluator, and
the conformance suite makes a store buildable against an already-proven contract — so
these do not block on the check engine. And IDEA.md §7 argued for them "from day one"
as Tier 1. They still ship *before* the evaluator, which is unusual but sound: the
contract they implement is fixed, and every one of them is verified by the same suite.

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
// definition (runtime-validated at createAuthz)
defineModel, defineType, relation, permission, defineCondition

// client
createAuthz({ model, store })

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
| M3 | TTU traversal (lands the `ttu` node) | **high** |
| M4 | conditions / ABAC, fail-closed | med |
| M5 | `jsonStore` (atomic temp+rename) — makes testkit pass again | med |
| M6 | root `tsbouncer` pkg · docs · examples · release | low |
| S1 | `@tsbouncer/kysely` — filtered reads over the app's existing Kysely instance | med |
| S2 | `@tsbouncer/drizzle` — same, over the app's existing Drizzle instance | med |
| S3 | `@tsbouncer/prisma` — same, over the app's existing `PrismaClient` | med |

**S1–S3 run between M1 and M2.** They implement a contract that is already fixed and
tested, so they neither depend on nor delay the evaluator. Each must pass the same
conformance suite, against real SQL. This is the whole return on building `testkit`
first: eight adapters become eight runs of one suite instead of eight bespoke test
sets.

**Portability is the hard part, not the query builder.** `read()` maps to indexed
equality, which is easy. `write` with `mode: 'insert'` needs unique-violation
detection, and `upsert` has genuinely different SQL per dialect
(`ON CONFLICT` vs `ON DUPLICATE KEY UPDATE` vs `INSERT OR REPLACE`). Each adapter
must use its ORM's native per-dialect path or a transactionally correct fallback —
never a dialect-specific incantation that silently no-ops elsewhere.

**M1 before M2 deliberately:** prove the store contract with `memoryStore` + a conformance suite *before* building an engine on it. With no CLI, testkit is the primary quality gate, so it cannot come last.

**M2 pulled the budget work forward.** Depth, node, and deadline limits, the per-request
memo, and the cycle guard all landed with the engine rather than in M3. A rewrite engine
without them is a denial-of-service vector, and TTU is only *more* dangerous. M3 is now
just tuple-to-userset.

### Userset and tuple-to-userset are cousins, not mirrors

Both issue the same read — tuples for `(relation, this object)` — and both recurse
into each tuple's **subject**. What differs is what that subject means:

| | subject | recurse into |
| --- | --- | --- |
| `userset` | a userset, `team:eng#member` | `team:eng`, under the relation the userset named |
| `ttu` | a plain object, `folder:9` | `folder:9`, under `target`, resolved against the subject's own type |

The trap is assuming `ttu` mirrors it and recursing on the *resource* instead. That
walks back up the edge, re-tests the object the walk started from, and denies every
real grant — while looking like a traversal that simply never matches. Resolving
`target` against each parent's own type is what makes a multi-type `through` relation
work with nothing extra from the model.

### Memo granularity — the rule that took three attempts to get right

The memo is keyed `subject#member@resource` and **one frame is opened per member, at its
top-level node**. `union`, `intersection`, and `exclusion` are walked without opening
frames. Keying every node individually is tidier and wrong, in three distinct ways, each
of which denied access that plainly existed:

- a `computed` reference keyed under the *parent's* member name collided with the
  parent's own key, so `read = or(owner, …)` self-reported a cycle;
- a relation's own `direct`/`userset` children collided with the relation, so
  `editor = user | team#member` denied everything;
- an exclusion's `base` inherited the exclusion's key, so `(a and b) except banned`
  denied everyone who satisfied the base.

A member's answer is a pure function of `(subject, member, resource)`, so one frame per
member is both the simplest and the only correct granularity.
**Cut line:** M1+M2+M5+M6 is a shippable alpha if M3/M4 overrun. They're in v0.1 as you decided; this is only the escape hatch.
**Status:** M1–M4, S1–S3 shipped. M5 (`jsonStore`) and M6 (root package, docs, release) remain.
The engine is complete: ReBAC/RBAC, usersets, wildcards, tuple-to-userset, and conditions.

### Conditions: what binds and what arrives

A condition has two halves of input. The **tuple** carries what the writer bound —
`resourceRegion: 'eu'` is part of the grant and is stored with it. The **request**
carries what the caller knows right now — `userTier: 'pro'` is not in the store at all.
The predicate sees `{ ...request, ...tuple }`.

**The tuple wins on a conflict.** If the request could override `resourceRegion`, a
caller could rewrite the constraint the grant was written with and the condition would be
theatre. There is a test for exactly that.

The optional `params` schema governs what a *tuple* may bind, not everything the
predicate reads — `userTier` is never bound, so declaring it would be wrong. Its real
job is making a **missing** key detectable: a JavaScript predicate reading an absent key
just gets `undefined` and quietly returns false, which is indistinguishable from a
genuine denial. Declaring params turns that silence into a reason in `explain()`.

Every condition path fails closed, in this order: undeclared condition, missing declared
param, wrong param type, predicate threw, predicate returned false. A tuple that carries
a condition is now evaluated rather than skipped, on all three edge kinds — `direct`,
`userset`, and tuple-to-userset — via one shared partition, so they cannot drift apart on
what "conditional" means.

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
