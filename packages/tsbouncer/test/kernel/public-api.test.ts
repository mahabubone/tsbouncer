// biome-ignore-all lint/performance/noDynamicNamespaceImportAccess: enumerating the export surface by name is the point of this test
import { describe, expect, it } from 'vitest';
import type {
  AuthorizationErrorCode,
  AuthorizationErrorOptions,
  Authz,
  Cache,
  CacheCapabilities,
  CachedAuthzOptions,
  CacheOptions,
  CheckOptions,
  CheckRequest,
  Child,
  ComputedNode,
  ConditionContext,
  ConditionDef,
  ConditionDenied,
  ConditionOptions,
  ConditionOutcome,
  ConditionPredicate,
  CreateAuthzOptions,
  Decision,
  DeleteInput,
  DirectNode,
  EvaluationLimits,
  EvaluationOutcome,
  EvaluationRequest,
  ExclusionNode,
  ExpandResult,
  ExplainNode,
  ExplainOp,
  ExplainResult,
  FilterValue,
  GrantInput,
  IntersectionNode,
  LimitKind,
  ListResourcesInput,
  ListResourcesQuery,
  ListSubjectsInput,
  ListSubjectsQuery,
  Model,
  ModelConfig,
  ModelShape,
  ModelShapeOf,
  ObjectRefOf,
  Page,
  ParamType,
  ParsedRef,
  PermissionOf,
  ReadTupleQuery,
  RefPosition,
  ResourceList,
  SetExpression,
  SetNode,
  SubjectRefOf,
  SubjectSet,
  TtuNode,
  Tuple,
  TupleStore,
  TupleStoreCapabilities,
  TypeConfig,
  TypeDefinition,
  TypeNames,
  TypeShape,
  UnionNode,
  UsersetNode,
  WriteInput,
  WriteMode,
} from '../../src/kernel/index.js';
import * as api from '../../src/kernel/index.js';
import { testStore } from './store.js';

/**
 * Every type-only export, named.
 *
 * The assertions elsewhere in this file are runtime lookups, which cannot see a
 * type erased at build time — deleting `PermissionOf` from `index.ts` left every
 * test here green, which is the worst failure mode a public API can have: a
 * silent removal nobody notices until a consumer's build breaks. The type-level
 * derivations were broken exactly this way for the whole life of the project.
 *
 * This map is the guard. A missing or renamed type export is a build failure
 * here rather than a release note. Adding a type means adding a line, and
 * removing one has to be a deliberate edit to this file.
 */
type Shape = {
  types: {
    user: { relations: { member: SetExpression }; permissions: { read: SetNode } };
  };
};

/**
 * Types that need arguments are instantiated with a concrete shape, which is also
 * the only way to prove their constraint is actually satisfiable.
 */
