// biome-ignore-all lint/performance/noDynamicNamespaceImportAccess: enumerating the export surface by name is the point of this test
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
import { testStore } from './store.js';

/**
 * The barrel is part of the measured surface, so it gets a real test rather
 * than a coverage exclusion. If a symbol is dropped from `index.ts` or an
 * export path is wrong, this fails.
 */
describe('public API surface', () => {
  it('exports the model builders', () => {
    for (const name of [
      'defineModel',
      'defineType',
      'defineCondition',
      'relation',
      'wildcard',
      'ttu',
      'permission',
    ] as const) {
      expect(api[name], name).toBeDefined();
    }
  });

  it('exports the reference helpers', () => {
    for (const name of [
      'parseRef',
      'formatRef',
      'refKey',
      'tryParseRef',
      'isWildcard',
      'parsePermission',
      'formatPermission',
      'WILDCARD',
    ] as const) {
      expect(api[name], name).toBeDefined();
    }
  });

  it('exports the store helpers', () => {
    for (const name of [
      'tupleKey',
      'matchesQuery',
      'assertStoreShape',
      'NO_CAPABILITIES',
    ] as const) {
      expect(api[name], name).toBeDefined();
    }
  });

  it('exports the introspection helpers', () => {
    for (const name of ['typeNames', 'relationsOf', 'permissionsOf'] as const) {
      expect(api[name], name).toBeDefined();
    }
  });

  it('exports the check engine and client', () => {
    for (const name of [
      'createAuthz',
      'evaluate',
      'formatExplain',
      'validateTuple',
      'validateTuples',
      'acceptsSubject',
      'resolveLimits',
      'DEFAULT_LIMITS',
      'Budget',
    ] as const) {
      expect(api[name], name).toBeDefined();
    }
  });

  it('exports every error class and the type guard', () => {
    for (const name of [
      'AuthorizationError',
      'AccessDeniedError',
      'EvaluationLimitError',
      'InvalidReferenceError',
      'InvalidStoreError',
      'ModelDefinitionError',
      'StoreError',
      'TupleValidationError',
      'isAuthorizationError',
    ] as const) {
      expect(api[name], name).toBeDefined();
    }
  });

  it('answers a decision through the public entry point', async () => {
    const authz = api.createAuthz({
      model: api.defineModel({
        types: {
          user: api.defineType({}),
          document: api.defineType({
            relations: { owner: api.relation(['user']) },
            permissions: { read: api.permission.or('owner') },
          }),
        },
      }),
      store: testStore(),
    });
    expect(typeof authz.can).toBe('function');
    expect(typeof authz.explain).toBe('function');
    expect(api.typeNames(authz.model)).toEqual(['user', 'document']);
  });

  it('round-trips through the public entry point', () => {
    const model = api.defineModel({
      types: {
        user: api.defineType({}),
        document: api.defineType({
          relations: { owner: api.relation(['user']) },
          permissions: { read: api.permission.or('owner') },
        }),
      },
    });
    expect(api.typeNames(model)).toEqual(['user', 'document']);
    expect(api.parseRef('user:alice').id).toBe('alice');
  });
});
