// biome-ignore-all lint/performance/noDynamicNamespaceImportAccess: enumerating the export surface by name is the point
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

/**
 * The batteries-included package is the one import most people will make, so its
 * surface is asserted here rather than left to `export *`.
 */
describe('tsbouncer', () => {
  it('re-exports the kernel', () => {
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

  it('re-exports the dependency-free stores', () => {
    expect(api.memoryStore).toBeTypeOf('function');
    expect(api.jsonStore).toBeTypeOf('function');
    expect(api.FORMAT_VERSION).toBe(1);
  });

  it('does not pull in an ORM', () => {
    // The whole point of splitting the packages: an app that already has Prisma
    // should not end up with Kysely and Drizzle in its dependency graph because
    // it read a README.
    const source = api.memoryStore.toString();
    expect(source).not.toMatch(/kysely|drizzle|prisma/i);
  });

  it('runs a decision end to end through one import', async () => {
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

    const authz = api.createAuthz({ model, store: api.memoryStore() });
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

describe('createDefaultAuthz', () => {
  const model = api.defineModel({
    types: {
      user: api.defineType({}),
      doc: api.defineType({ relations: { owner: api.relation(['user']) } }),
    },
  });

  it('uses an in-memory store when no file is given', async () => {
    const authz = api.createDefaultAuthz({ model });
    expect(api.isPersistent(authz.store)).toBe(false);
    await authz.grant({ subject: 'user:a', relation: 'owner', resource: 'doc:1' });
    expect(await authz.can('user:a', 'doc.owner', 'doc:1')).toBe(true);
  });

  it('uses a JSON file when one is given', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(
      mkdtempSync(join(tmpdir(), 'tsbouncer-default-')),
      'tsbouncer.json',
    );

    const authz = api.createDefaultAuthz({ model, file });
    expect(api.isPersistent(authz.store)).toBe(true);
    await authz.grant({ subject: 'user:a', relation: 'owner', resource: 'doc:1' });

    // A fresh client over the same file sees it.
    const reopened = api.createDefaultAuthz({ model, file });
    expect(await reopened.can('user:a', 'doc.owner', 'doc:1')).toBe(true);
  });

  it('passes limits through', async () => {
    const authz = api.createDefaultAuthz({ model, limits: { maxNodes: 1 } });
    const result = await authz.explain({
      subject: 'user:a',
      permission: 'doc.owner',
      resource: 'doc:1',
    });
    expect(result.allowed).toBe(false);
  });
});
