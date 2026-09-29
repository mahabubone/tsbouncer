import { storeConformance } from '../src/index.js';
import { arrayStore } from './helpers.js';

/**
 * The suite, executed by the package that ships it.
 *
 * `storeConformance` is what every adapter is graded by, and it is the one file
 * in `testkit` that its own `vitest run` never touched: the suite is registered
 * by the stores, so `testkit`'s coverage reported 3% for the 361 lines that
 * decide whether an adapter is correct. Running it here — against the reference
 * store, whose behaviour is an array and `matchesQuery` — measures the gate
 * itself, and keeps it honest: a suite that cannot pass on a correct store is
 * not a contract, it is a complaint.
 */
storeConformance({ name: 'arrayStore', create: () => arrayStore() });
