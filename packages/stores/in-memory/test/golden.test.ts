import { assertGolden, runGolden } from '@tsbouncer/testkit';
import { expect, it } from 'vitest';
import { memoryStore } from '../src/index.js';

/**
 * `memoryStore` is the reference implementation for the golden dataset: it has
 * no query builder, so nothing at the SQL layer can be wrong. Every other store
 * asserts the same answers, which is what makes them interchangeable.
 */
it('answers the shared dataset as the reference', async () => {
  assertGolden(await runGolden(memoryStore()));
});

it('agrees with itself across two instances', async () => {
  expect(await runGolden(memoryStore())).toEqual(await runGolden(memoryStore()));
});
