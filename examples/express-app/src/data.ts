import type { Tuple } from '@tsbouncer/core';

/**
 * The application's own records.
 *
 * These are *not* authorization data. A real app has a `documents` table with
 * titles, owners, and timestamps; the tuples below are who may do what to it.
 * Keeping them in separate modules is the whole point of opaque references — the
 * engine never resolves `document:1` to a row here, it just evaluates edges.
 */

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly plan: 'free' | 'pro' | 'enterprise';
}

export interface Document {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly region: 'eu' | 'us';
  /** True while the document is in legal hold and may be read but not changed. */
  readonly onHold?: boolean;
}

export interface Folder {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentId: string | undefined;
}

export const workspaces: readonly Workspace[] = [
  { id: 'acme', name: 'Acme Corp', plan: 'enterprise' },
  { id: 'globex', name: 'Globex', plan: 'pro' },
];

export const folders: readonly Folder[] = [
  { id: 'root', workspaceId: 'acme', parentId: undefined },
  { id: 'eng', workspaceId: 'acme', parentId: 'root' },
  { id: 'design', workspaceId: 'acme', parentId: 'root' },
];

export const documents: readonly Document[] = [
  { id: '1', workspaceId: 'acme', title: 'Roadmap', region: 'eu' },
  { id: '2', workspaceId: 'acme', title: 'Hiring plan', region: 'us' },
  { id: '3', workspaceId: 'acme', title: 'Public changelog', region: 'eu' },
  { id: '4', workspaceId: 'acme', title: 'Design notes', region: 'eu' },
  { id: '5', workspaceId: 'acme', title: 'Vendor contract', region: 'us', onHold: true },
  { id: '6', workspaceId: 'globex', title: 'Pricing', region: 'us' },
];

/** Who is calling. In a real app this is a session; here it is request state. */
export interface Caller {
  readonly userId: string;
  readonly region: 'eu' | 'us';
  readonly suspended: boolean;
}

export const docRef = (id: string) => `document:${id}` as const;
export const folderRef = (id: string) => `folder:${id}` as const;
export const roleRef = (id: string) => `role:${id}` as const;
export const userRef = (id: string) => `user:${id}` as const;
export const teamRef = (id: string) => `team:${id}` as const;
export const workspaceRef = (id: string) => `workspace:${id}` as const;

/**
 * Authorization data, seeded through the public API so write-time model
 * validation runs: a tuple naming a relation the model does not declare fails
 * here, at boot, rather than denying forever at request time.
 *
 * Read the tuples in blocks — they are the fixture that the scenarios in
 * `scenarios.ts` exercise.
 */
export const tuples: readonly Tuple[] = [
  /* RBAC — who holds a role, and which resources carry it. Note that no document
     names a user for these; the document names the role. */
  { subject: userRef('alice'), relation: 'holder', resource: roleRef('acme:admin') },
  { subject: userRef('alice'), relation: 'holder', resource: roleRef('acme:editor') },
  { subject: userRef('bob'), relation: 'holder', resource: roleRef('acme:editor') },
  { subject: userRef('erin'), relation: 'holder', resource: roleRef('acme:viewer') },
  { subject: userRef('root'), relation: 'holder', resource: roleRef('instance:admin') },

  // A userset edge takes a *userset* subject: the role object qualified by the
  // relation the edge walks. So this tuple says "the holders of acme:admin are
  // editors", and the previous block says who holds it.
  { subject: 'role:acme:admin#holder', relation: 'editor', resource: docRef('1') },
  { subject: 'role:acme:editor#holder', relation: 'editor', resource: docRef('1') },

  /* ReBAC — teams */
  { subject: userRef('alice'), relation: 'member', resource: teamRef('platform') },
  { subject: userRef('bob'), relation: 'member', resource: teamRef('platform') },
  { subject: 'team:platform#member', relation: 'editor', resource: docRef('2') },

  /* ReBAC — the folder tree. `eng`'s owner is the platform team, so every
     document in the subtree inherits read *and* write from them. */
  { subject: 'team:platform#member', relation: 'owner', resource: folderRef('eng') },
  { subject: userRef('alice'), relation: 'owner', resource: folderRef('design') },
  { subject: folderRef('eng'), relation: 'parent', resource: docRef('4') },
  { subject: folderRef('design'), relation: 'parent', resource: docRef('5') },

  /* ReBAC — direct ownership and sharing */
  { subject: userRef('alice'), relation: 'owner', resource: docRef('1') },
  { subject: userRef('carol'), relation: 'owner', resource: docRef('5') },
  { subject: userRef('erin'), relation: 'viewer', resource: docRef('5') },
  { subject: userRef('mallory'), relation: 'owner', resource: docRef('2') },
  { subject: userRef('mallory'), relation: 'editor', resource: docRef('2') },
  { subject: userRef('mallory'), relation: 'banned', resource: docRef('2') },

  /* Public. A wildcard on `editor`, so it flows through the same `document.read`
     the routes use rather than a permission nobody queries. */
  { subject: 'user:*', relation: 'editor', resource: docRef('3') },

  /* Workspace-scoped administration */
  { subject: userRef('alice'), relation: 'admin', resource: workspaceRef('acme') },
  {
    subject: 'role:acme:editor#holder',
    relation: 'member',
    resource: workspaceRef('acme'),
  },

  /* Cross-tenant: globex has its own document and nobody from acme reaches it. */
  {
    subject: 'role:instance:admin#holder',
    relation: 'admin',
    resource: workspaceRef('globex'),
  },
  { subject: userRef('root'), relation: 'owner', resource: docRef('6') },

  /* ABAC — the writer bound the region; the caller supplies their own. Two edges
     on the same document, with different regions, so the same person reads one
     and not the other. */
  {
    subject: userRef('dave'),
    relation: 'viewer',
    resource: docRef('1'),
    condition: 'sameRegion',
    context: { region: 'eu' },
  },
  {
    subject: userRef('dave'),
    relation: 'viewer',
    resource: docRef('2'),
    condition: 'sameRegion',
    context: { region: 'us' },
  },

  /* ABAC — decided entirely by request state. A suspended account loses the
     grant it would otherwise have, and the tuple is untouched. */
  {
    subject: userRef('erin'),
    relation: 'viewer',
    resource: docRef('1'),
    condition: 'notSuspended',
  },
];
