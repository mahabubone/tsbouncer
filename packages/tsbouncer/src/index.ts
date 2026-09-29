/**
 * `tsbouncer` — the kernel. Model, evaluator, queries, and the store contract.
 *
 * This entry is deliberately lean: it pulls no storage and no `node:*` imports,
 * so importing it never loads a backend you did not ask for. Reach further only
 * on purpose:
 *
 * ```ts
 * import { createAuthz, defineModel } from 'tsbouncer';
 * import { memoryStore } from 'tsbouncer/memory';
 * import { jsonStore } from 'tsbouncer/json';
 * import { createDefaultAuthz } from 'tsbouncer/defaults';
 * ```
 *
 * SQL adapters stay separate plugin packages (`@tsbouncer/kysely`,
 * `@tsbouncer/drizzle`, `@tsbouncer/prisma`), and `@tsbouncer/testkit` holds
 * the conformance suite. Nothing here depends on any of them.
 */
export * from './kernel/index.js';
