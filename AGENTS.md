# AGENTS.md

Guidance for AI agents and contributors working in this repo.

## What this is

`tsbouncer` — a TypeScript-native authorization graph SDK. You define authorization
data, relationships and policies; it evaluates access. It runs *inside* the app, over
pluggable storage. See `PLAN.md` for the full design and `IDEA.md` for the origin story.

## Non-negotiables

These are decided. Do not relitigate them in PRs; change `PLAN.md` deliberately first.

1. **ESM-only.** No CJS, no dual builds. `"type": "module"`, `import`-only exports,
   named exports only, `verbatimModuleSyntax`. Node `>=20.11`.
2. **No framework tooling.** No Express/Hono/Fastify/Nest middleware, no HTTP layer,
   no auth, no sessions, no JWT/OAuth. Ever. The app owns all of it.
3. **The `tsbouncer` root entry has zero dependencies and zero `node:*` imports.**
   Only `tsbouncer/json` may touch `fs`. Subpaths (`./memory`, `./json`,
   `./defaults`) exist so an app never loads a backend it did not ask for.
4. **Filtered reads are the only mandatory store primitive.** Do not add an optional
   `check?`/`listObjects?` fast path. Reverse walks and `expand` derive from `read()`.
   Reimplementing wildcard/rewrite/TTU/exclusion semantics per-adapter is how this
   library would ship subtly-wrong authorization.
5. **Model vs data stay separate.** Predicates (`defineCondition`) are code in the model.
   Tuples carry only the condition *name* + context params, so they serialize cleanly.
   The tuple's params are authoritative; the request only fills gaps. A caller that could
   override a bound param would be rewriting the constraint the grant was written with.
6. **Stores are dumb.** No condition evaluation, no permission resolution in a store.
7. **Fail closed.** Any condition error, missing context key, or thrown predicate means
   *not allowed* — never allowed, never throw through to the caller.

## Layout

```
packages/tsbouncer            tsbouncer            kernel at `.`, `./memory`, `./json`, `./defaults`
packages/stores/kysely        @tsbouncer/kysely
packages/stores/drizzle       @tsbouncer/drizzle
packages/stores/prisma        @tsbouncer/prisma
packages/testkit              @tsbouncer/testkit   conformance + golden suites
packages/tsbouncer       tsbouncer            batteries-included re-export
examples/                two runnable apps, verified in CI (`pnpm examples`)
docs/                    Astro 7 docs site; every snippet is type-checked
```

