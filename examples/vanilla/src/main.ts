import { createAuthz, memoryStore } from 'tsbouncer';
import { model } from './model.js';
import {
  type AnyResource,
  type AnySubject,
  type DocumentPermission,
  docRef,
  teamMemberRef,
  teamRef,
  typed,
  userRef,
} from './typed.js';

/**
 * The shortest useful program: define a model, write some tuples, ask questions.
 *
 * Every case below is a real decision, and the model in `./model.ts` is loaded
 * with one of every shape worth knowing — direct, userset, wildcard, exclusion,
 * and a parent-folder TTU. Run this first; the other examples each isolate one of
 * those shapes and go deeper on it.
 */

const authz = createAuthz({ model, store: memoryStore() });
const can = typed(authz);

// --- the data -------------------------------------------------------------
await authz.write([
  { subject: userRef('alice'), relation: 'owner', resource: docRef('1') },
  { subject: teamMemberRef('eng'), relation: 'editor', resource: docRef('2') },
  { subject: userRef('alice'), relation: 'member', resource: 'team:eng' },
  { subject: userRef('bob'), relation: 'member', resource: 'team:eng' },
  { subject: 'user:*', relation: 'anyone', resource: docRef('3') },
  { subject: 'folder:9', relation: 'parent', resource: docRef('4') },
  { subject: userRef('alice'), relation: 'viewer', resource: 'folder:9' },
  // document:5 has two owners-and-editors and one of them is banned, so the
  // exclusion is the only difference between the two write cases below.
  { subject: userRef('dave'), relation: 'owner', resource: docRef('5') },
  { subject: userRef('dave'), relation: 'editor', resource: docRef('5') },
  { subject: userRef('mallory'), relation: 'owner', resource: docRef('5') },
  { subject: userRef('mallory'), relation: 'editor', resource: docRef('5') },
  { subject: userRef('mallory'), relation: 'banned', resource: docRef('5') },
]);

// --- the decisions --------------------------------------------------------
// The permission is `DocumentPermission`, not `string`, so a typo in the table
// below is a build failure rather than a test failure. Same for the refs.
interface Case {
  readonly label: string;
  readonly subject: AnySubject;
  readonly permission: DocumentPermission;
  readonly resource: AnyResource;
  readonly expected: boolean;
}

const cases: Case[] = [
  {
    label: 'owner can read',
    subject: userRef('alice'),
    permission: 'document.read',
    resource: docRef('1'),
    expected: true,
  },
  {
    label: 'stranger cannot read',
    subject: userRef('mallory'),
    permission: 'document.read',
    resource: docRef('1'),
    expected: false,
  },
  {
    label: 'team member inherits edit',
    subject: userRef('alice'),
    permission: 'document.read',
    resource: docRef('2'),
    expected: true,
  },
  {
    label: 'non-member does not',
    subject: userRef('carol'),
    permission: 'document.read',
    resource: docRef('2'),
    expected: false,
  },
  {
    label: 'a team is not its members',
    subject: teamRef('eng'),
    permission: 'document.read',
    resource: docRef('2'),
    expected: false,
  },
  {
    label: 'wildcard makes it public',
    subject: userRef('anyone'),
    permission: 'document.public',
    resource: docRef('3'),
    expected: true,
  },
  {
    label: 'wildcard does not grant write',
    subject: userRef('alice'),
    permission: 'document.write',
    resource: docRef('3'),
    expected: false,
  },
  {
    label: 'inherits from parent folder',
    subject: userRef('alice'),
    permission: 'document.read',
    resource: docRef('4'),
    expected: true,
  },
  {
    label: 'owner and editor can write',
    subject: userRef('dave'),
    permission: 'document.write',
    resource: docRef('5'),
    expected: true,
  },
  {
    label: 'a ban overrides owner and editor',
    subject: userRef('mallory'),
    permission: 'document.write',
    resource: docRef('5'),
    expected: false,
  },
  {
    label: 'but the ban does not touch read',
    subject: userRef('mallory'),
    permission: 'document.read',
    resource: docRef('5'),
    expected: true,
  },
  {
    label: 'parent folder is not leaked',
    subject: userRef('bob'),
    permission: 'document.read',
    resource: docRef('4'),
    expected: false,
  },
];

let failures = 0;
for (const testCase of cases) {
  const allowed = await can.can(testCase.subject, testCase.permission, testCase.resource);
  const ok = allowed === testCase.expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${testCase.label.padEnd(32)} ${allowed ? 'allowed' : 'denied'}`,
  );
}

// --- why, not just what ---------------------------------------------------
const result = await authz.explain({
  subject: userRef('carol'),
  permission: 'document.read',
  resource: docRef('2'),
});
console.log('\nwhy carol is denied:');
console.log(result.allowed ? '  (allowed)' : `  (denied after ${result.reads} reads)`);

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log(`\nall ${cases.length} cases passed`);
