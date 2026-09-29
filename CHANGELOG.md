# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every published package carries the same version, and `pnpm versions` fails the
build if they drift. Releases are cut by hand; see [CONTRIBUTING.md](./CONTRIBUTING.md).

## [Unreleased]

Nothing published yet.

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
