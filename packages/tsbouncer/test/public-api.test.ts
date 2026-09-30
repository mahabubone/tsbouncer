// biome-ignore-all lint/performance/noDynamicNamespaceImportAccess: enumerating the export surface by name is the point
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
import { testStore } from './kernel/store.js';

/**
 * The root entry is the kernel, the ports, and nothing else. Anything shaped
 * like a backend lives in an adapter package, so importing the root never
 * loads storage, `node:fs`, or an ORM client.
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

  it('exports the ports from the root', () => {
    for (const name of [
      'withCache',
      'canonicalJson',
      'assertCacheSet',
      'CacheError',
    ] as const) {
      expect(api[name], name).toBeDefined();
    }
  });

  it('keeps backends out of the root', () => {
    for (const name of [
      'memoryStore',
      'memoryCache',
      'jsonStore',
      'redisStore',
      'redisCache',
      'kyselyStore',
      'createDefaultAuthz',
      'isPersistent',
      'FORMAT_VERSION',
    ] as const) {
      expect(api[name as keyof typeof api], name).toBeUndefined();
    }
  });

  it('runs a decision end to end through the public entry point', async () => {
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

    const authz = api.createAuthz({ model, store: testStore() });
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
