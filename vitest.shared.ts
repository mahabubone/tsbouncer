/**
 * Shared coverage settings. Every package that ships code must pass these
 * thresholds; a package with no tests cannot claim a green coverage run.
 *
 * The return type is deliberately inferred rather than annotated. Each caller
 * passes the result straight into `defineConfig`, so vitest's own config type
 * is what validates these options — annotating them here would only restate
 * what the call site already checks.
 *
 * `src/index.ts` is excluded because a pure re-export barrel compiles to no
 * statements of its own, and v8 attributes nothing to it — leaving it in only
 * produces a permanent, meaningless 0%. The guarantee that matters is covered
 * instead by `test/public-api.test.ts` in every package, which imports the
 * barrel and asserts the export surface. A dropped or broken export fails
 * there, not here.
 *
 * `src/shape.ts` is excluded because it is types-only: it compiles to an empty
 * module, so it reports 0/0 and renders as a misleading 0% in the table. The
 * types it exports are still checked — by `tsc`, not by coverage.
 */
export const COVERAGE_THRESHOLDS = {
  lines: 90,
  functions: 90,
  branches: 90,
  statements: 90,
} as const;

export function sharedCoverage() {
  return {
    provider: 'v8' as const,
    all: true,
    reporter: ['text', 'html', 'lcov'],
    reportsDirectory: './coverage',
    include: ['src/**/*.ts'],
    exclude: ['src/index.ts', 'src/shape.ts', '**/*.d.ts'],
    thresholds: { ...COVERAGE_THRESHOLDS },
  };
}
