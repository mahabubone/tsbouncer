import { describe, expect, it } from 'vitest';
import { contract, formatReport, runContract, summarise } from '../src/index.js';

/**
 * The runner's failure paths.
 *
 * `contract.test.ts` proves the happy path — every guarantee holds, the report
 * is written. The other half of a runner is what it does when a guarantee does
 * *not* hold, and that half was never executed: a clause that throws, a
 * contract that declares nothing, a formatter printing a cross. A reporter that
 * has never been seen to fail is indistinguishable from one that cannot.
 */

const passing = contract<void, number>('passing', 'a claim that holds', [
  {
    id: 'ok',
    given: 'a clause',
    when: 'run',
    expect: 'the value is 1',
    run: () => 1,
    verify: () => undefined,
  },
]);

const failing = contract<void, number>('failing', 'a claim that does not hold', [
  {
    id: 'bad',
    given: 'a clause',
    when: 'run',
    expect: 'the value is 2',
    run: () => 1,
    verify: (actual) => {
      if (actual !== 2) throw new Error(`expected 2, got ${actual}`);
    },
  },
]);

describe('declaring a contract', () => {
  it('refuses a contract with no clauses', () => {
    // An empty contract reports 0 failed on a promise nobody made.
    expect(() => contract('empty', 'nothing', [])).toThrow(/declares no clauses/);
  });

  it('refuses a repeated clause id', () => {
    // Ids are what the report keys on, so two clauses sharing one is a report
    // that cannot distinguish them.
    expect(() =>
      contract('dupes', 'a claim', [
        {
          id: 'same',
          given: 'a',
          when: 'a',
          expect: 'a',
          run: () => 0,
          verify: () => undefined,
        },
        {
          id: 'same',
          given: 'b',
          when: 'b',
          expect: 'b',
          run: () => 0,
          verify: () => undefined,
        },
      ]),
    ).toThrow(/repeats clause id/);
  });
});

describe('running a contract', () => {
  it('records a clause whose verifier threw, without failing the run', async () => {
    const report = await runContract(failing, undefined);
    expect(report.failed).toBe(1);
    expect(report.passed).toBe(0);
    expect(report.results[0]).toMatchObject({ id: 'bad', ok: false });
    expect(report.results[0]?.detail).toBe('expected 2, got 1');
  });

  it('records a thrown value that is not an Error', async () => {
    const report = await runContract(
      contract('strings', 'throwing a string', [
        {
          id: 'raw',
          given: 'a clause',
          when: 'run',
          expect: 'not to throw',
          run: () => {
            throw 'boom';
          },
          verify: () => undefined,
        },
      ]),
      undefined,
    );
    expect(report.results[0]?.detail).toBe('boom');
  });

  it('keeps a passing clause beside the failing one', async () => {
    const report = await runContract(
      contract('mixed', 'one holds, one does not', [
        {
          id: 'holds',
          given: 'a',
          when: 'a',
          expect: 'a',
          run: () => 1,
          verify: () => undefined,
        },
        ...failing.clauses,
      ]),
      undefined,
    );
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
  });
});

describe('reporting a failure', () => {
  it('prints a cross with the reason beside it', async () => {
    const text = formatReport(await runContract(failing, undefined));
    expect(text).toContain('✗ bad');
    expect(text).toContain('!      expected 2, got 1');
    expect(text).toContain('0 passed, 1 failed, 1 total');
  });

  it('marks a failing contract in the summary', async () => {
    const failed = await runContract(failing, undefined);
    const passed = await runContract(passing, undefined);
    const text = summarise([passed, failed]);
    expect(text).toContain('✓ passing');
    expect(text).toContain('✗ failing');
    expect(text).toContain('1 passed, 1 failed, 2 total');
  });
});