`docs/` is **not** part of the published surface and nothing in `packages/` depends
on it. It needs Node 22 (Astro's floor) while the library supports `>=20.11`, so
`pnpm build` and `pnpm test` filter it out and CI builds it separately.

`testkit` is the primary quality gate — there is no CLI. **Any new store must pass
the full conformance suite.** A store that does not pass is not done.

## SQL stores

All four SQL-backed adapters (`kysely`, `drizzle`, `prisma`, and later `json`) share
one table contract, so an application can switch adapters without migrating data:
`subject_type` / `subject_id` / `subject_relation`, `relation`,
`resource_type` / `resource_id`, `condition`, `context`.

**`subject_relation` and `condition` are `''` when absent, never `NULL`, and both
are `NOT NULL`.** A unique constraint over these columns is how `write({ mode:
'insert' })` rejects duplicates; in Postgres `NULL`s compare as distinct, so a
constraint containing a `NULL` never fires and `insert` silently stops rejecting
duplicates.

Two traps, both of which have already been paid for once:

- **A reference spans three columns, so a set of references is an OR of
  per-reference ANDs.** Independent equality tests per column match a row pairing
  one reference's type with another's id. `['user:alice', 'user:bob']` must not
  match a userset row.
- **Never guess a driver or dialect; ask.** Drizzle's query builders expose `run`,
  `all`, and `execute` on *both* sync and async drivers, so probing the builder
  classifies every async driver as sync — which silently commits transactions
  before their work lands. Inspect the client, and **refuse to start** rather than
  guessing when it is unrecognised. A wrong guess loses data silently; a thrown
  error does not.

`prisma` is generated, not source: run `prisma generate` before typecheck, build, or
pack. Its `test` script does this itself; CI does it as a separate step.

## Commands

```bash
pnpm install
pnpm build          # tsup, ESM only
pnpm typecheck
pnpm test           # vitest, includes testkit against every store
pnpm test:coverage  # vitest + v8, 90% gate, fails below threshold
pnpm examples       # runs both example apps; CI fails if one breaks
pnpm pack:check     # publint --strict + attw --profile esm-only
pnpm lint
pnpm check          # all of the above, in order
```

## Coverage

90% lines / branches / functions / statements, enforced in `vitest.shared.ts` and
run in CI. `src/index.ts` and `src/shape.ts` are excluded — a re-export barrel
and a types-only module both compile to no statements, so including them only
produces a permanent, misleading 0%.

A barrel still needs a real test: every package has `test/public-api.test.ts`,
which imports the barrel and asserts the export surface. That test, not the
coverage number, is what catches a dropped export.

Do not add code without a test. If a branch resists a test, either the code has
too many paths or the test is contrived — say which in the PR.

## Engine state

The engine is complete: direct, userset, wildcard, union, intersection, exclusion,
tuple-to-userset, and conditions. Every condition path fails closed — an undeclared
condition, a missing or mistyped declared param, a predicate that throws, and one that
returns false all resolve to not allowed with a reason in `explain()`. Do not make any
of them permissive to "fix" a failing test: a grant nobody checked is the one outcome
this library must never produce.

The three graph queries are implemented: `expand`, `listResources`, `listSubjects`.
Two rules govern them, and both exist because the alternative is a silent lie:

- **Every list reports `truncated`.** A budget that runs out mid-enumeration yields
  a partial answer, and a bare array cannot distinguish that from a small result
  set. `listResources` returns `{ resources, truncated }` rather than `string[]` for
  exactly this reason; do not "simplify" it back to an array.
- **`listSubjects` is symbolic, not concrete.** A `user:*` grant yields
  `allOfTypes: ['user']`, not an invented member list. A set that claims to be
  exhaustive and is not is the list-shaped version of a fail-open bug.

## Conventions

- TypeScript `strict`, no `any` in public surface.
- `src/index.ts` is always a barrel. Implementation goes in named modules, so
  the coverage exclusion for barrels stays accurate. A package that is *only* a
  barrel has nothing to measure — give it a real module (see `packages/tsbouncer`).
- `import type` for type-only imports; prefer `type` imports over value imports.
- Public API errors extend `AuthorizationError` and carry a stable `code`.
- Every new public function needs a type test or a runtime test. Prefer both for
  anything touching ref parsing.
- Keep comments out of the **library**. Explain *why* in `PLAN.md`, not inline.
  **Examples are the exception** and are commented heavily on purpose: they are
  the documentation a reader actually lands on, and a comment in an example costs
  nothing at runtime and teaches the reason behind a shape. `AGENTS.md` used to
  forbid this everywhere while the examples were doing exactly it, which is a rule
  a contributor cannot follow and does not learn from.

## Correctness traps

These are the bugs this design is most likely to produce. Check them when you touch
the evaluator.

- **Exclusion must not short-circuit.** `(owner and editor) except banned` breaks
  silently if the evaluator returns early on a satisfied base. Always evaluate both sides.
- **Wildcard x exclusion.** `user:*` on a `banned` relation must still exclude
  individual users.
- **TTU fan-out is multiplicative.** The node budget is per-*request*, not per-branch.
- **Memo scope.** The per-request memo must be keyed by store identity, or
  `withStore(trx)` returns results computed against the outer store. This is the
  subtlest bug in the codebase.
- **Cycle detection.** A `through` relation can form a loop the model validator
  cannot see — it only follows same-type `computed` edges, and TTU crosses types.
  The runtime `active` set catches it; a self-referential test model is in
  `test/fixtures.ts` for exactly this.
- **Userset and TTU both recurse on the tuple's `subject`.** Not opposite sides.
  A userset subject is stripped of its `#relation`; a TTU subject is entered under
  `target` resolved against its own type. Recursing on the `resource` in a TTU
  walks back up the edge and denies everything.
- **Memo granularity.** One frame per *member*, at its top-level node. Keying each
  node separately collides in three ways that all deny real access: a `computed`
  reference under the parent's name, a relation's own `direct`/`userset` children
  under the relation, and an exclusion's `base` under the exclusion.
- **A condition gates every edge kind.** `direct`, `userset`, and tuple-to-userset all
  route through one `splitByCondition` partition. They used to be three ad-hoc filters,
  and `userset` was briefly fail-open because only two of them checked.
- **A walk dedupes on the object, never on the edge it is following.**
  `candidateResources` memoised the `through` relations it had followed on
  `type:relation`, so two objects of the same type shared one token and the second
  was never walked. Everything below it in a self-referential
  `folder → folder → folder` chain was then invisible to `listResources` while
  `check` allowed it. The queue already visits each object once; memoising the
  *model read* per type is safe, memoising the *walk* per edge is not. The
  regression test in `test/query.test.ts` asserts each resource against `can`
  rather than against a literal list, which is the only shape that catches it.
- **A list endpoint and a detail endpoint are two implementations of one
  question.** Any change to the query layer needs a test that holds the two
  against each other. The bug above, and the earlier one where `listResources`
  dropped the `context` it promised to forward, are both list/check disagreement,
  and neither is caught by a test that asserts either side alone.

## Working agreement

- Keep the scope in `PLAN.md`. M1–M6, with the cut line after M4.
- No dependencies in `core` without a very good reason.
- Don't add a framework adapter, a CLI, or codegen. "Just this once" is how they get in.
- If you change a public API, update `PLAN.md` and the README in the same commit.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
