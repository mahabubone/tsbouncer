import {
  createAuthz,
  defineModel,
  defineType,
  memoryStore,
  permission,
  relation,
  ttu,
  wildcard,
} from 'tsbouncer';

/**
 * Replacing the permission function you already have.
 *
 * Almost every codebase arrives at `canRefund(user, order)` — a few `if`
 * statements that everyone is afraid to touch. It works until the third org, the
 * first suspended user, or the first id that is only unique within its tenant.
 *
 * This program writes that function first, runs it against the cases the business
 * actually cares about, and shows exactly which of them it gets wrong. Then it
 * writes the same rules as a model and runs the *same* cases again.
 *
 * The two failures in the first half are not strawmen. Each is a bug that has
 * shipped somewhere.
 */

interface User {
  readonly id: string;
  readonly orgId: string;
  readonly role: 'admin' | 'agent' | 'member';
}

interface Account {
  readonly id: string;
  readonly orgId: string;
  readonly ownerId: string;
}

interface Order {
  readonly id: string;
  readonly orgId: string;
  readonly accountId: string;
  readonly placedById: string;
  readonly status: 'open' | 'refunded';
}

/* ------------------------------------------------------------------------ */
/* What you have today                                                       */
/* ------------------------------------------------------------------------ */

/**
 * The rules, as branches. Note what this signature has to know: the order, and
 * the account it belongs to, because the account's owner is one of the cases. Add
 * a rule that reaches through two relationships and this function needs two more
 * arguments and another join.
 */
function handRolledCanRefund(user: User, order: Order, account: Account): boolean {
  if (order.status === 'refunded') return false;
  if (user.role === 'admin') return true;
  if (user.role === 'agent' && user.orgId === order.orgId) return true;
  // Ids are unique per tenant, and this compares the bare id...
  if (order.placedById === user.id) return true;
  if (account.ownerId === user.id) return true;
  return false;
}

// A global admin is a role string on the user. Introducing "auditor" means
// editing this function, and every other function like it, in a deploy.

/* ------------------------------------------------------------------------ */
/* The data                                                                  */
/* ------------------------------------------------------------------------ */

// Note `u1` exists in both tenants. This is normal — most schemas number users
// per tenant — and it is the single most common way a hand-rolled check leaks.
const users = {
  acmeU1: { id: 'u1', orgId: 'acme', role: 'member' },
  globexU1: { id: 'u1', orgId: 'globex', role: 'member' },
  acmeAgent: { id: 'u2', orgId: 'acme', role: 'agent' },
  bannedAgent: { id: 'u3', orgId: 'acme', role: 'agent' },
  platformAdmin: { id: 'root', orgId: 'platform', role: 'admin' },
} satisfies Record<string, User>;

const accounts = {
  acc1: { id: 'acc_1', orgId: 'acme', ownerId: 'u1' },
  acc2: { id: 'acc_2', orgId: 'globex', ownerId: 'u1' },
} satisfies Record<string, Account>;

const orders = {
  acme1: {
    id: 'ord_acme_1',
    orgId: 'acme',
    accountId: 'acc_1',
    placedById: 'u2',
    status: 'open',
  },
  globex1: {
    id: 'ord_globex_1',
    orgId: 'globex',
    accountId: 'acc_2',
    placedById: 'u1',
    status: 'open',
  },
  acme2: {
    id: 'ord_acme_2',
    orgId: 'acme',
    accountId: 'acc_1',
    placedById: 'u2',
    status: 'refunded',
  },
} satisfies Record<string, Order>;

interface Scenario {
  readonly label: string;
  readonly user: User;
  readonly order: Order;
  readonly account: Account;
  readonly expected: boolean;
}

const scenarios: readonly Scenario[] = [
  {
    label: 'a platform admin refunds any order',
    user: users.platformAdmin,
    order: orders.acme1,
    account: accounts.acc1,
    expected: true,
  },
  {
    label: 'an agent refunds their own org order',
    user: users.acmeAgent,
    order: orders.acme1,
    account: accounts.acc1,
    expected: true,
  },
  {
    label: 'an agent cannot refund another org',
    user: users.acmeAgent,
    order: orders.globex1,
    account: accounts.acc2,
    expected: false,
  },
  {
    label: 'whoever placed the order can refund it',
    user: users.globexU1,
    order: orders.globex1,
    account: accounts.acc2,
    expected: true,
  },
  {
    label: 'the same id in another tenant is not you',
    user: users.acmeU1,
    order: orders.globex1,
    account: accounts.acc2,
    expected: false,
  },
  {
    label: 'a banned agent cannot refund',
    user: users.bannedAgent,
    order: orders.acme1,
    account: accounts.acc1,
    expected: false,
  },
  {
    label: 'the account owner refunds its order',
    user: users.acmeU1,
    order: orders.acme1,
    account: accounts.acc1,
    expected: true,
  },
  {
    label: 'a refunded order is closed to everyone',
    user: users.platformAdmin,
    order: orders.acme2,
    account: accounts.acc1,
    expected: false,
  },
];

/* ------------------------------------------------------------------------ */
/* Running the branches                                                      */
/* ------------------------------------------------------------------------ */

console.log('hand-rolled canRefund():');

