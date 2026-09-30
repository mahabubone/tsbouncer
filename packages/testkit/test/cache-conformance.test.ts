import { cacheConformance } from '../src/index.js';
import { objectCache } from './helpers.js';

/**
 * The suite, executed by the package that ships it.
 *
 * Same reasoning as `conformance.test.ts`: `cacheConformance` is what every
 * adapter is graded by, so testkit runs it here against the reference cache —
 * measuring the gate itself keeps it honest.
 */
cacheConformance({ name: 'objectCache', create: () => objectCache() });
