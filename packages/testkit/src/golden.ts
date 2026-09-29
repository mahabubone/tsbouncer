import {
  createAuthz,
  defineCondition,
  defineModel,
  defineType,
  permission,
  relation,
  type Tuple,
  type TupleStore,
  ttu,
  wildcard,
} from 'tsbouncer';
import { expect } from 'vitest';

/**
 * A shared dataset with a fixed set of answers.
 *
 * `storeConformance` proves that a store honours the *contract*. It cannot prove
 * that two stores honour it *identically*, because each is tested against its own
 * fixtures. That gap is the whole risk of the "switch adapters without migrating
 * data" promise: a filter that quietly matches more rows in SQLite than in Drizzle
 * passes its own suite and still produces a different answer.
 *
 * So this is one dataset, one set of expected decisions, and every store runs it.
 * The expectations were produced by `memoryStore`, which has no query builder and
 * therefore nothing to get wrong at the SQL layer. A store that diverges fails
 * here rather than in a user's application.
 *
 * Deliberately exercises one of every shape the engine implements, because a
 * golden set that only covers `direct` would agree across stores for a reason
 * that has nothing to do with the contract.
 */

export const goldenModel = defineModel({
  types: {
    user: defineType({}),

    team: defineType({
      relations: { member: relation(['user']) },
      permissions: { read: permission.or('member') },
    }),

    folder: defineType({
      relations: {
        viewer: relation('user').or(relation('team', { through: 'member' })),
        parent: relation('folder'),
      },
      permissions: { read: permission.or('viewer', ttu('parent', 'read')) },
    }),

    document: defineType({
      relations: {
        owner: relation(['user']),
        editor: relation('user').or(relation('team', { through: 'member' })),
        parent: relation('folder'),
        banned: relation('user').or(wildcard('user')),
        anyone: relation('user').or(wildcard('user')),
      },
      permissions: {
        read: permission.or('owner', 'editor', ttu('parent', 'read')),
        write: permission.allOf('owner', 'editor').except('banned'),
        public: permission.or('anyone'),
        // A symbolic base minus a named exception — the only shape that makes
        // SubjectSet.excluded non-empty, and the one a store is most likely to
        // get wrong, because it needs a wildcard subject filter.
        publish: permission.or('anyone').except('banned'),
      },
    }),
  },

  conditions: {
    sameRegion: defineCondition(
      'sameRegion',
      (ctx) => {
        const { expected, actual } = ctx;
        if (typeof expected !== 'string' || typeof actual !== 'string') return false;
        return expected === actual;
      },
      { params: { expected: 'string' as const } },
    ),
  },
});

/**
 * Covers direct, userset, wildcard, exclusion, tuple-to-userset, inheritance, a
 * condition, and an absent-context denial. `user:*` on `banned` is the case that
 * catches a store which mishandles the wildcard id in a subject filter.
 */
export const goldenTuples: readonly Tuple[] = [
  // direct
  { subject: 'user:alice', relation: 'owner', resource: 'document:1' },
  { subject: 'user:alice', relation: 'editor', resource: 'document:1' },
  // userset
  { subject: 'user:alice', relation: 'member', resource: 'team:eng' },
  { subject: 'user:bob', relation: 'member', resource: 'team:eng' },
  { subject: 'team:eng#member', relation: 'editor', resource: 'document:2' },
  // wildcard
  { subject: 'user:*', relation: 'anyone', resource: 'document:3' },
  // exclusion
  { subject: 'user:carol', relation: 'owner', resource: 'document:4' },
  { subject: 'user:carol', relation: 'editor', resource: 'document:4' },
  { subject: 'user:carol', relation: 'banned', resource: 'document:4' },
  // tuple-to-userset and inherited read
  { subject: 'folder:9', relation: 'parent', resource: 'document:5' },
  { subject: 'user:alice', relation: 'viewer', resource: 'folder:9' },
  // condition
  {
    subject: 'user:dave',
    relation: 'owner',
    resource: 'document:6',
    condition: 'sameRegion',
    context: { expected: 'eu' },
  },
  // a symbolic base with one named exception, which is the only shape that
  // populates SubjectSet.excluded
  { subject: 'user:*', relation: 'anyone', resource: 'document:7' },
  { subject: 'user:mallory', relation: 'banned', resource: 'document:7' },
];

export interface GoldenCheck {
  readonly subject: string;
  readonly permission: string;
  readonly resource: string;
  readonly expected: boolean;
  readonly context?: Record<string, unknown>;
}

