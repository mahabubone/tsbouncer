/**
 * `tsbouncer` — the batteries-included entry point.
 *
 * Re-exports the kernel plus the two stores that need no external dependency, so
 * the common case is one import and no database:
 *
 * ```ts
 * import { createAuthz, defineModel, jsonStore } from 'tsbouncer';
 * ```
 *
 * If your app already has Kysely, Drizzle, or Prisma, import `@tsbouncer/core`
 * and the matching store instead — this package deliberately does not depend on
 * any of them, and neither should your install graph because you read a README.
 */
export * from '@tsbouncer/core';
export type { Document, JsonStore, JsonStoreOptions } from '@tsbouncer/json';
export { FORMAT_VERSION, jsonStore } from '@tsbouncer/json';
export type { MemoryStore, MemoryStoreOptions } from '@tsbouncer/memory';
export { memoryStore } from '@tsbouncer/memory';
export type { CreateDefaultAuthzOptions } from './default.js';
export { createDefaultAuthz, isPersistent } from './default.js';
