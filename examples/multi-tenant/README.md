# multi-tenant

Per-tenant isolation, with no tenancy anywhere in the engine.

```bash
pnpm --filter @tsbouncer-examples/multi-tenant start
```

## The situation

You just onboarded customer number forty, and the authorization table has a
`WHERE org_id = ?` on it. Now the question is whether to add an `org_id` column to
every tuple.

That is a schema migration, it hardcodes one tenancy model into your authorization
layer, and it is painful to reverse once an app has a second shape of tenancy in
it. There is a way to get the same guarantee without the column, and it is worth
knowing before customer forty-one.

## The shape of it

The engine understands `type:id` and `type:id#relation`, and nothing else. It never
resolves a reference to a row, never asks what organisation an id belongs to, and
never needs a foreign key into your domain schema.

Tenancy is therefore your decision, and the cheapest way to make it is to put it in
the id:

```ts
const ns = (org: string) => ({
  user: (id: string) => `user:${org}:${id}`,
  project: (id: string) => `project:${org}:${id}`,
});
```

That helper is your code, not the library's. Two tenants then have identically shaped
ids that cannot collide:

```ts
{ subject: acme.user('ada'), relation: 'owner', resource: acme.project('api') }
{ subject: globex.user('ada'), relation: 'owner', resource: globex.project('api') }
```

## The alternative, and why not

A first-class `org` column on every tuple is a schema decision that is painful to
retrofit, and it hardcodes one tenancy model into the kernel. The layout above keeps
the same guarantees while leaving that choice reversible.

## Make the tenant part of the type

The `ns` helper above is five lines. Making it generic buys you something real: a
bare `user:ada` stops being constructible, so the cross-tenant mistake becomes a type
error rather than a denied request you find in production.

```ts
import type { ModelShapeOf, ObjectRefOf, SubjectRefOf } from 'tsbouncer';
import { model } from './model.js';

type Shape = ModelShapeOf<typeof model>;

/** One tenant's namespace. `ns('acme').user('ada')` is `user:acme:ada`. */
export function ns(org: string) {
  const ref = <T extends 'user' | 'team' | 'project'>(type: T, id: string) =>
    `${type}:${org}:${id}`;
  return {
    user: (id: string) => ref('user', id) as SubjectRefOf<Shape>,
    team: (id: string) => ref('team', id) as SubjectRefOf<Shape>,
    project: (id: string) => ref('project', id) as ObjectRefOf<Shape>,
  };
}

export const acme = ns('acme');
export const globex = ns('globex');

acme.user('ada'); // SubjectRefOf<Shape>
acme.project('api'); // ObjectRefOf<Shape>
```

Wrap that in one function per tenant and a check cannot be asked about the wrong
one, because you would have to construct the ref to ask:

```ts
export function scopedAuthz(org: string) {
  const ns = nsFor(org);
  return {
    canReadProject: (userId: string, projectId: string) =>
      authz.can(ns.user(userId), 'project.read', ns.project(projectId)),
    projectIds: async (userId: string) =>
      authz.listResources({ subject: ns.user(userId), permission: 'project.read' }),
  };
}

const acmeAuthz = scopedAuthz('acme');
await acmeAuthz.canReadProject('ada', 'api'); // true
```

The second one is the reason ids are worth scoping early. `listResources` returns
every project this user can read, and because ids are opaque you get the tenant
boundary for free — the store filter is `{ resource: 'project:acme:…' }`, not a
`WHERE org_id = ?` you have to remember in a second place.

## What you'll see

```
ok    acme ada owns acme/api             allowed
ok    globex ada owns globex/api         allowed
ok    acme ada does not own globex/api   denied
ok    globex ada does not own acme/api   denied
ok    bare id matches nothing            denied
```

`bare id matches nothing` is the one to notice: `user:ada` is a *different subject*
from `acme.user('ada')`, not a sloppy alias for it. Scoping is exact.

Because ids are opaque, one filtered read lists a tenant's tuples — which is what a
real app does on its way to tenant-scoped queries. And a ban in one tenant cannot
leak into another, which the last two cases check.
