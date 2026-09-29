/**
 * Shared coverage settings. Every package that ships code must pass these
 * thresholds; a package with no tests cannot claim a green coverage run.
 *
 * The return type is deliberately inferred rather than annotated. Each caller
 * passes the result straight into `defineConfig`, so vitest's own config type
 * is what validates these options — annotating them here would only restate
 * what the call site already checks.
 *
 * A file is excluded from coverage only when it genuinely cannot be measured,
 * and never merely because it is named `index.ts`. The two situations that
 * qualify:
 *
 * - A **pure re-export barrel** — every statement is an `export … from` —
 *   compiles to no statements of its own, so v8 has nothing to attribute and
 *   the file renders as a meaningless 0%. `src/index.ts` is *not* one of these
 *   by default: `stores/json` keeps the entire JSON store in it, and `testkit`
 *   keeps `storeConformance()`, so excluding it by name put the serializer and
 *   the conformance oracle outside the gate while reporting 100%. A barrel is
 *   therefore excluded only when the package opts in through `barrels`, and the
 *   export surface is checked separately by `test/public-api.test.ts` in every
 *   package — a dropped or broken export fails there, not here.
 *
 * - `src/shape.ts` is types-only: it compiles to an empty module, so it reports
 *   0/0 and renders as a misleading 0% in the table. The types it exports are
 *   still checked — by `tsc`, not by coverage.
 *
 * Forgetting to declare a barrel is safe in the direction that matters: the
 * gate fails loudly on a 0% the package cannot raise, rather than silently
 * skipping code it was supposed to measure.
 *
 * The return type is deliberately inferred rather than annotated. Each caller
 * passes the result straight into `defineConfig`, so vitest's own config type
 * is what validates these options — annotating them here would only restate
 * what the call site already checks.
 */
export const COVERAGE_THRESHOLDS = {
  lines: 90,
  functions: 90,
  branches: 90,
  statements: 90,
} as const;

export interface SharedCoverageOptions {
  /**
   * Package-relative paths of files that are pure re-export barrels, excluded
   * from the coverage report. Anything not listed here is measured.
   */
  readonly barrels?: readonly string[];
}

export function sharedCoverage(options: SharedCoverageOptions = {}) {
  return {
    provider: 'v8' as const,
    all: true,
    reporter: ['text', 'html', 'lcov'],
    reportsDirectory: './coverage',
    include: ['src/**/*.ts'],
    exclude: [...(options.barrels ?? []), 'src/shape.ts', '**/*.d.ts'],
    thresholds: { ...COVERAGE_THRESHOLDS },
  };
}
