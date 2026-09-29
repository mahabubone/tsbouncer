# `tsbouncer` — v0.1 Implementation Plan

> **The bouncer for TypeScript/JS ESM-only apps.**
> Define authorization data, relationships, and policies; evaluate access — over pluggable storage. No HTTP, no auth, no framework adapters, no build step, no CLI.

## Locked decisions

| Area | Decision |
|---|---|
| Name | `tsbouncer` + `@tsbouncer/*` (both verified free on npm) |
| License | Apache-2.0, public |
| Module system | **ESM-only.** No CJS, no dual build. Node `>=20.11` |
| Model | Object literal + typed helpers, defined and validated **in code at runtime** |
| Multi-tenancy | Opaque refs — tenancy is entirely the app's concern |
| Store contract | Filtered reads only; capabilities declared, not sniffed |
| Conditions | JS function predicates in the model; name + context on the tuple; **fail closed** |
| `explain()` | JSON-serializable tree + text formatter |
| v0.1 eval scope | direct, userset, wildcards, union/intersection/**exclusion**, **TTU**, **conditions** |
| Typing | Pragmatic — brand + runtime validate + permission-string autocomplete |

**What "pragmatic" cost, and what it now does.** The type helpers
(`PermissionOf`, `SubjectRefOf`, `ObjectRefOf`) were exported from the start and did
not compile against a real model. Three independent faults stacked:

1. `Model<M>` declared `types` as the runtime AST and carried the precise shape in a
   phantom `__shape`, so `Model` never satisfied `ModelShape` and every helper
   rejected `typeof model` at the constraint.
2. `defineType` returned `TypeConfig`, erasing the literal config it was handed — so
   the permission names were gone before anything could derive from them. It is now
   `<const C extends TypeConfig>(config: C): C`: identity at runtime, precise at the
   type level.
3. `ShapeOfConfig` mapped an undeclared `permissions` (the common case) to a string
   index signature, so "this type has no permissions" read as "any permission".

Fixing (1) by intersecting the shape into `Model['types']` is the obvious move and
is **wrong**: it makes `types.doc.permissions.read` resolve to the shape's `true`
instead of its `SetNode`, which is the AST the engine walks. The shape is therefore
reachable only on its own, via the exported `ModelShapeOf<M>`.

The permission union is now exact and locked by `test/types.test.ts` — the derivations
are type-level, so no runtime assertion could have caught their regression. The
*reference* unions stay loose: `` `user:${string}` `` also matches `user:x#member`,
because `${string}` swallows the `#`. That needs a branded id type, and is not worth
the machinery.

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
│  ├─ tsbouncer/       tsbouncer            kernel at `.`, `./memory`, `./json`, `./defaults`
│  │                                         zero deps and zero node:* imports at the root;
│  │                                         only `./json` touches fs
│  ├─ stores/kysely/   @tsbouncer/kysely
│  ├─ stores/drizzle/  @tsbouncer/drizzle
│  ├─ stores/prisma/   @tsbouncer/prisma
│  └─ testkit/         @tsbouncer/testkit   conformance + golden suites
├─ examples/           hono-rbac · express-drizzle
└─ pnpm-workspace.yaml
```

The single-package shape is Phase 5.5, recorded below. `packages/core` and the
`memory`/`json` store packages were folded into `tsbouncer` subpaths so an app
never loads a backend it did not ask for; the SQL adapters stayed separate
plugin packages with their names unchanged.

**There is a docs site** (`docs/`, Astro 7 + Tailwind 4, static output). It is
usage documentation and nothing else: `PLAN.md` remains the design record,
`AGENTS.md` the working rules, and `examples/` the runnable programs. Earlier
revisions of this file said there would be no site at all; that was wrong and was
corrected once the content existed rather than before.

The site's one non-obvious property is that **every TypeScript snippet on it is
type-checked against the built package** (`pnpm docs:test`). Snippet rot is the
normal fate of documentation, and the repository's READMEs carried unverified
snippets for months. A snippet that stops compiling now fails CI.

The site requires Node 22 (Astro 7's floor) while the library publishes
`>=20.11`, so it is excluded from the library's turbo tasks and built by a separate
CI job. The docs toolchain must not drag the library's Node floor up.

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
// limits      EvaluationRequest.limits · .budget   // one node budget per request
//             EvaluationOutcome.truncated          // the budget ran out; partial
// graph       expand({subject})
//             listResources({subject,permission}) -> { resources, truncated }
//             listSubjects({permission,resource}) -> SubjectSet { allOfTypes, members, excluded, truncated }
// model       authz.model · .types · .relations · .permissions
// scoping     authz.withStore(trx)   // app-owned transactions
```

**Store contract — the only mandatory primitive is a filtered read.** `listObjects`, `expand`, and all reverse walks derive from it. No optional `check?` fast path: reimplementing wildcard/rewrite/TTU/exclusion semantics per-adapter is the most likely route to a subtly-wrong authz library, and it's the one thing I'm not letting into v0.1.

```ts
interface TupleStore {
  read(q: ReadTupleQuery): Promise<Page<Tuple>>;  // filter by any subset of subject/relation/resource
  write(i: WriteInput): Promise<void>;            // { tuples, mode: 'insert'|'upsert' }
  delete(d: DeleteInput): Promise<void>;          // by key | by filter | replace-scoped
  capabilities: TupleStoreCapabilities;
}
```

## Milestones

| # | Deliverable | Risk |
|---|---|---|
| M1 | `refs` · `defineModel` · runtime validation · `memoryStore` · **`testkit`** | low |
| M2 | check engine — direct, userset, union, intersection, exclusion, wildcard · `explain` | low |
| M3 | TTU traversal (lands the `ttu` node) | **high** |
| M4 | conditions / ABAC, fail-closed | med |
| M5 | `jsonStore` (atomic temp+rename) | med |
| M6 | root `tsbouncer` pkg | low |
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
**Status:** M1–M4 and M6's code are shipped; S1–S3 shipped. Still to do: the docs site and the
release pipeline (changesets, publish, provenance), which were explicitly deferred.
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
6. **JSON write atomicity.** The temp file must be in the *same directory* as the
   target — `rename` is only atomic within a filesystem and `/tmp` often is not a
   different one. Mutations are serialized through a promise chain rather than an
   `await`, so two `grant` calls made without awaiting each other both land. A
   corrupt file is never silently reset: that turns a typo into an empty database
   the caller cannot detect.
7. **A query that accepts a `context` must use it.** `ListResourcesQuery` and
   `ListSubjectsQuery` both declare one, and both implementations accept one, but
   the client built its internal input without forwarding it. A conditionally
   granted resource was therefore *allowed* by `check` and *missing* from
   `listResources`, silently, with the public type promising the option was
   honoured. A file browser built on that hides documents the user can open, and
   nothing in the API says so. The types are the contract; a declared parameter
   that is dropped is worse than one that does not exist.
8. **`can()` had no way to express a condition.** It took three strings, so
   asking about a conditional permission was impossible — and a JavaScript caller
   who passed a fourth argument anyway had it silently ignored, producing a denial
   that looked like a policy decision. It now takes the same `CheckOptions` as
   `check`.
9. **A *declared* wildcard edge is not a grant.** `banned: relation('user')
   .or(wildcard('user'))` says the relation accepts a `user:*` subject; it does not
   put every user in the set. `listSubjects` once read it as "all users, no tuple
   required", so with an empty `banned` relation it subtracted everyone and
   reported *nobody* while `can` said allowed — the access list contradicting the
   decisions it summarises. `can`, `expand`, and `listSubjects` must agree on what
   membership requires: a stored `type:*` tuple, and nothing else.

## What M6 added

`tsbouncer` re-exports the kernel plus the two stores that need no external
dependency, and adds `createDefaultAuthz({ model, file? })` which picks between
`jsonStore` and `memoryStore`. It deliberately does **not** depend on Kysely,
Drizzle, or Prisma: an app that already has one of those should not acquire the
other two because it read a README.

The store choice is never inferred from the environment. Whether authorization
state should be durable is a decision about the application.

Examples are real programs with assertions and they run in CI, so they cannot rot
into fiction. Seven small ones were replaced by two applications
(`hono-rbac`, `express-drizzle`) on the grounds that a fragment cannot show the
order of a route's checks, where request context comes from, or what happens to a
transaction when a document moves — and that the interesting failures in
authorization are all of those. They were wrong on their first run too, and the
library's own write-time validation caught every one: a bare `role:acme:editor` where
the edge needed a userset, a wildcard edge asked to hold a `user:*` tuple, a
`parent` tuple written the wrong way round, and a hand-maintained migration that had
drifted from the schema. That is the argument for validating at `grant` rather than
only at `check`.

The second one also found a real engine bug rather than a real bug report.
`listResources` memoised the `through` edges it had already followed on
`type:relation`, so two objects of the same type shared a token and the second was
never walked — every document below the second folder in a self-referential
`folder → folder → folder` chain was invisible to the list while `check` allowed it.
Fixed, with a regression test that holds the list to the check rather than to a
literal.

## Quality gates (CI)

typecheck · lint · test · build · `publint` · `arethetypeswrong` (ESM-only profile) · 90% coverage on every package · examples · testkit green for all five stores.

Two of these are not obvious from the file list, and both were added after a gap
was found rather than by design:

- **The golden dataset.** `storeConformance` proves a store honours the *contract*.
  It cannot prove two stores honour it *identically*, because each is tested against
  its own fixtures — so a filter that over-matches in Drizzle and not in Kysely
  passes both suites and answers different questions. `testkit`'s `golden.ts` is one
  dataset with recorded answers, generated by `memoryStore` (no query builder, so
  nothing at the SQL layer to get wrong) and asserted by every store. That is the
  only thing that makes "switch adapters without migrating data" a tested claim.
- **testkit's own tests.** The conformance suite is 320 lines that nothing executed,
  so a vacuous assertion would have made all five stores green while verifying
  nothing. `testkit/test/` now builds deliberately broken stores — one whose filter
  returns every row, one that drops `condition` bindings — and asserts the golden
  suite rejects both. A gate that has only ever seen honest stores is untested.
- **The contract report.** `testkit/src/contract.ts` is a shape for expectations
  that state a guarantee in words, run against a real implementation, and report a
  pass or fail per clause. `packages/testkit/coverage/contract/report.md` is uploaded
  by the existing CI job. The unit suite proves the same things and says less: a
  clause reads `expect: an exclusion removes an access its own base granted`, which
  is answerable without reading the evaluator. A clause that throws fails, because a
  contract that treats a crash as a pass reports green on a broken library.

  It is not a test framework — no discovery, no fixtures, no mocking, no lifecycle.
  It exists because the pitch is a list of guarantees, and a list of guarantees
  should be readable without the source.

## Release state

All five packages carry `1.0.0-preview.1` and `pnpm versions` fails the build if they
drift. There is no publish automation and none is planned yet: the release is a
hand-cut publish in dependency order plus a git tag, exactly as
[CONTRIBUTING.md](./CONTRIBUTING.md#cutting-a-release) prescribes. That is deliberate
while the API is still moving — a changelog tool that computes versions from commit
messages would give a false impression of a settled API.

Postgres and MySQL are **not** tested. `DIALECTS` claims all three and only SQLite
and libsql run in CI, so "swap adapters without migrating data" is verified across
query builders and *not* across databases — which is where `insert` vs `upsert`
actually diverges. Testing them needs a running server, which is the one thing this
project does not want to spend CI minutes on yet.

## Phase 0 cleanup

`git init` · add `LICENSE` (doesn't exist yet) · fill the 0-byte stubs (`README`, `AGENTS`, `CHANGELOG`, `CONTRIBUTING`, `SECURITY`, `.gitignore`, `.node-version`) · ~~rename the directory `keyman` -> `tsbouncer`~~ **done** · ~~rename the `KeymanStore` / `KeymanStoreCapabilities` types~~ **done**, they are `TupleStore` / `TupleStoreCapabilities`.

**Housekeeping:** `IDEA.md` contradicts the plan in three places — `@Keyman/*` naming (§17, §18), the optional `check?` store contract (§12), and the CLI (§16, §19). It stays as the origin story, and it now **carries a header saying so**, listing those three reversals and pointing at this file. A stale design doc that disagrees with the code is worse than no design doc; a banner that names the disagreement is the cheap fix. `docs/architecture.md` is not being written — the locked decisions are recorded here, the usage documentation is the guides (self-contained install → code → verify tutorials), and the runnable counterparts live in `examples/` and run in CI.

## Settling toward v1 — audit-driven close-out (2026-09-29, now `1.0.0-preview.1`)

A review of the `tsbouncer` package against the comparison catalog
(`docs/src/content/docs/reference/comparison.mdx`) produced six findings, reproduced
against running code. Settling v1 means fixing or disclosing all six, then staging
for publish. CI / publish / provenance automation is explicitly deferred until the
staged state is marked ready.

Locked decisions (no relitigation without editing this section first):

| # | Decision |
|---|---|
| F1 | Tuple identity stays `(subject, relation, resource, condition-name)` — bound `context` params are **not** part of the key. One edge holds one param-set per condition; a second binding is rejected with an actionable error, and the rule is documented. |
| F2 | `expand` becomes condition-aware: it threads an optional request `context` and gates membership tuples the same way `listSubjects` does, instead of remaining a pure membership closure. |
| F3 | `Decision` and `ExplainResult` gain `truncated: boolean`, forwarded from `EvaluationOutcome`. Additive only. |
| F5 | `tupleKey` uses an unambiguous encoding (no `'|'`-joined fields). SQL stores are unaffected (separate columns). |
| F6 | The full-store scan behind `listResources` and the materialized result lists are disclosed; the query layer honours `limit`/`cursor` where it does not change semantics. Full streaming lists are v1.1, with a filed issue. |
| F4 | The comparison's transactional-reads story is scoped to the kernel + SQL adapters — the `tsbouncer/memory` and `tsbouncer/json` stores are non-transactional. Docs-only. |

Phases: **0** lock semantics here (this section) → **1** F3 + F5 with tests → **2** F1 error message + contract clause + docs → **3** F2 context threading + `expand`↔`check` agreement test → **4** F6 disclosure + `limit`/`cursor` groundwork → **5** comparison page + docs sync (incl. F4) with `docs:test` / `docs:build` / link check → **6** settle gates (`lint`, `versions`, `typecheck`, `build`, `pack:check`, `test:coverage` 90% gate, `examples`, testkit green on all five stores, regenerated contract report) plus `CHANGELOG.md` entry and a written hand-cut publish/tag procedure. Phases 1–2 and 3–4 are independent after Phase 0 and may run as parallel workstreams.

**Deferred to v1.1 (F6 remainder).** `listResources` / `expand` return materialized
arrays; there is no streaming or async-iterable form, and evaluator reads stay
unpaged by design (a partial page inside `check` would decide on incomplete data).
The v1 groundwork — a capability-gated cursor loop for the set-grant scan, with a
test proving a paged scan answers identically to an unpaged one — is the consumer
a streaming implementation will build on. There is no issue tracker for this repo
yet (no remote), so this paragraph is the filing until there is.

## Phase 5.5 — site IA, single-package shape, preview versioning (locked 2026-09-29)

No changesets, no CI/release pipelines in this phase — those start only after the
staged state is marked ready. This phase restructures and stages.

| # | Decision |
|---|---|
| Site | New marketing landing at `/`; all docs under `/docs/*`; current intro becomes `/docs`. Static output, served from GitHub Pages as a **project subpath** (`base: '/tsbouncer/'` under `github.com/mahabubone/tsbouncer`). |
| Links | Absolute internal links do not survive Astro `base`, so content links go relative, components/layout use `BASE_URL`, and the snippet/link checkers resolve the `/docs/*` routes. |
| Package | **One `tsbouncer`**: the kernel (today's `@tsbouncer/core`) at `.`, `./memory`, `./json`, `./defaults` (`createDefaultAuthz`); adapters stay separate plugin packages **with current names** (`@tsbouncer/kysely`, …); `@tsbouncer/testkit` stays separate. Root never pulls `fs` — `jsonStore` lives behind `./json` only. |
| Version | Preview chain `1.0.0-preview.N` (`.1`, `.2`, … — plain numeric identifiers, so precedence stays chronological; month names would sort lexically and break it), single version enforced everywhere as today. The `v` prefix lives on git tags only, never in `package.json`. Final is `1.0.0`. |
| Deploy | Pages deploy automation is deferred with the other pipes; this phase proves the SSG output (`docs:build` under `base`) and documents the manual publish steps. |
| Build order | `@tsbouncer/testkit` takes the kernel as a **peer** dependency (one kernel per install, never two), so turbo's `^build` does not order it after `tsbouncer#build` — and `tsbouncer` dev-depends on the testkit for its store suites, so a blanket edge would be a cycle. Each side declares its edge explicitly instead: `packages/testkit/turbo.json` orders its tasks after `tsbouncer#build`, and `packages/tsbouncer/turbo.json` narrows `build` to `dependsOn: []` (the kernel build needs nothing). CI caught the missing edge on a clean tree; local builds had masked it with stale `dist/`. |
