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
3. **`@tsbouncer/core` has zero dependencies and zero `node:*` imports.** Only
   `@tsbouncer/json` may touch `fs`.
4. **Filtered reads are the only mandatory store primitive.** Do not add an optional
   `check?`/`listObjects?` fast path. Reverse walks and `expand` derive from `read()`.
   Reimplementing wildcard/rewrite/TTU/exclusion semantics per-adapter is how this
   library would ship subtly-wrong authorization.
5. **Model vs data stay separate.** Predicates (`defineCondition`) are code in the model.
   Tuples carry only the condition *name* + context params, so they serialize cleanly.
6. **Stores are dumb.** No condition evaluation, no permission resolution in a store.
7. **Fail closed.** Any condition error, missing context key, or thrown predicate means
   *not allowed* — never allowed, never throw through to the caller.

## Layout

```
packages/core            @tsbouncer/core      the kernel, zero deps
packages/stores/memory   @tsbouncer/memory
packages/stores/json     @tsbouncer/json
packages/testkit         @tsbouncer/testkit   conformance suite
packages/tsbouncer       tsbouncer            batteries-included re-export
examples/                runnable, verified in CI
```

`testkit` is the primary quality gate — there is no CLI. **Any new store must pass
the full conformance suite.** A store that does not pass is not done.

## Commands

```bash
pnpm install
pnpm build          # tsup, ESM only
pnpm typecheck
pnpm test           # vitest, includes testkit against every store
pnpm test:coverage  # vitest + v8, 90% gate, fails below threshold
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

## Conventions

- TypeScript `strict`, no `any` in public surface.
- `src/index.ts` is always a barrel. Implementation goes in named modules, so
  the coverage exclusion for barrels stays accurate.
- `import type` for type-only imports; prefer `type` imports over value imports.
- Public API errors extend `AuthorizationError` and carry a stable `code`.
- Every new public function needs a type test or a runtime test. Prefer both for
  anything touching ref parsing.
- Keep comments out of the code. Explain *why* in `PLAN.md` / `docs/`, not inline.

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
- **Cycle detection.** TTU and nested rewrites can loop. `seen` set + depth/node
  budget + deadline, all enforced together.

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
