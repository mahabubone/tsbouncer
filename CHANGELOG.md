# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every published package carries the same version, and `pnpm versions` fails the
build if they drift. Releases are cut by hand; see [CONTRIBUTING.md](./CONTRIBUTING.md).

## [Unreleased]

### Added

- The `Cache` port and `withCache` memoization: `can`/`check` consult any
  cache, invalidate by resource on every write, require a model-versioned
  namespace, and degrade to uncached evaluation rather than risk a stale
  allow. `cacheConformance` in testkit mirrors `storeConformance`.
- `@tsbouncer/in-memory` and `@tsbouncer/redis` implement both ports
  (`memoryCache`, `redisCache` with server-side TTL).

### Changed

- Backends moved out of the root package into adapter packages —
  `@tsbouncer/in-memory`, `@tsbouncer/json-file`, `@tsbouncer/defaults` — so
  `tsbouncer` is kernel and ports only. Import paths change accordingly
  (`tsbouncer/memory` is now `@tsbouncer/in-memory`, and so on).

## [1.0.0-preview.1] - 2026-09-29

The first public preview. One `tsbouncer` package, three store plugins, and a
docs site — all staged, none published yet. Preview versions chain as
`1.0.0-preview.N`; the API is not settled.

### Added

- `truncated` on `Decision` and `ExplainResult`: a budget that runs out denies,
  and now says so on every answer shape instead of only the list queries.
- `expand` accepts request context and gates conditional memberships on it, with
  an `expand`↔`can()` agreement test mirroring the list-query ones.
- The docs site has a landing page at `/` with all documentation under `/docs/*`,
  built as static output for GitHub Pages project-subpath hosting.

### Changed

- **Ports and adapters.** The kernel (`tsbouncer`) declares two ports —
  `TupleStore` and the new `Cache` contract — and each backend is a separate
  plugin package exposing what it implements: `@tsbouncer/in-memory` and
  `@tsbouncer/redis` do store + cache, `@tsbouncer/json-file`, `@tsbouncer/kysely`,
  `@tsbouncer/drizzle`, and `@tsbouncer/prisma` do store, `@tsbouncer/defaults`
  chooses. `@tsbouncer/testkit` checks both with `storeConformance` and the new
  `cacheConformance`. `withCache` memoizes `can`/`check` with resource-scoped
  invalidation. The root entry pulls no storage and no `node:*` imports.
- A duplicate write names the rule it broke: one edge holds one param-set per
  condition, so a re-binding is rejected on `insert` (replace it with `upsert`).
  The message is asserted by every adapter's suite, and by conformance for the
  behavior.
- `tupleKey` is JSON-encoded rather than `'|'`-joined: ids may legally contain
  the separator, which used to collapse two distinct edges into one key.
- The set-grant scan behind `listResources` walks store cursors where offered
  (`pagination: true`) instead of assuming one round trip fits the table; a
  600-team test proves the paged answer equals the unpaged one. Evaluator reads
  stay unpaged by design, and result lists stay materialized — streaming is v1.1.
- The examples are now two applications — `hono-rbac` (Hono and a JSON file) and
  `express-drizzle` (Express, Drizzle ORM and SQLite) — replacing seven small
  programs. The interesting failures in authorization are the order of a route's
  checks, where request context comes from, and what a transaction does when a
  document moves, and a fragment cannot show any of them. The documentation's
  `guides` section links to their files one by one, and a test fails if one of
  those links stops resolving.

### Fixed

- `expand` ignored conditions while `check` and `listSubjects` honoured them, so
  a userset gated by a never-true predicate still expanded to its members.
- `check()` and `explain()` dropped the budget-exhaustion flag the evaluator
  computes, making a ceiling-hit indistinguishable from a genuine denial.
- `listResources` lost inherited access in a self-referential chain. The walk
  memoised the `through` relations it had already followed on `type:relation`, so two
  objects of the same type shared a token and the second was never walked — every
  document below the second folder of a `folder → folder → folder` tree was
  invisible to the list while `check` allowed it. The common case of inherited
  access, and a list that quietly disagreed with a check.

## [1.0.0-dev.0]

The first development preview. Pre-1.0, so the API is not settled.

### Added

- `expand`, `listResources`, and `listSubjects` — the three reads that answer a
  question about a whole graph rather than one edge.
- `memoryStore`, `jsonStore`, and `kyselyStore` / `drizzleStore` / `prismaStore`
  over one shared table contract.
- Permission and reference string types derived from `typeof model`, so call sites
  are checked against the model the application actually built.

### Changed

- **`KeymanStore` is now `TupleStore`** (and `TupleStoreCapabilities`). The project
  was renamed before the first release; the exported type names were not.
- `can()` accepts `CheckOptions`, so a condition can be asked about in the boolean
  form. It previously took three strings, and a fourth argument was silently
  ignored — producing a denial that looked like a policy decision.

### Fixed

- `listSubjects` treated a *declared* wildcard edge as "every subject of this type"
  while `can` required a stored `user:*` tuple. With the ordinary ban-list model an
  empty `banned` relation made the access list report *nobody* while every decision
  said allowed.
- `listResources` and `listSubjects` declared a `context` and accepted one, but the
  client never forwarded it, so a conditionally granted resource was allowed by
  `check` and silently missing from the list.
- `formatExplain` printed an empty reason twice on nearly every line of a denial.
