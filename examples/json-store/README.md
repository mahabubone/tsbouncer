# json-store

Authorization state as a file you can read, diff, and commit.

```bash
pnpm --filter @tsbouncer-examples/json-store start
```

## The situation

Three things need authorization data and none of them is production: a test
fixture, a seed script for local development, and a demo environment someone shows
a customer from.

Today that means a database container, or a `beforeEach` that grants tuples
inline. This is the case where a file is the better store — you can read it, diff
it, commit it, and review it in a pull request.

## The shape of it

The file is the point. It stays a plain JSON document rather than a build artifact,
so a test fixture, a seed script, and a local database are all the same thing:

```ts
const authz = createAuthz({ model, store: jsonStore({ file }) });
await authz.write([
  { subject: 'user:alice', relation: 'owner', resource: 'document:1' },
]);
```

The example writes to a fresh temp directory, prints the file, then opens a *new*
client over it to show that a second process sees exactly the same state.

## What you'll see

```
the file on disk:
{
  "version": 1,
  "tuples": [
    { "subject": "user:alice", "relation": "owner", "resource": "document:1" },
    ...
  ]
}
```

then the reopened client answering correctly, and a `revoke` that survives into a
third client.

## The part worth copying

Writes are atomic — the new contents go to a temp file **in the same directory** as
the target and are then renamed, because `rename` is only atomic within a filesystem
and `/tmp` often is not the same one. Concurrent mutations are serialized through a
promise chain rather than an `await`, so two `grant` calls made without awaiting each
other both land.

A corrupt file is never silently reset. Treating one as an empty database would turn
a typo into data loss the caller cannot detect.

## Reading tuples back, and seeding a fixture

The store is readable, which is the other half of why a file works. One filtered
read is the whole primitive, and everything else is derived:

```ts
// seed a fixture. `insert` is the default and it *rejects* duplicates — a
// fixture that silently overwrites passes only where the data already existed.
await authz.write([
  { subject: 'user:alice', relation: 'owner', resource: 'document:1' },
  { subject: 'team:eng#member', relation: 'editor', resource: 'document:2' },
]);

// read one object's tuples, paged
const { items, cursor } = await authz.store.read({ resource: 'document:1', limit: 100 });

// read every tuple for a user, across types
const mine = await authz.store.read({ subject: 'user:alice' });

// swap everything scoped to one resource, as one all-or-nothing unit
await authz.delete({
  kind: 'replace',
  query: { resource: 'document:1' },
  tuples: [{ subject: 'user:bob', relation: 'owner', resource: 'document:1' }],
});
```

`read` takes any subset of subject / relation / resource, and `'user:*'` is a legal
filter — so "everything anyone can see" is a query, not a scan.

## When *not* to reach for this

Reach for it for fixtures, seeds, local dev, a demo environment, and a single-node
app. Do not reach for it when several processes write at once — the serialization
is in-process, so two `tsbouncer` processes on one file will lose a write. Past that
point it is `@tsbouncer/kysely`, `@tsbouncer/drizzle`, or `@tsbouncer/prisma`.

## Next

For a real database, the SQL adapters — `@tsbouncer/kysely`, `@tsbouncer/drizzle`,
`@tsbouncer/prisma` — run over the instance your app already has.
