# Contributing

Thanks for your interest. This is a young, pre-1.0 library and the design is still
moving, so expect the API to shift.

## Before you start

Read [PLAN.md](./PLAN.md) for the current design and [AGENTS.md](./AGENTS.md) for the
rules that are not up for debate — ESM-only, no framework adapters, a zero-dependency
kernel at the `tsbouncer` root, and filtered reads as the only mandatory store primitive.

If your change contradicts one of those, open an issue to change `PLAN.md` first.
Contributing a framework adapter or a `check()` fast path to a store will be declined.

## Setup

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Node `>=22`. The repo is ESM-only; don't add CommonJS, `require()`, or
`export =` to anything.

## Writing a store — or a cache

The conformance suites in `packages/testkit` are the gate. Any new store must
pass `storeConformance` in full, and any new cache must pass
`cacheConformance` — a port that fails is not finished. Copy
`packages/stores/in-memory` as a starting point (it implements both ports),
then run the suites against yours:

```ts
import { cacheConformance, storeConformance } from '@tsbouncer/testkit';
import { myCache } from '../src/index.js';
import { myStore } from '../src/index.js';

storeConformance({
  name: 'myStore',
  create: () => myStore(),
});

cacheConformance({
  name: 'myCache',
  create: () => myCache(),
});
```

Conditions are never evaluated in a store. Stores move tuples; the engine decides.
Cache contents are losable by definition — a miss must always be safe, and
`undefined` is the miss signal, never a storable value.

## Local QA beyond SQLite

CI is SQLite-only by decision — no service containers, no flakes from shared
infrastructure. Everything else runs locally, env-gated so a missing server
skips instead of failing:

```bash
# PostgreSQL 16 for the kysely adapter (conformance + golden).
docker run -d --name tsbouncer-qa-pg -e POSTGRES_PASSWORD=tsbouncer-qa \
  -e POSTGRES_USER=tsbouncer -e POSTGRES_DB=tsbouncer \
  -p 5544:5432 postgres:16-alpine
TSBUNCER_PG_URL=postgresql://tsbouncer:tsbouncer-qa@127.0.0.1:5544/tsbouncer \
  pnpm --filter @tsbouncer/kysely exec vitest run \
    test/conformance-pg.test.ts test/golden-pg.test.ts

# Redis for the redis adapter (conformance + golden). Any Redis 7+ server;
# tests namespace themselves with uuid prefixes and delete only those, so
# never point this at production — and never FLUSHDB.
TSBUNCER_REDIS_URL=redis://127.0.0.1:6379 \
  pnpm --filter @tsbouncer/redis test
```

Then the express tour, still on SQLite, to confirm nothing regressed end to
end: `pnpm --filter @tsbouncer-examples/express-drizzle test`. QA is green when
all three are.

## Pull requests

- One logical change per PR. Refactors that don't change behavior belong on their own.
- If you change a public API, update `PLAN.md` and the README in the same commit.
- Add tests. Anything touching reference parsing wants both a type test and a runtime
  test.
- Keep inline comments out of the code. Explain *why* in `PLAN.md` or `docs/`.
- Conventional Commits, please — the changelog is generated from them.

## Commit messages

```
feat(core): add tuple-to-userset traversal
fix(core): evaluate both sides of exclusion before returning
docs: document store capabilities
```

## Cutting a release

Releases are a maintainer's job, cut by hand — no changesets, no CI pipelines,
no automation yet. That is deliberate, and it stays until the staged state is
marked ready. Contributors do not need this section; maintainers follow it
exactly, in order.

### 0. Prerequisites

- A clean tree. `git status` shows nothing but the release itself.
- A GitHub remote (none is configured yet — `gh repo create` or `git remote
  add`, then push `main` first).
- `npm login` as a maintainer with publish rights on the `tsbouncer` org, with
  2FA available for the OTP prompt. Manual publishes cannot mint provenance
  (that needs CI OIDC); say so in the release notes when it matters.
- For JSR: a `jsr.json` in each published package and a scope you own (see
  step 5). Nothing here is JSR-ready until those exist.

### 1. One version everywhere

`pnpm versions` — root `package.json` is the source of truth. Preview versions
chain as `1.0.0-preview.N`: plain numeric identifiers, so precedence stays
chronological (month names would sort lexically and break it). Bump the number
for every preview, even a small one; two different trees must never share a
published version.

### 2. Full gates, in order

`pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm pack:check`,
`pnpm test:coverage`, `pnpm examples`, `pnpm docs:test`, `pnpm docs:build`.
Nothing ships on a red gate. If a gate fails after the version bump, fix it and
bump again — never publish a tree you have not gated.

### 3. Date the changelog

Move the release out of `CHANGELOG.md`'s Unreleased section, date it, and
describe it in Keep-a-Changelog style (Added / Changed / Fixed). The changelog
is hand-written; commit-message tooling is aspirational.

### 4. Tag and push

```bash
git tag -a v1.0.0-preview.N -m "<one-line summary>"
git push origin main v1.0.0-preview.N
```

The `v` lives on the tag only — never in `package.json`, where it is not valid
semver.

### 5. GitHub release, by hand

```bash
gh release create v1.0.0-preview.N --title "1.0.0-preview.N" \
  --notes-file <(sed -n '/## \[1.0.0-preview.N\]/,/^## \[/p' CHANGELOG.md | head -n -1)
```

Paste the changelog section in; that file is the notes. Mark it as a
pre-release (`--prerelease`) while the major version is 0 or the version
carries a preview tag.

### 6. npm, one package at a time

Publish in dependency order, so nothing resolves a version that is not on the
registry yet: `tsbouncer`, then `@tsbouncer/testkit`, then the store plugins.
Per package, from the repo root:

```bash
pnpm --filter tsbouncer publish --tag preview --access public
```

`access` is already public in every manifest; repeat it anyway so a misconfigured
registry default can never make a release private. Expect an OTP prompt. Verify
after each publish (`npm view <name>@preview version`) before moving to the
next package.

### 7. JSR, one scoped package at a time

Each scoped package carries a `jsr.json` (checked by `pnpm versions` for name
and version drift). The unscoped root `tsbouncer` is npm-only — JSR requires
`@scope/name`, so there is nothing to configure there:

```json
{
  "name": "@tsbouncer/redis",
  "version": "1.0.0-preview.1",
  "exports": "./dist/index.js",
  "license": "Apache-2.0",
  "publish": { "exclude": ["!dist/"] }
}
```

Three gotchas, all learned the hard way — keep them in mind before "simplifying":
- `dist/` is gitignored, so JSR excludes it too. The `publish.exclude`
  negation (`!dist/`, exactly that spelling) un-excludes it.
- Every package needs a `LICENSE` file on disk, not just the license field.
- Our entrypoints are compiled JS, so every publish needs `--allow-slow-types`
  until the packages ship TypeScript sources.

Then, per scoped package:

```bash
npx jsr publish --dry-run --allow-slow-types
npx jsr publish --allow-slow-types
```

Slow publishes only — `--allow-dirty` is how a half-finished tree ends up on a
registry (it appears in dry-run commands above only because local verification
runs on dirty trees).

### 8. Docs

`pnpm docs:build`, then publish `docs/dist` to Pages by hand until the
pipelines exist. Canonicals assume the custom domain; revisit them if Pages
stays subpath-only.

## Reporting bugs

Open an issue with a minimal reproduction. A failing `check()` with a small model is
worth a hundred lines of description.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](./SECURITY.md).

## License

By contributing you agree that your work is licensed under the [Apache License 2.0](./LICENSE).
