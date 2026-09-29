# vanilla

The smallest useful program. Read this one first.

```bash
pnpm --filter @tsbouncer-examples/vanilla start
```

## The situation

A small document tool. People own documents, teams edit them, some documents are
public, and some documents live in a folder that inherits its viewers.

Written by hand, `document.write` is the branch everyone is afraid to touch:

```ts
// the version this replaces
function canWrite(user: User, doc: Doc, teams: string[]): boolean {
  if (doc.ownerId === user.id && !user.banned) return true;
  if (teams.includes(doc.teamId) && !user.banned) return true;
  return false; // and anyone who inherits from a folder is simply not here
}
```

That function has a bug in the first line that typechecks and reads correctly in
review: `&&` where `||` was meant, so an owner who is also banned keeps write
access. It silently drops anyone who inherits access from a folder, and it has no
way to express "every user who does not exist yet" for the public documents. The
model below replaces it with the same intent, and the assertions cover all three.

## The shape of it

A complete model in [`src/model.ts`](./src/model.ts) carrying one of every shape worth
knowing — direct ownership, a userset, a wildcard, an exclusion, and a parent-folder
TTU — then nine cases that each prove a different thing about the evaluator.

```ts
import { createAuthz, memoryStore } from 'tsbouncer';
import { model } from './model.js';

const authz = createAuthz({ model, store: memoryStore() });

await authz.write([
  { subject: 'user:alice', relation: 'owner', resource: 'document:1' },
  // ...
]);

await authz.can('user:alice', 'document.read', 'document:1'); // true
```

Four calls, in order: `defineModel` (in `./model.ts`), `createAuthz`, `write`, `can`.
Everything else in this repo is detail on one of those four.

## Types: `can()` takes three strings, and they are checked

`authz.can(subject, permission, resource)` takes plain `string`s, because the store
is schemaless and the model is built at runtime. The model is still known
statically, though, so [`src/typed.ts`](./src/typed.ts) derives the legal strings
from `typeof model` and every call site after that is checked:

```ts
import type {
  Authz, ModelShapeOf, ObjectRefOf, PermissionOf, SubjectRefOf,
} from 'tsbouncer';
import type { model } from './model.js';

type Shape = ModelShapeOf<typeof model>;

export type AnySubject = SubjectRefOf<Shape>;   // 'user:…' | 'team:…#member' | …
export type AnyResource = ObjectRefOf<Shape>;  // 'user:…' | 'document:…' | …
export type AnyPermission = PermissionOf<Shape>; // 'document.read' | 'team.read' | …

// Narrowing to one type is a plain Extract, since the union is 'type.perm'.
export type DocumentPermission = Extract<AnyPermission, `document.${string}`>;

// Build refs in one place. The cast is sound: an id cannot contain ':' or '#'.
export const userRef = (id: string): AnySubject => `user:${id}` as AnySubject;
export const docRef = (id: string): AnyResource => `document:${id}` as AnyResource;

export function typed(authz: Authz) {
  return {
    can: (s: AnySubject, p: AnyPermission, r: AnyResource) => authz.can(s, p, r),
    canOnDocument: (s: AnySubject, p: DocumentPermission, id: string) =>
      authz.can(s, p, docRef(id)),
  };
}
```

Nothing is wrapped or hidden — every method forwards to `authz` — but the
arguments are now checked. The case table in `src/main.ts` is typed with these,
so a typo is a **build** failure rather than a test failure:

```
src/main.ts(52,5): error TS2820: Type '"document.riad"' is not assignable to
type 'DocumentPermission'. Did you mean '"document.read"'?
```

Two honest limits. The unions narrow the *permission*, which is the string you
retype most, and that one is exact. Reference strings are looser than they look:
`` `user:${string}` `` also matches `user:x#member`, because `${string}` swallows
the `#`. Catching that needs a branded id type, which is more machinery than the
rest is worth.

## What you'll see

```
ok    owner can read                   allowed
ok    stranger cannot read             denied
ok    team member inherits edit        allowed
ok    non-member does not              denied
ok    a team is not its members        denied
ok    wildcard makes it public         allowed
ok    wildcard does not grant write    denied
ok    inherits from parent folder      allowed
ok    owner and editor can write       allowed
ok    a ban overrides owner and editor denied
ok    but the ban does not touch read  allowed
ok    parent folder is not leaked      denied

why carol is denied:
  (denied after 5 reads)
```

## The two cases worth pausing on

**`a team is not its members` is denied.** `team:eng#member` and `team:eng` are
different grants written under the same relation name. The first names every user
in the team; the second names the team *object*. A subject never inherits through
an object it merely is.

**`wildcard does not grant write` is denied.** `user:*` on `anyone` makes
`document:3` public, and public is not writable. A wildcard is a shorthand for
"every user", not a bypass.

**`a ban overrides owner and editor` is denied, and the case above it is allowed.**
This is a pair on purpose. `document:5` has two people who are both owner *and*
editor, and the only difference between them is one `banned` tuple. An exclusion
that was never proven against its positive control is a comment, not a rule — and
the third case shows the ban is scoped: it removes `write` without touching `read`,
which is the whole reason `.except()` names a relation instead of negating the
permission.

## Next

Each other example isolates one of the shapes above and goes deeper on it.
