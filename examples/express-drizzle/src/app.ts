import { drizzleStore } from '@tsbouncer/drizzle';
import type { Authz } from '@tsbouncer/tsbouncer';
import { eq } from 'drizzle-orm';
import express, { type Express } from 'express';
import type { Db } from './db/index.js';
import { documents, folders, projects, tsbouncerTuples } from './db/schema.js';
import {
  authzOf,
  callerOf,
  contextFor,
  errorHandler,
  HttpError,
  identify,
  type Permission,
  requirePermission,
} from './http.js';

/**
 * The API.
 *
 * Every route follows the same three steps, and the order is the point:
 *
 *   1. resolve the caller               — `identify`, 401 if nobody
 *   2. ask the model                    — `requirePermission`, 403 if not
 *   3. touch the database               — with Drizzle, and only now
 *
 * The application owns steps 1 and 3 entirely. This library is step 2, and it is
 * step 2 only: no middleware, no router, no session, no HTTP types. If it had an
 * Express adapter you would be able to swap the framework and not the policy; as it
 * is, swapping the framework does not touch a line of authorization.
 */
export function createApp(db: Db, authz: Authz): Express {
  const app = express();
  app.use(express.json());
  app.use(identify(db, authz));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  /* --- the query API, used as routes -------------------------------------- */

  app.get('/api/v1/projects/:id', async (req, res) => {
    const id = req.params.id;
    await requirePermission(req, 'project.read', `project:${id}`);

    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    if (row === undefined) throw new HttpError(404, 'not_found', `no project ${id}`);
    res.json(row);
  });

  /**
   * Renaming a project needs `project.write`, which the editor role carries and
   * the viewer role does not. The row is a plain Drizzle update — the store is not
   * involved at all, because nothing about *what* changed is authorization's
   * business.
   */
  app.patch('/api/v1/projects/:id', async (req, res) => {
    const id = req.params.id;
    await requirePermission(req, 'project.write', `project:${id}`);

    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    if (row === undefined) throw new HttpError(404, 'not_found', `no project ${id}`);

    const name = typeof req.body?.name === 'string' ? req.body.name : row.name;
    db.update(projects).set({ name }).where(eq(projects.id, id)).run();
    res.json(db.select().from(projects).where(eq(projects.id, id)).get());
  });

  /**
   * What can this person read, right now?
   *
   * A reverse walk of the graph rather than a `WHERE` clause over the documents
   * table, so the answer is correct for every rule the model declares — including
   * the ones inherited down a folder tree, the wildcard, the ban, and the three
   * conditions. A hand-written list route has to be rewritten every time a rule is
   * added, and the rewrite is the bug.
   *
   * `truncated` is part of the answer, not a footnote. The walk is budgeted, and a
   * budget that runs out mid-enumeration gives a partial list — a bare array could
   * not tell you that, so the flag is returned even when it is `false`. A client
   * that wants the whole set pages; a client that ignores the flag is trusting a
   * number that may be wrong, which is the one thing a list endpoint must not do.
   */
  app.get('/api/v1/me/documents', async (req, res) => {
    const caller = callerOf(req);
    const { resources, truncated } = await authz.listResources({
      subject: `user:${caller.userId}`,
      permission: 'document.read',
      context: contextFor(caller),
    });

    const ids = resources.map((ref) => ref.slice('document:'.length));
    const rows = ids.flatMap((id) => {
      const row = db.select().from(documents).where(eq(documents.id, id)).get();
      return row === undefined ? [] : [row];
    });
    res.json({ documents: rows, truncated });
  });

  app.get('/api/v1/documents/:id', async (req, res) => {
    const id = req.params.id;
    await requirePermission(req, 'document.read', `document:${id}`);

    const row = db.select().from(documents).where(eq(documents.id, id)).get();
    if (row === undefined) throw new HttpError(404, 'not_found', `no document ${id}`);
    res.json(row);
  });

  app.patch('/api/v1/documents/:id', async (req, res) => {
    const id = req.params.id;
    await requirePermission(req, 'document.write', `document:${id}`);

    const row = db.select().from(documents).where(eq(documents.id, id)).get();
    if (row === undefined) throw new HttpError(404, 'not_found', `no document ${id}`);

    /**
     * Legal hold is row state, not an edge — which is exactly why it is not a
     * condition. A condition's unbound parameters come from the request, so a hold
     * enforced by one would be enforced by a value the caller supplies. The
     * application reads its own column and refuses, and the model never has to know
     * that legal hold exists.
     */
    if (row.onHold) {
      throw new HttpError(423, 'locked', `document ${id} is under legal hold`);
    }

    const title = typeof req.body?.title === 'string' ? req.body.title : row.title;
    db.update(documents).set({ title }).where(eq(documents.id, id)).run();
    res.json(db.select().from(documents).where(eq(documents.id, id)).get());
  });

  /**
   * Move a document, and rewrite the access path with it, in one transaction.
   *
   * This is the reason the store takes a `TupleStore` and not a global: a move
   * touches two things that must agree — the `documents.folder_id` column, and the
   * `parent` relation that authorization walks. Update one without the other and you
   * have either an orphaned grant or a document whose access nobody can explain.
   *
   * The mechanics are the one sharp edge in this example. `better-sqlite3` is a
   * synchronous driver, and Drizzle *rejects* a transaction callback that returns a
   * promise — while on an async driver the same callback would commit before its
   * `await` resolved if it did not wait. So the callback issues the write without
   * returning the promise, and the promise is awaited after. The store detects
   * which kind of driver it is holding rather than assuming, and refuses to start on
   * a client it does not recognise.
   */
  app.post('/api/v1/documents/:id/move', async (req, res) => {
    const id = req.params.id;
    const folderId =
      typeof req.body?.folderId === 'string' ? req.body.folderId : undefined;
    if (folderId === undefined)
      throw new HttpError(400, 'invalid_body', 'folderId required');

    // Two permissions, two resources: you may move what you manage, into somewhere
    // you may write. Both are asked before anything is written.
    await requirePermission(req, 'document.manage', `document:${id}`);
    await requirePermission(req, 'folder.write', `folder:${folderId}`);

    const row = db.select().from(documents).where(eq(documents.id, id)).get();
    if (row === undefined) throw new HttpError(404, 'not_found', `no document ${id}`);
    const target = db.select().from(folders).where(eq(folders.id, folderId)).get();
    if (target === undefined)
      throw new HttpError(404, 'not_found', `no folder ${folderId}`);

    let pending: Promise<unknown> | undefined;
    db.transaction((tx) => {
      tx.update(documents).set({ folderId }).where(eq(documents.id, id)).run();
      // The old edge goes, the new one arrives. A filter delete rather than a
      // revoke, because the reference being removed is the one on the tuple.
      void drizzleStore(tx, tsbouncerTuples).delete({
        kind: 'filter',
        query: { resource: `document:${id}`, relation: 'parent' },
      });
      pending = drizzleStore(tx, tsbouncerTuples).write({
        tuples: [
          {
            subject: `folder:${folderId}`,
            relation: 'parent',
            resource: `document:${id}`,
          },
        ],
      });
    });
    await pending;

    res.json(db.select().from(documents).where(eq(documents.id, id)).get());
  });

  /* --- changing access ---------------------------------------------------- */

  /**
   * Attach a role to a document.
   *
   * `document.manage`, not `document.write`. A document whose access list any editor
   * can change is a document whose contents any editor can leak.
   */
  app.post('/api/v1/documents/:id/roles', async (req, res) => {
    const id = req.params.id;
    await requirePermission(req, 'document.manage', `document:${id}`);

    const role = typeof req.body?.role === 'string' ? req.body.role : undefined;
    if (role === undefined) throw new HttpError(400, 'invalid_body', 'role required');

    // The relation is derived from the role id and checked against the model, so a
    // request body cannot invent a relation the model does not declare. The write
    // below validates it again — two checks, because one of them is a user-facing
    // error and the other is the model refusing to store nonsense.
    const relation = role.split(':').pop() ?? '';
    const declared = authzOf(req).relations('document');
    if (!declared.includes(relation)) {
      throw new HttpError(400, 'invalid_tuple', `document has no relation ${relation}`);
    }

    await authzOf(req).grant({
      subject: `role:${role}#holder`,
      relation,
      resource: `document:${id}`,
    });
    res
      .status(201)
      .json({ subject: `role:${role}#holder`, relation, resource: `document:${id}` });
  });

  /**
   * Segregation of duties, in two halves.
   *
   * The model's `document.publish` is the dual-key rule: you need to be the owner
   * *and* an approver, so a compromised owner account cannot publish alone. That is
   * an intersection of two relations on the same document, and it is all the model
   * can say.
   *
   * The part it cannot say is "and someone *else* must agree", because whether two
   * holders are the same person is a property of a request, not of a permission. So
   * the route asks the second question: `document.approve` names the people who may
   * countersign, `listSubjects` returns them, and this handler refuses if the
   * countersigner is the caller.
   */
  app.post('/api/v1/documents/:id/publish', async (req, res) => {
    const id = req.params.id;
    const caller = callerOf(req);
    await requirePermission(req, 'document.publish', `document:${id}`);

    const approvers = await authzOf(req).listSubjects({
      permission: 'document.approve',
      resource: `document:${id}`,
    });
    const approvedBy = req.body?.approvedBy;
    if (
      typeof approvedBy !== 'string' ||
      !approvers.members.includes(`user:${approvedBy}`)
    ) {
      throw new HttpError(403, 'approval_required', 'an approver must countersign this');
    }
    if (approvedBy === caller.userId) {
      throw new HttpError(403, 'four_eyes', 'an approver may not be the publisher');
    }

    res.json({ published: true, approvedBy, dualKey: true });
  });

  /* --- diagnostics -------------------------------------------------------- */

  /**
   * Why not?
   *
   * `explain()` returns the decision tree: every relation tried, what each resolved
   * to, and how many store reads it took. This is the support question — "why can't
   * this person see that?" — answered from the same evaluation that produced the
   * refusal, with no logging and no reproduction.
   *
   * Note what this route does *not* do: it does not require the permission it is
   * explaining. The tree describes the caller's own request and nothing else, and
   * the moment you need it most is when the answer was "no". Gating it on the
   * outcome would mean the only decisions you can explain are the ones that worked.
   */
  app.get('/api/v1/documents/:id/why', async (req, res) => {
    const id = req.params.id;
    const caller = callerOf(req);

    const asked = req.query.permission ?? 'document.read';
    if (typeof asked !== 'string') {
      throw new HttpError(400, 'invalid_query', 'permission must be a string');
    }

    /*
     * An undeclared permission is a client error, not a denial. `explain` would
     * happily return `allowed: false` for a permission that does not exist, and a
     * typo in a query string would read as a policy decision.
     *
     * `permissions(type)` returns bare names — `read`, not `document.read` — so
     * this compares the last segment. Worth knowing before you build a
     * "valid permission" check on top of it.
     */
    const bare = asked.split('.').pop() ?? asked;
    if (!authzOf(req).permissions('document').includes(bare)) {
      throw new HttpError(
        400,
        'unknown_permission',
        `document has no permission ${bare}`,
      );
    }

    res.json(
      await authzOf(req).explain(
        {
          subject: `user:${caller.userId}`,
          permission: asked as Permission,
          resource: `document:${id}`,
        },
        { context: contextFor(caller) },
      ),
    );
  });

  /**
   * Who can see this?
   *
   * `listSubjects` is **symbolic**, and the distinction is the whole point: a
   * published document has `user:*` on it, and the answer says
   * `allOfTypes: ['user']` — every user — rather than inventing a list of everyone
   * in the database. A set that claims to be exhaustive and is not is the
   * list-shaped version of a fail-open bug.
   */
  app.get('/api/v1/documents/:id/who', async (req, res) => {
    const id = req.params.id;
    await requirePermission(req, 'document.read', `document:${id}`);
    res.json(
      await authzOf(req).listSubjects({
        permission: 'document.read',
        resource: `document:${id}`,
        context: contextFor(callerOf(req)),
      }),
    );
  });

  /**
   * Everyone in a team, transitively.
   *
   * `expand` is the concrete counterpart to the symbolic one above: a userset has a
   * finite membership, so it can be listed exactly. A wildcard expands to itself
   * rather than to a fabricated roster.
   */
  app.get('/api/v1/teams/:id/members', async (req, res) => {
    const id = req.params.id;
    const result = await authzOf(req).expand({ subject: `team:${id}#member` });
    res.json(result);
  });

  return app;
}

/**
 * Registered last, and that ordering is not cosmetic. Express picks the error
 * handler by walking the stack *after* the failing route, so a handler mounted
 * before the routes never sees anything: every `throw` became a default HTML 500
 * with a stack trace in the response body. Register it after `createApp` returns.
 */
export function withErrorHandling(app: Express): Express {
  app.use(errorHandler);
  return app;
}
