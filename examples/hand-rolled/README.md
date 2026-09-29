# hand-rolled

**Start here.** Everything else assumes you already have permission checks and
want to know what replacing them costs.

```bash
pnpm --filter @tsbouncer-examples/hand-rolled start
```

## The situation

You have a `canRefund(user, order)` — a few `if` statements that everyone is afraid
to touch. It is a support tool for a multi-tenant commerce app. It works.

It keeps working right up until the third org, the first suspended user, or the
first id that is only unique within its tenant. This program runs that function
against the cases the business actually cares about, and shows you exactly which
of them it gets wrong.

## What you'll see

```
hand-rolled canRefund():
ok    a platform admin refunds any order         allowed
ok    an agent refunds their own org order       allowed
ok    an agent cannot refund another org         denied
ok    whoever placed the order can refund it     allowed
BUG   the same id in another tenant is not you   allowed
BUG   a banned agent cannot refund               allowed
ok    the account owner refunds its order        allowed
ok    a refunded order is closed to everyone     denied

the same cases, as a model:
ok    a platform admin refunds any order         allowed
ok    an agent refunds their own org order       allowed
ok    an agent cannot refund another org         denied
ok    whoever placed the order can refund it     allowed
ok    the same id in another tenant is not you   denied
ok    a banned agent cannot refund               denied
ok    the account owner refunds its order        allowed
ok    a refunded order is closed to everyone     denied

hand-rolled got 2 of 8 wrong; the model got 0.
```

## The two bugs

**`the same id in another tenant is not you`.** `u1` exists in both `acme` and
`globex` — most schemas number users per tenant — and the hand-rolled check
compares the bare id. An acme user refunds a globex order. This is the bug that
ends up in a postmortem, and it is invisible in review because the line looks
correct.

**`a banned agent cannot refund`.** The function has no notion of a ban at all.
When someone is banned, the fix is to add a branch — and to add it to every other
function shaped like this one, in the same deploy.

## What the model changes

The five rules become a graph, and two of them stop being code at all:

| business rule | becomes |
| --- | --- |
| an org's admin or agent can refund its orders | `ttu('org', 'refund')` |
| whoever placed the order can refund it | `'placedBy'` |
| the account's owner can refund its orders | `ttu('account', 'refund')` |
| a banned user can never refund | `.except('banned')` |
| "platform admin" | an `admin` tuple on each org — **no code** |

That last row is the quiet win. A global admin stops being a magic role string in
a function signature and becomes data. Onboarding a tenant is a write, not a
deploy, and `role: 'auditor'` next quarter is a relation rather than a branch.

The tenancy fix is structural rather than careful: ids are scoped at the point of
construction, so `user:acme:u1` and `user:globex:u1` are different subjects and
cannot be compared at all. There is no line to get wrong.

## One rule deliberately left out

"Nobody refunds an order that is already refunded" is *not* in the model. `except`
subtracts subjects, and "this order is closed" is a fact about the order, not about
who is asking.

```ts
const isRefundable = (order: Order) => order.status !== 'refunded';
const allowed = isRefundable(order) && (await authz.can(user, 'order.refund', ref));
```

Two questions, two checks. The hand-rolled version had the same guard — folded into
its first line — but the moment a second state (`disputed`, `on_hold`) arrives, you
want to see the state machine and the authorization graph as separate things. tsbouncer
does not try to be your state machine.

## Read the function signature

The hand-rolled version needs the order *and* its account, because one rule reaches
through a relationship. Add a rule that traverses two and this signature needs two
more arguments and another join — in every function shaped like it.

The model version takes `(subject, permission, resource)`. The graph traversal is
the library's problem, and it is a filtered read per hop.

## Wiring it into a TypeScript app

Three decisions belong to you, and they are the reason the library does no HTTP:
where the check goes, what a denial throws, and how the strings are typed.

**Where it goes.** One function, called from wherever you already branch. It is
async because a store read is, and it returns a boolean.

```ts
// src/authz.ts — the only module that imports tsbouncer
export const canRefund = (user: User, order: Order): Promise<boolean> =>
  authz.can(refOf(user), 'order.refund', `order:${order.id}`);

export const refundable = (order: Order): boolean => order.status !== 'refunded';
```

**What a denial throws.** `can` gives you a boolean; `assert` throws an
`AccessDeniedError` carrying the request and a stable `code`, which is what you
want in a handler that already has an error path.

```ts
import { isAuthorizationError } from 'tsbouncer';

try {
  await authz.assert({ subject, permission: 'order.refund', resource });
} catch (err) {
  if (isAuthorizationError(err) && err.code === 'access_denied') {
    return new Response('forbidden', { status: 403 });
  }
  throw err; // a store or model failure is *not* a denial — do not swallow it
}
```

That last line is the important one. A denied check and a broken check are
different events, and only the first should become a 403.

**How the strings are typed.** `permission` is a `string` on the client, because
the model is built at runtime. Derive the legal values from the model instead —
this is the whole pattern, and [`vanilla`](../vanilla) has it in full:

```ts
import type { ModelShapeOf, PermissionOf } from 'tsbouncer';
import { model } from './model.js';

type Shape = ModelShapeOf<typeof model>;
type OrderPermission = Extract<PermissionOf<Shape>, `order.${string}`>;
// 'order.refund' — and nothing else, with a "Did you mean" when you typo it
```

## Next

[`vanilla`](../vanilla) is the shortest useful program and carries one of every
shape. [`multi-tenant`](../multi-tenant) picks up the id-scoping question this
example only gestures at.
