import { contract, goldenChecks } from '../src/index.js';
import { arrayStore, conditionStrippingStore, overMatchingStore } from './helpers.js';

/**
 * The store contract, as sentences.
 *
 * `storeConformance` is the exhaustive suite and stays that way. This is the
 * short list: the guarantees a store makes to whoever reads its output, plus the
 * two ways a store can be wrong in a way its own suite would not catch.
 */
export const goldenContract = contract<void, void>(
  'store guarantees',
  'A store moves tuples and decides nothing. Every adapter must answer identically.',
  [
    {
      id: 'filtered-read',
      given: 'a store holding the shared dataset',
      when: 'the engine reads it',
      expect: 'a correct store reproduces the recorded answers exactly',
      run: async () => {
        const { assertGolden, runGolden: run } = await import('../src/index.js');
        const { GOLDEN_EXPECTED } = await import('../src/index.js');
        const outcome = await run(arrayStore());
        try {
          assertGolden(outcome);
        } catch (error) {
          throw new Error(
            `answers diverged from the reference: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        void GOLDEN_EXPECTED;
      },
      verify: () => {},
    },
    {
      id: 'an-over-matching-store-is-rejected',
      given: 'a store whose filter returns every row',
      when: 'the same dataset is read through it',
      expect: 'it must not reproduce the reference answers',
      run: async () => {
        const { GOLDEN_EXPECTED, runGolden: run } = await import('../src/index.js');
        const outcome = await run(overMatchingStore());
        const same =
          JSON.stringify(outcome.checks) === JSON.stringify(GOLDEN_EXPECTED.checks);
        if (same)
          throw new Error(
            'an over-matching store was indistinguishable from a correct one',
          );
      },
      verify: () => {},
    },
    {
      id: 'a-condition-stripping-store-is-rejected',
      given: 'a store that discards condition bindings on write',
      when: 'the same dataset is read through it',
      expect: 'it must not reproduce the reference answers — this one fails open',
      run: async () => {
        const { GOLDEN_EXPECTED, runGolden: run } = await import('../src/index.js');
        const outcome = await run(conditionStrippingStore());
        const same =
          JSON.stringify(outcome.checks) === JSON.stringify(GOLDEN_EXPECTED.checks);
        if (same)
          throw new Error(
            'a condition-stripping store was indistinguishable from a correct one',
          );
      },
      verify: () => {},
    },
    {
      id: 'the-dataset-covers-every-shape',
      given: 'the golden dataset itself',
      when: 'it is inspected',
      expect:
        'it exercises every edge kind, or equivalence is proven for the easy cases only',
      run: async () => {
        if (goldenChecks.length < 12) {
          throw new Error(
            `only ${goldenChecks.length} cases — equivalence is under-tested`,
          );
        }
      },
      verify: () => {},
    },
  ],
);