type ExportedTypes = {
  AuthorizationErrorCode: AuthorizationErrorCode;
  AuthorizationErrorOptions: AuthorizationErrorOptions;
  Authz: Authz;
  Cache: Cache;
  CacheCapabilities: CacheCapabilities;
  CachedAuthzOptions: CachedAuthzOptions;
  CacheOptions: CacheOptions;
  CheckOptions: CheckOptions;
  CheckRequest: CheckRequest;
  Child: Child;
  ComputedNode: ComputedNode;
  ConditionContext: ConditionContext;
  ConditionDef: ConditionDef;
  ConditionDenied: ConditionDenied;
  ConditionOptions: ConditionOptions;
  ConditionOutcome: ConditionOutcome;
  ConditionPredicate: ConditionPredicate;
  CreateAuthzOptions: CreateAuthzOptions;
  Decision: Decision;
  DeleteInput: DeleteInput;
  DirectNode: DirectNode;
  EvaluationLimits: EvaluationLimits;
  EvaluationOutcome: EvaluationOutcome;
  EvaluationRequest: EvaluationRequest;
  ExclusionNode: ExclusionNode;
  ExpandResult: ExpandResult;
  ExplainNode: ExplainNode;
  ExplainOp: ExplainOp;
  ExplainResult: ExplainResult;
  FilterValue: FilterValue;
  GrantInput: GrantInput;
  IntersectionNode: IntersectionNode;
  LimitKind: LimitKind;
  ListResourcesInput: ListResourcesInput;
  ListResourcesQuery: ListResourcesQuery;
  ListSubjectsInput: ListSubjectsInput;
  ListSubjectsQuery: ListSubjectsQuery;
  Model: Model;
  ModelConfig: ModelConfig;
  ModelShape: ModelShape;
  ModelShapeOf: ModelShapeOf<Model<Shape>>;
  ObjectRefOf: ObjectRefOf<Shape>;
  Page: Page<Tuple>;
  ParamType: ParamType;
  ParsedRef: ParsedRef;
  PermissionOf: PermissionOf<Shape>;
  ReadTupleQuery: ReadTupleQuery;
  RefPosition: RefPosition;
  ResourceList: ResourceList;
  SetExpression: SetExpression;
  SetNode: SetNode;
  SubjectRefOf: SubjectRefOf<Shape>;
  SubjectSet: SubjectSet;
  TtuNode: TtuNode;
  Tuple: Tuple;
  TupleStore: TupleStore;
  TupleStoreCapabilities: TupleStoreCapabilities;
  TypeConfig: TypeConfig;
  TypeDefinition: TypeDefinition;
  TypeNames: TypeNames<Shape>;
  TypeShape: TypeShape;
  UnionNode: UnionNode;
  UsersetNode: UsersetNode;
  WriteInput: WriteInput;
  WriteMode: WriteMode;
};

/** Never constructed; it exists so the aliases above are resolved. */
const exportedTypes: ExportedTypes | undefined = undefined;
void exportedTypes;

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

  it('exports the cache port and the memo layer', () => {
    for (const name of [
      'withCache',
      'canonicalJson',
      'assertCacheSet',
      'CacheError',
    ] as const) {
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

  it('exports the graph query engine', () => {
    for (const name of [
      'expandSubjects',
      'listResources',
      'listSubjects',
      'set',
      'union',
      'intersection',
      'difference',
      'differenceAll',
      'setOfType',
      'emptySet',
      'concreteRefs',
    ] as const) {
      expect(api[name], name).toBeDefined();
    }
  });

  it('answers the three graph queries through the public entry point', async () => {
    const authz = api.createAuthz({
      model: api.defineModel({
        types: {
          user: api.defineType({}),
          team: api.defineType({ relations: { member: api.relation(['user']) } }),
          document: api.defineType({
            relations: {
              owner: api.relation(['user']),
              viewer: api.relation('user'),
              // A wildcard lives on a *relation*; a permission may only
              // reference one, never contain the edge itself.
              open: api.relation('user').or(api.wildcard('user')),
            },
            permissions: {
              read: api.permission.or('owner', 'viewer'),
              anyone: api.permission.or('owner', 'open'),
            },
          }),
        },
      }),
      store: testStore([
        { subject: 'user:alice', relation: 'owner', resource: 'document:1' },
        { subject: 'team:eng#member', relation: 'viewer', resource: 'document:1' },
        { subject: 'user:alice', relation: 'member', resource: 'team:eng' },
        { subject: 'user:*', relation: 'open', resource: 'document:1' },
      ]),
    });

    const resources = await authz.listResources({
      subject: 'user:alice',
      permission: 'document.read',
    });
    // The shape is the contract: a bare array could not say it was partial.
    expect(resources).toEqual({ resources: ['document:1'], truncated: false });

    const subjects = await authz.listSubjects({
      permission: 'document.anyone',
      resource: 'document:1',
    });
    // Symbolic, not invented: the `user:*` edge on `open` covers alice, so the
    // answer is the *type*, and alice's own grant is subsumed by it rather
    // than listed alongside it.
    expect(subjects.allOfTypes).toEqual(['user']);
    expect(subjects.members).toEqual([]);
    expect(subjects.truncated).toBe(false);

    const expanded = await authz.expand({ subject: 'team:eng#member' });
    expect(expanded.subjects).toEqual(['user:alice']);
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
