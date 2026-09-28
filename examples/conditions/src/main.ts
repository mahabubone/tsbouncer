import {
  createAuthz,
  defineCondition,
  defineModel,
  defineType,
  formatExplain,
  memoryStore,
  permission,
  relation,
} from 'tsbouncer';

/**
 * Attribute-gated access.
 *
 * A condition is a predicate in the *model*; only its name and a few bound
 * parameters live on the tuple. So tuples still serialize cleanly, a store never
 * evaluates anything, and the logic stays in code where it can be reviewed.
 */

const model = defineModel({
  types: {
    user: defineType({}),
    document: defineType({
      relations: {
        owner: relation(['user']),
        // Owned by the org, but only usable by a paying customer.
        seat: relation('user'),
      },
      permissions: { read: permission.or('owner', 'seat') },
    }),
  },
  conditions: {
    // `org` is bound by the writer. `plan` is not in the store at all — it comes
    // with the request, because it changes.
    activeSeat: defineCondition(
      'activeSeat',
      (ctx) => ctx.plan === ctx.minimumPlan && ctx.seatsUsed < ctx.seatsTotal,
      // Declaring `params` says what a *tuple* may bind. It is also the only way
      // a missing key becomes a reason rather than a silent `false`.
      { params: { minimumPlan: 'string' as const, seatsTotal: 'number' as const } },
    ),
  },
});

const authz = createAuthz({ model, store: memoryStore() });

await authz.grant({
  subject: 'user:alice',
  relation: 'owner',
  resource: 'document:1',
});

// A seat is granted, but only within the plan and the seat limit the writer set.
await authz.grant({
  subject: 'user:bob',
  relation: 'seat',
  resource: 'document:1',
  condition: 'activeSeat',
  context: { minimumPlan: 'pro', seatsTotal: 10 },
});

const on = (plan: string, seatsUsed: number) => ({ plan, seatsUsed, seatsTotal: 10 });

const cases: [string, string, string, ReturnType<typeof on>, boolean][] = [
  ['owner ignores the condition', 'user:alice', 'document.read', on('free', 99), true],
  ['seat within plan and quota', 'user:bob', 'document.read', on('pro', 3), true],
  ['seat below the plan', 'user:bob', 'document.read', on('free', 1), false],
  ['seat over quota', 'user:bob', 'document.read', on('pro', 10), false],
  ['seat with nothing supplied', 'user:bob', 'document.read', {} as never, false],
  ['someone with no grant', 'user:carol', 'document.read', on('pro', 0), false],
];

let failures = 0;
for (const [label, subject, permissionName, context, expected] of cases) {
  const allowed = await authz.check(
    { subject, permission: permissionName, resource: 'document:1' },
    { context },
  );
  if (allowed.allowed !== expected) failures += 1;
  console.log(
    `${allowed.allowed === expected ? 'ok  ' : 'FAIL'}  ${label.padEnd(32)} ${allowed.allowed ? 'allowed' : 'denied'}`,
  );
}

// The request cannot rewrite what the writer bound.
const override = await authz.check(
  { subject: 'user:bob', permission: 'document.read', resource: 'document:1' },
  { context: { plan: 'free', minimumPlan: 'free', seatsUsed: 0, seatsTotal: 10 } },
);
if (override.allowed !== false) failures += 1;
console.log(
  `${override.allowed === false ? 'ok  ' : 'FAIL'}  ${'request cannot override'.padEnd(32)} ${override.allowed ? 'allowed' : 'denied'}`,
);

// And the reason is available, which is the whole point of keeping the bound
// parameters separate from the request.
const denied = await authz.explain(
  { subject: 'user:bob', permission: 'document.read', resource: 'document:1' },
  { context: on('free', 1) },
);
console.log('\nwhy bob is denied:');
console.log(formatExplain(denied));

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
