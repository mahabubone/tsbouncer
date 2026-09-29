# conditions

Attribute-gated access: a grant that only holds while some predicate is true.

```bash
pnpm --filter @tsbouncer-examples/conditions start
```

## The situation

You sell per-seat access. A customer is granted a seat, but the seat only works
while they are on a plan that includes it and while they have not hit their seat
limit.

Both halves change constantly — the plan, the current seat count — so neither
belongs in the grant. Only the *constraints the writer set* do. That is the split
this example exists to make concrete.

## The shape of it

A condition has two halves of input, and the split is the whole idea:

| | carried by | example |
| --- | --- | --- |
| what the writer bound | the **tuple** | `minimumPlan: 'pro'`, `seatsTotal: 10` |
| what the caller knows now | the **request** | `plan: 'free'`, `seatsUsed: 3` |

The predicate sees both. Only the tuple's half is stored, so tuples still serialize
cleanly and a store never evaluates anything.

```ts
conditions: {
  activeSeat: defineCondition(
    'activeSeat',
    (ctx) => {
      const { plan, seatsUsed, minimumPlan, seatsTotal } = ctx;
      if (typeof plan !== 'string' || typeof seatsUsed !== 'number') return false;
      if (typeof minimumPlan !== 'string' || typeof seatsTotal !== 'number')
        return false;
      return plan === minimumPlan && seatsUsed < seatsTotal;
    },
    { params: { minimumPlan: 'string' as const, seatsTotal: 'number' as const } },
  ),
}
```

Note the narrowing. Every value a predicate reads is `unknown` — `params` governs
*write-time validation*, not the predicate's own types — so the predicate checks the
shape of everything it touches. That is more typing than most people want to write,
and it is the sharpest ergonomic edge on this API today.

## The tuple wins

If the request could override `minimumPlan`, a caller could rewrite the constraint
the grant was written with, and the condition would be theatre. The
`request cannot override` case exists to hold that line.

## Everything fails closed

`seat below the plan`, `seat over quota`, and `seat with nothing supplied` are all
denials. A missing key is not a pass — `explain()` reports it as a reason rather
than a silent `false`:

```
    - condition
      activeSeat returned false
```

## What you'll see

```
ok    owner ignores the condition      allowed
ok    seat within plan and quota       allowed
ok    seat below the plan              denied
ok    seat over quota                  denied
ok    seat with nothing supplied       denied
ok    someone with no grant            denied
ok    request cannot override          denied
```

The `params` declaration is not optional politeness — it is the only way a *missing*
key is distinguishable from a genuine denial.

## Supplying context from a request

Context is whatever the request already knows. Nothing is fetched for you, because
nothing should be — the store is schemaless and your app owns the data:

```ts
// in whatever handler you already have
const decision = await authz.check(
  { subject: `user:${session.userId}`, permission: 'document.read', resource },
  {
    context: {
      plan: await subscription.planFor(session.orgId), // changes constantly
      seatsUsed: await usage.seatsFor(session.orgId), // and is not in the store
    },
  },
);
```

The split is enforced, not advisory. If `context` carried `minimumPlan`, it would be
ignored — the tuple's binding wins on every conflict, which is the case the
`request cannot override` assertion covers.

## Narrowing, and why there is boilerplate

A predicate's context is `{ [key: string]: unknown }`. `params` governs *write-time
validation*; it does not type the predicate. So a predicate that reads three values
checks three shapes:

```ts
activeSeat: defineCondition(
  'activeSeat',
  (ctx) => {
    const { plan, seatsUsed, minimumPlan, seatsTotal } = ctx;
    if (typeof plan !== 'string' || typeof seatsUsed !== 'number') return false;
    if (typeof minimumPlan !== 'string' || typeof seatsTotal !== 'number') return false;
    return plan === minimumPlan && seatsUsed < seatsTotal;
  },
  { params: { minimumPlan: 'string' as const, seatsTotal: 'number' as const } },
),
```

This is more typing than anyone wants to write, and it is the sharpest ergonomic
edge in the API today. It is also why the narrowing is worth keeping: the values a
predicate reads are attacker-influenced, and `undefined` reaching a comparison is
how a check ends up meaning something other than it says.

## Next

[`tuple-to-userset`](../tuple-to-userset) covers the traversal that decides whether
a grant is even reachable from where you are standing.
