/**
 * `tsbouncer` — the kernel and the ports. Model, evaluator, queries, the
 * `TupleStore` contract, the `Cache` contract, and the `withCache` memo layer.
 *
 * This entry pulls no backends and no `node:*` imports, so importing it never
 * loads anything an app did not ask for. Backends are separate plugin
 * packages, one per port they implement:
 *
 * ```ts
 * import { createAuthz, defineModel, withCache } from 'tsbouncer';
 * import { memoryStore, memoryCache } from '@tsbouncer/in-memory';
 * import { jsonStore } from '@tsbouncer/json-file';
 * import { kyselyStore } from '@tsbouncer/kysely';
 * ```
 *
 * `@tsbouncer/testkit` holds the conformance suites both ports are checked
 * against. Nothing here depends on any of them.
 */
export * from './kernel/index.js';
