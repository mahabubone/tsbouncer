import type { Tuple } from '@tsbouncer/tsbouncer';

/**
 * The seed.
 *
 * Plain tuples, written through `authz.write()` in `server.ts` — which is where
 * write-time model validation runs, so a typo in a relation name fails at boot
 * rather than quietly denying access forever.
 *
 * Read the order here: people are put into roles, and roles are put on documents.
 * Nothing that follows names both a person and a document, which is the property
 * that makes the next hire a one-line change instead of a project.
 *
 * One thing to read twice, because it is the single most common first mistake:
 * the subject of an RBAC grant is a **userset** — `role:acme:editor#holder` — and
 * not the bare role. The `#holder` is the relation the model's userset edge walks,
 * so the tuple reads "the holders of acme:editor are editors of this document",
 * and the block above says who that is. Writing `role:acme:editor` instead is
 * rejected at write time with a message that says exactly this, which is the good
 * kind of mistake to make.
 */
export const seed: readonly Tuple[] = [
  // --- who holds which role -------------------------------------------------
  { subject: 'user:alice', relation: 'holder', resource: 'role:acme:admin' },
  { subject: 'user:bob', relation: 'holder', resource: 'role:acme:editor' },
  { subject: 'user:carol', relation: 'holder', resource: 'role:acme:viewer' },

  // --- what each role may do, per document ---------------------------------
  { subject: 'user:alice', relation: 'owner', resource: 'document:1' },
  { subject: 'user:alice', relation: 'owner', resource: 'document:2' },
  { subject: 'user:alice', relation: 'owner', resource: 'document:4' },

  // Two documents, one write each. Bob can edit both because he holds the role,
  // not because either document knows his name.
  { subject: 'role:acme:editor#holder', relation: 'editor', resource: 'document:1' },
  { subject: 'role:acme:editor#holder', relation: 'editor', resource: 'document:2' },

  { subject: 'role:acme:viewer#holder', relation: 'viewer', resource: 'document:2' },
  { subject: 'role:acme:viewer#holder', relation: 'viewer', resource: 'document:3' },

  // A grant whose row has been hard-deleted. Every system that deletes a row
  // without cleaning up its grants has these, and an API that checks
  // authorization before it looks the row up answers 404 here — which is the
  // whole reason that ordering is worth arguing about.
  { subject: 'user:alice', relation: 'owner', resource: 'document:9' },
];

export interface Document {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/**
 * A stand-in for the documents table.
 *
 * In a real app this is a repository over your ORM, and it is the *only* thing
 * that changes when you swap the in-memory array for a database. The routes below
 * ask the same two questions of it — find by id, list by ids — and the
 * authorization decisions are made somewhere else entirely.
 */
class DocumentRepository {
  private readonly rows: Document[] = [
    { id: '1', title: 'Onboarding', body: 'Day one is paperwork, day two is a laptop.' },
    { id: '2', title: 'Roadmap', body: 'Three things, in priority order.' },
    { id: '3', title: 'Office dog', body: 'Name: Biscuit. Treats: yes.' },
    { id: '4', title: 'Meeting notes', body: 'Weekly. Nobody reads them.' },
  ];

  find(id: string): Document | undefined {
    return this.rows.find((row) => row.id === id);
  }

  /** The documents behind a list of ids, in the order the ids were given. */
  findMany(ids: readonly string[]): Document[] {
    return ids.flatMap((id) => {
      const row = this.find(id);
      return row === undefined ? [] : [row];
    });
  }

  nextId(): string {
    return String(this.rows.length + 1);
  }

  insert(document: Document): Document {
    this.rows.push(document);
    return document;
  }

  update(
    id: string,
    patch: { readonly title?: string; readonly body?: string },
  ): Document {
    const row = this.find(id);
    if (row === undefined) throw new Error(`no document ${id}`);
    Object.assign(row, patch);
    return row;
  }
}

export const documents = new DocumentRepository();

/**
 * The roles this API will attach to a document, and the relation each one grants.
 *
 * A role id is `acme:editor` and the relation it grants is `editor` — the part
 * after the colon. Keeping that mapping in one exported constant is what lets the
 * route below validate a request body without a `switch`, and what makes adding a
 * role a one-line change.
 */
export const assignableRoles = {
  'acme:editor': 'editor',
  'acme:viewer': 'viewer',
} as const satisfies Readonly<Record<string, string>>;

export function relationForRole(role: string): string | undefined {
  return (assignableRoles as Readonly<Record<string, string>>)[role];
}
