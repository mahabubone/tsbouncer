import { describe, expect, it } from 'vitest';
import { assertGolden, GOLDEN_EXPECTED, goldenChecks, runGolden } from '../src/index.js';
import { arrayStore, conditionStrippingStore, overMatchingStore } from './helpers.js';

/**
 * Tests for the gate itself.
 *
 * `storeConformance` and the golden dataset are the only things standing between
 * a broken store and a silently-wrong authorization answer, and until now neither
 * had been executed by a test. A suite that cannot fail is not a gate.
 *
 * Most of what follows is therefore *negative*: build a store that misbehaves in
 * one specific way and prove the suite rejects it. A suite that only ever sees
 * honest stores has not been shown to work.
 */
describe('golden dataset', () => {
  it('reproduces the recorded answers on a correct store', async () => {
    // Doubles as a drift guard: if a case is edited and GOLDEN_EXPECTED is not
    // regenerated, this is what notices.
    const outcome = await runGolden(arrayStore());
    expect(outcome.checks).toEqual(GOLDEN_EXPECTED.checks);
    expect(outcome.listResources).toEqual(GOLDEN_EXPECTED.listResources);
    expect(outcome.listSubjects).toEqual(GOLDEN_EXPECTED.listSubjects);
  });

  it('yields one answer per case, in order', async () => {
    const outcome = await runGolden(arrayStore());
    expect(outcome.checks).toHaveLength(goldenChecks.length);
  });

  it('rejects a store whose filter returns every row', async () => {
    // The over-matching store ignores the query, so each check resolves as if
    // every grant were on every object. It looks like a store and passes a naive
    // smoke test; it just answers a different question than the one asked. This
    // is the failure the "no optional check? fast path" decision exists to
    // prevent, so it is the one that must not slip through.
    const outcome = await runGolden(overMatchingStore());
    expect(outcome.checks).not.toEqual(GOLDEN_EXPECTED.checks);
    expect(() => assertGolden(outcome)).toThrow();
  });

  it('rejects a store that drops condition bindings', async () => {
    // Dropping `condition` turns a conditional grant into an unconditional one —
    // fail-*open*, and exactly what a per-adapter reimplementation produces. The
    // dataset contains a condition, so this must be caught.
    const outcome = await runGolden(conditionStrippingStore());
    expect(() => assertGolden(outcome)).toThrow();
  });

  it('assertGolden throws for a divergence in any one section', async () => {
    // A suite that only compares the boolean vector would miss a wrong list.
    const good = await runGolden(arrayStore());
    for (const section of ['listResources', 'listSubjects'] as const) {
      const broken = { ...good, [section]: { mutated: ['nope'] } };
      expect(() => assertGolden(broken)).toThrow();
    }
  });
});
