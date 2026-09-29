/**
 * A contract is a declaration of what something must do, separate from the code
 * that does it.
 *
 * The reason this exists: a test suite says "this input produced this output", and
 * a reader has to read the body to learn what rule was being checked. A contract
 * states the rule in words, runs the implementation against it, and produces a
 * report that can be read by someone who will never open the implementation. For a
 * pre-1.0 library whose whole pitch is "these are the guarantees", that artifact
 * is the pitch, checked.
 *
 * It is deliberately not a test framework. It has no discovery, no fixtures, no
 * mocking, and no lifecycle. It is a shape for expectations plus a runner and a
 * formatter, so a guarantee can be written once and reported on.
 */

/** One declared guarantee. */
export interface Clause<I, O> {
  /** Stable identifier. Used for the report, so keep it greppable. */
  readonly id: string;
  /** The setup, in words. A reader should not need the code to follow this. */
  readonly given: string;
  /** What is done. */
  readonly when: string;
  /** The rule being claimed, in words. This is the sentence under test. */
  readonly expect: string;
  /** Execute the clause. Anything thrown is a failure, never a pass. */
  readonly run: (input: I) => Promise<O> | O;
  /**
   * Compare the result. Throw to fail with a message; return to pass. The return
   * type is `unknown` rather than `boolean | void` because a clause that returns
   * nothing is the common case and `void` inside a union reads as a mistake.
   */
  readonly verify: (actual: O) => unknown;
}

export interface Contract<I, O> {
  readonly name: string;
  /** One line, for the report header. */
  readonly claim: string;
  readonly clauses: readonly Clause<I, O>[];
}

export function contract<I, O>(
  name: string,
  claim: string,
  clauses: readonly Clause<I, O>[],
): Contract<I, O> {
  if (clauses.length === 0) throw new Error(`contract ${name} declares no clauses`);
  const seen = new Set<string>();
  for (const clause of clauses) {
    if (seen.has(clause.id))
      throw new Error(`contract ${name} repeats clause id ${clause.id}`);
    seen.add(clause.id);
  }
  return { name, claim, clauses };
}

export interface ClauseResult {
  readonly id: string;
  readonly given: string;
  readonly when: string;
  readonly expect: string;
  readonly ok: boolean;
  /** Why it failed. `undefined` when it passed. */
  readonly detail?: string;
}

export interface Report {
  readonly name: string;
  readonly claim: string;
  readonly results: readonly ClauseResult[];
  readonly passed: number;
  readonly failed: number;
}

/**
 * Run every clause. A clause that throws fails — an exception is never a pass,
 * because a contract that treats a crash as success reports green on a broken
 * implementation.
 */
export async function runContract<I, O>(c: Contract<I, O>, input: I): Promise<Report> {
  const results: ClauseResult[] = [];

  for (const clause of c.clauses) {
    try {
      const actual = await clause.run(input);
      clause.verify(actual);
      results.push({
        id: clause.id,
        given: clause.given,
        when: clause.when,
        expect: clause.expect,
        ok: true,
      });
    } catch (error) {
      results.push({
        id: clause.id,
        given: clause.given,
        when: clause.when,
        expect: clause.expect,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    name: c.name,
    claim: c.claim,
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

/**
 * The QA mark. A pass is a check, a failure is a cross, and the expected rule is
 * printed above the outcome so a report is readable without the implementation.
 */
export function formatReport(report: Report): string {
  const lines: string[] = [];
  lines.push(`${report.name} — ${report.claim}`);
  lines.push('');

  for (const result of report.results) {
    lines.push(`${result.ok ? '  ✓' : '  ✗'} ${result.id}`);
    lines.push(`      given  ${result.given}`);
    lines.push(`      when   ${result.when}`);
    lines.push(`      expect ${result.expect}`);
    if (result.detail !== undefined) lines.push(`      !      ${result.detail}`);
  }

  lines.push('');
  lines.push(
    `  ${report.passed} passed, ${report.failed} failed, ${report.results.length} total`,
  );
  return lines.join('\n');
}

/** Merge reports, so a run can be summarised across several contracts. */
export function summarise(reports: readonly Report[]): string {
  const passed = reports.reduce((n, r) => n + r.passed, 0);
  const failed = reports.reduce((n, r) => n + r.failed, 0);
  return [
    'contract summary',
    ...reports.map(
      (r) => `  ${r.failed === 0 ? '✓' : '✗'} ${r.name}  ${r.passed}/${r.results.length}`,
    ),
    `  ${passed} passed, ${failed} failed, ${passed + failed} total`,
  ].join('\n');
}
