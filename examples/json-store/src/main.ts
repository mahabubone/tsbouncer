import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAuthz,
  defineModel,
  defineType,
  jsonStore,
  permission,
  relation,
} from 'tsbouncer';

/**
 * Authorization state as a file you can read, diff, and commit.
 *
 * The file is the point: it stays a plain JSON document rather than a build
 * artifact, so a test fixture, a seed script, and a local database are all the
 * same thing.
 */

const model = defineModel({
  types: {
    user: defineType({}),
    team: defineType({ relations: { member: relation(['user']) } }),
    document: defineType({
      relations: {
        owner: relation(['user']),
        editor: relation('user').or(relation('team', { through: 'member' })),
      },
      permissions: { read: permission.or('owner', 'editor') },
    }),
  },
});

const dir = mkdtempSync(join(tmpdir(), 'tsbouncer-example-'));
const file = join(dir, 'tsbouncer.json');

const first = createAuthz({ model, store: jsonStore({ file }) });
await first.write([
  { subject: 'user:alice', relation: 'owner', resource: 'document:1' },
  { subject: 'team:eng#member', relation: 'editor', resource: 'document:2' },
  { subject: 'user:alice', relation: 'member', resource: 'team:eng' },
]);
console.log('wrote', file);

console.log('\nthe file on disk:');
console.log(readFileSync(file, 'utf8'));

// A new process would see exactly this. Simulate one.
const second = createAuthz({ model, store: jsonStore({ file }) });
const cases: [string, string, string, boolean][] = [
  ['user:alice', 'document.read', 'document:1', true],
  ['user:alice', 'document.read', 'document:2', true],
  ['user:bob', 'document.read', 'document:2', false],
];

let failures = 0;
console.log('\nafter reopening:');
for (const [subject, permissionName, resource, expected] of cases) {
  const allowed = await second.can(subject, permissionName, resource);
  if (allowed !== expected) failures += 1;
  console.log(
    `${allowed === expected ? 'ok  ' : 'FAIL'}  ${subject} ${permissionName} ${resource} -> ${allowed ? 'allowed' : 'denied'}`,
  );
}

// A write is durable, and the store reloads on demand if something else edited it.
await second.revoke({ subject: 'user:alice', relation: 'owner', resource: 'document:1' });
const third = createAuthz({ model, store: jsonStore({ file }) });
const afterRevoke = await third.can('user:alice', 'document.read', 'document:1');
if (afterRevoke !== false) failures += 1;
console.log(
  `${afterRevoke === false ? 'ok  ' : 'FAIL'}  revoke is durable -> ${afterRevoke ? 'allowed' : 'denied'}`,
);

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
