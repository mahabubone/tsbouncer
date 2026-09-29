# docs

The documentation site. Astro 7 + Tailwind 4, static output, no server.

```bash
pnpm docs:dev      # http://localhost:4321
pnpm docs:build    # -> docs/dist
pnpm docs:test     # type-checks every snippet on every page
```

## It requires Node 22, the library does not

Astro 7 needs `>=22.12`. The library publishes `engines: >=20.11`, and the docs
toolchain must not drag that floor up — so this package is excluded from the
library's turbo tasks (`--filter=!tsbouncer-docs`) and CI builds it in a separate
job on a separate runtime.

## Snippets are checked

`test/snippets.test.ts` extracts every TypeScript block from every page and
type-checks it against the **built** package. A snippet using an API that does not
exist, or one that stopped compiling, fails the build.

Blocks are classified automatically — statement, fragment, declaration — and a
block that fits none of them is a **failure**, not a skip. Skips are explicit:
`ts-skip` on a documentation signature, `ts-fragment` or `ts-decl` to override the
classifier. Silently ignoring an unrecognised block is how the checked count
becomes fiction.

A page may declare one ` ```ts setup ` block, prepended to every other block on
that page, so `authz` and `model` exist without each snippet re-declaring them.

## Adding a page

1. Create `src/content/docs/<path>.mdx` with frontmatter: `title`, `description`,
   `section`, `order`, `kind`.
2. If the page needs context for its snippets, add one ` ```ts setup ` block.
3. Run `pnpm docs:test`. It will tell you what it could not classify.

Navigation is explicit (`order`, `section`), not alphabetical, so renaming a file
does not reorder the sidebar.

## The site is not the source of truth

`PLAN.md` is the design record, `AGENTS.md` has the working rules, and the
`examples/` directory holds runnable programs. This site explains how to use the
library; it does not decide what the library is.
