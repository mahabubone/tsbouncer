<"Describe the change and why — link the issue it closes.">

## Scope

- [ ] One logical change; refactors without behavior change are separate PRs.

## Verification

- [ ] `pnpm check` is green (lint, versions, typecheck, build, pack check, coverage, examples).
- [ ] New behavior has tests; reference-parsing changes have a type test and a runtime test.
- [ ] No new dependency in `@tsbouncer/tsbouncer` (the kernel ships zero dependencies).

## Docs

- [ ] Public API change updates `PLAN.md` and the README in the same PR.
- [ ] Docs snippets type-check (`pnpm docs:test`) if any `.mdx` changed.

## Event bookkeeping (October only)

- [ ] Closes an issue labeled `hacktoberfest` (or `good first issue`).
- [ ] Maintainers apply `hacktoberfest-accepted` on merge — contributors, do not self-label.
