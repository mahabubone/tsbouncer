# Contributing

Thanks for your interest. This is a young, pre-1.0 library and the design is still
moving, so expect the API to shift.

## Before you start

Read [PLAN.md](./PLAN.md) for the current design and [AGENTS.md](./AGENTS.md) for the
rules that are not up for debate — ESM-only, no framework adapters, a zero-dependency
`core`, and filtered reads as the only mandatory store primitive.

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

Node `>=20.11`. The repo is ESM-only; don't add CommonJS, `require()`, or
`export =` to anything.

## Writing a store

The conformance suite in `packages/testkit` is the gate. Any new store must pass it
in full — a store that fails is not finished. Copy the memory store as a starting
point, then run the suite against yours.

```ts
import { runConformance } from '@tsbouncer/testkit';
import { runMyStoreSuite } from './conformance.test.ts';
```

Conditions are never evaluated in a store. Stores move tuples; the engine decides.

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

## Reporting bugs

Open an issue with a minimal reproduction. A failing `check()` with a small model is
worth a hundred lines of description.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](./SECURITY.md).

## License

By contributing you agree that your work is licensed under the [MIT License](./LICENSE).