export const goldenChecks: readonly GoldenCheck[] = [
  // direct
  {
    subject: 'user:alice',
    permission: 'document.write',
    resource: 'document:1',
    expected: true,
  },
  {
    subject: 'user:mallory',
    permission: 'document.read',
    resource: 'document:1',
    expected: false,
  },
  // userset
  {
    subject: 'user:alice',
    permission: 'document.read',
    resource: 'document:2',
    expected: true,
  },
  {
    subject: 'user:carol',
    permission: 'document.read',
    resource: 'document:2',
    expected: false,
  },
  // wildcard
  {
    subject: 'user:mallory',
    permission: 'document.public',
    resource: 'document:3',
    expected: true,
  },
  // exclusion
  {
    subject: 'user:carol',
    permission: 'document.read',
    resource: 'document:4',
    expected: true,
  },
  {
    subject: 'user:carol',
    permission: 'document.write',
    resource: 'document:4',
    expected: false,
  },
  {
    subject: 'user:mallory',
    permission: 'document.write',
    resource: 'document:4',
    expected: false,
  },
  // tuple-to-userset, including the denial that must not leak the folder
  {
    subject: 'user:alice',
    permission: 'document.read',
    resource: 'document:5',
    expected: true,
  },
  {
    subject: 'user:bob',
    permission: 'document.read',
    resource: 'document:5',
    expected: false,
  },
  // condition: the bound value is authoritative, request context only fills gaps
  {
    subject: 'user:dave',
    permission: 'document.read',
    resource: 'document:6',
    expected: true,
    context: { actual: 'eu' },
  },
  {
    subject: 'user:dave',
    permission: 'document.read',
    resource: 'document:6',
    expected: false,
    context: { actual: 'us' },
  },
  {
    subject: 'user:dave',
    permission: 'document.read',
    resource: 'document:6',
    expected: false,
  },
  // wildcard narrowed by one named exception
  {
    subject: 'user:mallory',
    permission: 'document.publish',
    resource: 'document:7',
    expected: false,
  },
  {
    subject: 'user:erin',
    permission: 'document.publish',
    resource: 'document:7',
    expected: true,
  },
];

/** Every decision the dataset produces, as a stable, comparable string. */
export interface GoldenOutcome {
  readonly checks: readonly boolean[];
  readonly listResources: Readonly<Record<string, readonly string[]>>;
  readonly listSubjects: Readonly<Record<string, readonly string[]>>;
}

const LISTERS = [
  { subject: 'user:alice', permission: 'document.read' },
  { subject: 'user:bob', permission: 'document.read' },
  { subject: 'user:carol', permission: 'document.read' },
] as const;

const LISTED = [
  { permission: 'document.read', resource: 'document:1' },
  { permission: 'document.public', resource: 'document:3' },
  { permission: 'document.publish', resource: 'document:7' },
  { permission: 'document.write', resource: 'document:4' },
] as const;

/**
 * Write the dataset, run every expectation, and return a comparable value.
 *
 * Returned rather than asserted, so a store's test can compare it against
 * `GOLDEN_EXPECTED` — that comparison is the equivalence proof. Sorting every
 * list means the assertion is about *what* the store answered, never about the
 * order rows happened to come back in, which is not part of the contract.
 */
export async function runGolden(store: TupleStore): Promise<GoldenOutcome> {
  const authz = createAuthz({ model: goldenModel, store });

  await authz.write(goldenTuples);

  const checks: boolean[] = [];
  for (const check of goldenChecks) {
    const decision = await authz.check(
      {
        subject: check.subject,
        permission: check.permission,
        resource: check.resource,
      },
      check.context === undefined ? undefined : { context: check.context },
    );
    checks.push(decision.allowed);
  }

  const listResources: Record<string, string[]> = {};
  for (const q of LISTERS) {
    const { resources } = await authz.listResources({
      subject: q.subject,
      permission: q.permission,
    });
    listResources[`${q.subject}|${q.permission}`] = [...resources].sort();
  }

  const listSubjects: Record<string, string[]> = {};
  for (const q of LISTED) {
    const set = await authz.listSubjects({
      permission: q.permission,
      resource: q.resource,
    });
    listSubjects[`${q.permission}|${q.resource}`] = [
      `allOfTypes:${[...set.allOfTypes].sort().join(',')}`,
      `members:${[...set.members].sort().join(',')}`,
      `excluded:${[...set.excluded].sort().join(',')}`,
    ];
  }

  return { checks, listResources, listSubjects };
}

/**
 * The answers `memoryStore` produces, recorded.
 *
 * Generated from `memoryStore` because it has no query builder and therefore
 * nothing at the SQL layer to get wrong — it is the reference implementation for
 * this comparison. Every store's `golden.test.ts` asserts its own output equals
 * this, which is the only thing that makes "switch adapters without migrating
 * data" a tested claim rather than a slogan.
 *
 * Regenerate with the `runGolden(memoryStore())` snippet in this file's history if
 * the engine's answers legitimately change; do not hand-edit to make a store pass.
 */
export const GOLDEN_EXPECTED: GoldenOutcome = {
  checks: [
    true,
    false,
    true,
    false,
    true,
    true,
    false,
    false,
    true,
    false,
    true,
    false,
    false,
    false,
    true,
  ],
  listResources: {
    'user:alice|document.read': ['document:1', 'document:2', 'document:5'],
    'user:bob|document.read': ['document:2'],
    'user:carol|document.read': ['document:4'],
  },
  listSubjects: {
    'document.read|document:1': ['allOfTypes:', 'members:user:alice', 'excluded:'],
    'document.public|document:3': ['allOfTypes:user', 'members:', 'excluded:'],
    'document.publish|document:7': [
      'allOfTypes:user',
      'members:',
      'excluded:user:mallory',
    ],
    'document.write|document:4': ['allOfTypes:', 'members:', 'excluded:user:carol'],
  },
};

/**
 * Assert that a store answers the shared dataset exactly as every other store
 * does. Each store's `golden.test.ts` is then a few lines.
 */
export function assertGolden(outcome: GoldenOutcome): void {
  expect(outcome.checks).toEqual(GOLDEN_EXPECTED.checks);
  expect(outcome.listResources).toEqual(GOLDEN_EXPECTED.listResources);
  expect(outcome.listSubjects).toEqual(GOLDEN_EXPECTED.listSubjects);
}
