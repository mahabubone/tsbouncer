// biome-ignore-all lint/performance/noDynamicNamespaceImportAccess: enumerating the export surface by name is the point
import { describe, expect, it } from 'vitest';
import * as defaults from '../src/defaults.js';
import * as api from '../src/index.js';
import * as json from '../src/json/index.js';
import * as memory from '../src/memory/index.js';

/**
 * The root entry is the kernel and nothing else. Anything storage-shaped lives
 * behind a subpath, so importing the root never loads a backend — and in
 * particular never loads `node:fs` through the JSON store.
 */
describe('tsbouncer', () => {
  it('exports the kernel from the root', () => {
    for (const name of [
      'createAuthz',
      'defineModel',
      'defineType',
      'defineCondition',
      'relation',
      'wildcard',
      'ttu',
      'permission',
      'parseRef',
      'formatExplain',
      'AuthorizationError',
      'AccessDeniedError',
    ] as const) {
      expect(api[name], name).toBeDefined();
    }
  });

  it('keeps storage out of the root', () => {
    for (const name of [
      'memoryStore',
      'jsonStore',
      'createDefaultAuthz',
      'isPersistent',
      'FORMAT_VERSION',
    ] as const) {
      expect(api[name as keyof typeof api], name).toBeUndefined();
    }
  });

  it('exposes the memory store behind its subpath', () => {
    expect(memory.memoryStore).toBeTypeOf('function');
  });

  it('exposes the JSON store behind its subpath', () => {
    expect(json.jsonStore).toBeTypeOf('function');
    expect(json.FORMAT_VERSION).toBe(1);
  });

  it('exposes the store-choosing client behind its subpath', () => {
    expect(defaults.createDefaultAuthz).toBeTypeOf('function');
    expect(defaults.isPersistent).toBeTypeOf('function');
  });

  it('does not pull in an ORM', () => {
    // The whole point of splitting the packages: an app that already has Prisma
    // should not end up with Kysely and Drizzle in its dependency graph because
    // it read a README.
    const source = memory.memoryStore.toString();
    expect(source).not.toMatch(/kysely|drizzle|prisma/i);
  });

  it('runs a decision end to end across entries', async () => {
    const model = api.defineModel({
      types: {
        user: api.defineType({}),
        team: api.defineType({ relations: { member: api.relation(['user']) } }),
        document: api.defineType({
          relations: {
            owner: api.relation(['user']),
            editor: api.relation('user').or(api.relation('team', { through: 'member' })),
          },
          permissions: { read: api.permission.or('owner', 'editor') },
        }),
      },
    });

    const authz = api.createAuthz({ model, store: memory.memoryStore() });
    await authz.grant({
      subject: 'user:alice',
      relation: 'owner',
      resource: 'document:1',
    });
    await authz.grant({
      subject: 'team:eng#member',
      relation: 'editor',
      resource: 'document:2',
    });
    await authz.grant({
      subject: 'user:alice',
      relation: 'member',
      resource: 'team:eng',
    });

    expect(await authz.can('user:alice', 'document.read', 'document:1')).toBe(true);
    expect(await authz.can('user:alice', 'document.read', 'document:2')).toBe(true);
    expect(await authz.can('user:bob', 'document.read', 'document:2')).toBe(false);
  });
});