let handRolledFailures = 0;
for (const s of scenarios) {
  const allowed = handRolledCanRefund(s.user, s.order, s.account);
  const ok = allowed === s.expected;
  if (!ok) handRolledFailures += 1;
  console.log(
    `${ok ? 'ok  ' : 'BUG '}  ${s.label.padEnd(42)} ${allowed ? 'allowed' : 'denied'}`,
  );
}

/* ------------------------------------------------------------------------ */
/* The same rules, as data                                                   */
/* ------------------------------------------------------------------------ */

// The five business rules map onto a graph without changing meaning:
//
//   1. an org's admin or agent can refund its orders -> ttu('org', 'refund')
//   2. whoever placed the order can refund it        -> 'placedBy'
//   3. the account's owner can refund its orders     -> ttu('account', 'refund')
//   4. a banned user can never refund                -> .except('banned')
//   5. a "platform admin" is an admin tuple per org  -> no code at all
//
// The fifth business rule — nobody refunds an order that is already refunded — is
// deliberately *not* in the model. `except` subtracts subjects, and "this order is
// closed" is a fact about the order, not about who is asking. It is a different
// question, so it stays a different check, and the model does not pretend to be
// your state machine.

const model = defineModel({
  types: {
    user: defineType({}),

    org: defineType({
      relations: { admin: relation(['user']), agent: relation('user') },
      permissions: { refund: permission.or('admin', 'agent') },
    }),

    account: defineType({
      relations: { owner: relation('user') },
      permissions: { refund: permission.or('owner') },
    }),

    order: defineType({
      relations: {
        org: relation('org'),
        account: relation('account'),
        placedBy: relation('user'),
        // `user:*` on `banned` is a real rule: "nobody on this order, ever".
        banned: relation('user').or(wildcard('user')),
      },
      permissions: {
        // `except` takes one relation at a time, so exclusions chain. Passing a
        // second argument is a type error — and would be silently ignored by
        // anything that skipped typechecking.
        refund: permission
          .or('placedBy', ttu('org', 'refund'), ttu('account', 'refund'))
          .except('banned'),
      },
    }),
  },
});

const authz = createAuthz({ model, store: memoryStore() });

// Ids are scoped at the point of construction, so `acme:u1` and `globex:u1` are
// different subjects and cannot be confused downstream.
const ref = (kind: string, orgId: string, id: string) => `${kind}:${orgId}:${id}`;

await authz.write([
  { subject: ref('user', 'platform', 'root'), relation: 'admin', resource: 'org:acme' },
  { subject: ref('user', 'platform', 'root'), relation: 'admin', resource: 'org:globex' },
  { subject: ref('user', 'acme', 'u2'), relation: 'agent', resource: 'org:acme' },
  { subject: ref('user', 'acme', 'u3'), relation: 'agent', resource: 'org:acme' },

  { subject: ref('user', 'acme', 'u1'), relation: 'owner', resource: 'account:acc_1' },
  { subject: ref('user', 'globex', 'u1'), relation: 'owner', resource: 'account:acc_2' },

  {
    subject: 'org:acme',
    relation: 'org',
    resource: `order:${orders.acme1.id}`,
  },
  {
    subject: 'account:acc_1',
    relation: 'account',
    resource: `order:${orders.acme1.id}`,
  },
  {
    subject: ref('user', 'acme', 'u2'),
    relation: 'placedBy',
    resource: `order:${orders.acme1.id}`,
  },
  {
    subject: ref('user', 'acme', 'u3'),
    relation: 'banned',
    resource: `order:${orders.acme1.id}`,
  },

  {
    subject: 'org:globex',
    relation: 'org',
    resource: `order:${orders.globex1.id}`,
  },
  {
    subject: 'account:acc_2',
    relation: 'account',
    resource: `order:${orders.globex1.id}`,
  },
  {
    subject: ref('user', 'globex', 'u1'),
    relation: 'placedBy',
    resource: `order:${orders.globex1.id}`,
  },

  {
    subject: 'org:acme',
    relation: 'org',
    resource: `order:${orders.acme2.id}`,
  },
  {
    subject: 'account:acc_1',
    relation: 'account',
    resource: `order:${orders.acme2.id}`,
  },
  {
    subject: ref('user', 'acme', 'u2'),
    relation: 'placedBy',
    resource: `order:${orders.acme2.id}`,
  },
]);

/* ------------------------------------------------------------------------ */
/* Running the graph                                                         */
/* ------------------------------------------------------------------------ */

// The state guard, applied to both paths, so the comparison stays fair. Note that
// the hand-rolled version had this folded into its first line; here it is
// deliberately separate from the authorization question.
const isRefundable = (order: Order) => order.status !== 'refunded';

console.log('\nthe same cases, as a model:');

let failures = 0;
for (const s of scenarios) {
  const allowed =
    isRefundable(s.order) &&
    (await authz.can(
      ref('user', s.user.orgId, s.user.id),
      'order.refund',
      `order:${s.order.id}`,
    ));
  const ok = allowed === s.expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${s.label.padEnd(42)} ${allowed ? 'allowed' : 'denied'}`,
  );
}

console.log(
  `\nhand-rolled got ${handRolledFailures} of ${scenarios.length} wrong; the model got ${failures}.`,
);

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
