export type {
  Authz,
  CheckOptions,
  CheckRequest,
  CreateAuthzOptions,
  Decision,
  GrantInput,
  ListResourcesQuery,
  ListSubjectsQuery,
} from './client.js';
export { createAuthz } from './client.js';
export type { ConditionDenied, ConditionOutcome } from './conditions.js';
export {
  evaluateTupleCondition,
  mergeContext,
  validateBoundContext,
} from './conditions.js';
export type {
  AuthorizationErrorCode,
  AuthorizationErrorOptions,
} from './errors.js';
export {
  AccessDeniedError,
  AuthorizationError,
  EvaluationLimitError,
  InvalidReferenceError,
  InvalidStoreError,
  isAuthorizationError,
  ModelDefinitionError,
  StoreError,
  TupleValidationError,
} from './errors.js';
export type { EvaluationOutcome, EvaluationRequest } from './evaluate.js';
export { evaluate } from './evaluate.js';
export type { ExplainNode, ExplainOp, ExplainResult } from './explain.js';
export { formatExplain } from './explain.js';
export type { EvaluationLimits, LimitKind } from './limits.js';
export { Budget, DEFAULT_LIMITS, resolveLimits } from './limits.js';
export type {
  Child,
  ComputedNode,
  ConditionContext,
  ConditionDef,
  ConditionOptions,
  ConditionPredicate,
  DirectNode,
  ExclusionNode,
  IntersectionNode,
  Model,
  ModelConfig,
  ParamType,
  SetExpression,
  SetNode,
  TtuNode,
  TypeConfig,
  TypeDefinition,
  UnionNode,
  UsersetNode,
} from './model.js';
export {
  defineCondition,
  defineModel,
  defineType,
  permission,
  permissionsOf,
  relation,
  relationsOf,
  ttu,
  typeNames,
  wildcard,
} from './model.js';
export type {
  ExpandResult,
  ListResourcesInput,
  ListSubjectsInput,
  ResourceList,
} from './query.js';
export {
  expandSubjects,
  inheritedInto,
  listResources,
  listSubjects,
  throughRelations,
} from './query.js';
export type { ParsedRef, RefPosition } from './refs.js';
export {
  formatPermission,
  formatRef,
  isWildcard,
  parsePermission,
  parseRef,
  refKey,
  tryParseRef,
  WILDCARD,
} from './refs.js';
export type {
  ModelShape,
  ModelShapeOf,
  ObjectRefOf,
  PermissionOf,
  SubjectRefOf,
  TypeNames,
  TypeShape,
} from './shape.js';
export type {
  DeleteInput,
  FilterValue,
  Page,
  ReadTupleQuery,
  Tuple,
  TupleStore,
  TupleStoreCapabilities,
  WriteInput,
  WriteMode,
} from './store.js';
export { assertStoreShape, matchesQuery, NO_CAPABILITIES, tupleKey } from './store.js';
export type { SubjectSet } from './subjectset.js';

export {
  concreteRefs,
  difference,
  differenceAll,
  emptySet,
  intersection,
  intersectionAll,
  isEmpty,
  isExhaustive,
  set,
  setOfType,
  union,
  unionAll,
} from './subjectset.js';
export { acceptsSubject, describeTuple, validateTuple, validateTuples } from './write.js';
