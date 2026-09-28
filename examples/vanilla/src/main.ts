import { createAuthz, memoryStore } from 'tsbouncer';
import { model } from './model.js';

const authz = createAuthz({ model, store: memoryStore() });

// --- the data -------------------------------------------------------------
await authz.write([
  { subject: 'user:alice', relation: 'owner', resource: 'document:1' },
  { subject: 'team:eng#member', relation: 'editor', resource: 'document:2' },
  { subject: 'user:alice', relation: 'member', resource: 'team:eng' },
  { subject: 'user:bob', relation: 'member', resource: 'team:eng' },
  { subject: 'user:*', relation: 'anyone', resource: 'document:3' },
  { subject: 'folder:9', relation: 'parent', resource: 'document:4' },
  { subject: 'user:alice', relation: 'viewer', resource: 'folder:9' },
]);

// --- the decisions --------------------------------------------------------
interface Case {
  readonly label: string;
  readonly subject: string;
  readonly permission: string;
  readonly resource: string;
  readonly expected: boolean;
}

const cases: Case[] = [
  {
    label: 'owner can read',
    subject: 'user:alice',
    permission: 'document.read',
    resource: 'document:1',
    expected: true,
  },
  {
    label: 'stranger cannot read',
    subject: 'user:mallory',
    permission: 'document.read',
    resource: 'document:1',
    expected: false,
  },
  {
    label: 'team member inherits edit',
    subject: 'user:alice',
    permission: 'document.read',
    resource: 'document:2',
    expected: true,
  },
  {
    label: 'non-member does not',
    subject: 'user:carol',
    permission: 'document.read',
    resource: 'document:2',
    expected: false,
  },
  {
    label: 'a team is not its members',
    subject: 'team:eng',
    permission: 'document.read',
    resource: 'document:2',
    expected: false,
  },
  {
    label: 'wildcard makes it public',
    subject: 'user:anyone',
    permission: 'document.public',
    resource: 'document:3',
    expected: true,
  },
  {
    label: 'wildcard does not grant write',
    subject: 'user:alice',
    permission: 'document.write',
    resource: 'document:3',
    expected: false,
  },
  {
    label: 'inherits from parent folder',
    subject: 'user:alice',
    permission: 'document.read',
    resource: 'document:4',
    expected: true,
  },
  {
    label: 'parent folder is not leaked',
    subject: 'user:bob',
    permission: 'document.read',
    resource: 'document:4',
    expected: false,
  },
];

let failures = 0;
for (const testCase of cases) {
  const allowed = await authz.can(
    testCase.subject,
    testCase.permission,
    testCase.resource,
  );
  const ok = allowed === testCase.expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${testCase.label.padEnd(32)} ${allowed ? 'allowed' : 'denied'}`,
  );
}

// --- why, not just what ---------------------------------------------------
const result = await authz.explain({
  subject: 'user:carol',
  permission: 'document.read',
  resource: 'document:2',
});
console.log('\nwhy carol is denied:');
console.log(result.allowed ? '  (allowed)' : `  (denied after ${result.reads} reads)`);

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log(`\nall ${cases.length} cases passed`);
