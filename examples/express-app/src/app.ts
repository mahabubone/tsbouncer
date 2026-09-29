import { type Authz, isAuthorizationError } from '@tsbouncer/core';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {
  type Caller,
  type Document,
  docRef,
  documents,
  folders,
  userRef,
  workspaceRef,
  workspaces,
} from './data.js';

/**
 * A documents API for a multi-tenant product, using all three authorization
 * styles at once.
 *
 * What is deliberately absent: middleware, a `requirePermission` wrapper, and any
 * Express import in `packages/`. Those are decisions an app makes, and an app with
 * a REST API, a GraphQL endpoint, and a queue consumer rarely wants the same one.
 * What follows is the wiring a real app would write, at the point where the
 * decision is actually needed.
 */

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
const notFound = (message: string) => new HttpError(404, 'not_found', message);

/**
 * Identity and request state, which is where ABAC input comes from.
 *
 * A real deployment reads a session cookie and a token here and looks the caller
 * up. The library has no opinion on any of it, which is why it can sit inside an
 * Express app without owning the request lifecycle.
 */
function callerOf(req: Request): Caller {
  const userId = req.header('x-user-id');
  if (userId === undefined || userId === '') {
    throw new HttpError(401, 'unauthenticated', 'x-user-id header required');
  }
  const region = req.header('x-region');
  if (region !== 'eu' && region !== 'us') {
    throw badRequest('x-region header must be eu or us');
  }
  return {
    userId,
    region,
    suspended: req.header('x-suspended') === 'true',
  };
}

const documentById = (id: string): Document => {
  const found = documents.find((d) => d.id === id);
  if (found === undefined) throw notFound(`no document ${id}`);
  return found;
};

export function createApp(authz: Authz): Express {
  const app = express();
  app.use(express.json());

  /** ABAC context, assembled once per request from what the caller is. */
  const contextOf = (caller: Caller) => ({
    callerRegion: caller.region,
    suspended: caller.suspended,
  });

  app.get('/api/v1/me', async (req, res) => {
    const caller = callerOf(req);
    const { resources } = await authz.listResources({
      subject: userRef(caller.userId),
      permission: 'document.read',
      context: contextOf(caller),
    });
    res.json({
      userId: caller.userId,
      region: caller.region,
      suspended: caller.suspended,
      readableDocumentIds: resources.map((r) => r.slice('document:'.length)).sort(),
    });
  });

  /**
   * ReBAC + inherited permissions. `listResources` answers "everything I can
   * read", including what reaches me through a folder or a role, so this is one
   * query rather than a scan with a `can()` per row.
   */
  app.get('/api/v1/documents', async (req, res) => {
    const caller = callerOf(req);
    const { resources, truncated } = await authz.listResources({
      subject: userRef(caller.userId),
      permission: 'document.read',
      context: contextOf(caller),
    });

    res.json({
      documents: resources
        .map((r) => documents.find((d) => docRef(d.id) === r))
        .filter((d): d is Document => d !== undefined),
      truncated,
    });
  });

  app.get('/api/v1/documents/:id', async (req, res) => {
    const caller = callerOf(req);
    const doc = documentById(String(req.params.id));

    const decision = await authz.check(
      {
        subject: userRef(caller.userId),
        permission: 'document.read',
        resource: docRef(doc.id),
      },
      { context: contextOf(caller) },
    );

    if (!decision.allowed) throw new HttpError(403, 'forbidden', 'forbidden');
    res.json(doc);
  });

  /**
   * ReBAC + exclusion. `write` requires owner *and* editor and is not revocable by
   * a ban, and a document on legal hold is refused by the app rather than by the
   * graph — two different questions, asked in two different places.
   */
  app.patch('/api/v1/documents/:id', async (req, res) => {
    const caller = callerOf(req);
    const doc = documentById(String(req.params.id));
    const title = (req.body as { title?: unknown } | undefined)?.title;
    if (typeof title !== 'string') throw badRequest('expected { title: string }');

    await authz.assert(
      {
        subject: userRef(caller.userId),
        permission: 'document.write',
        resource: docRef(doc.id),
      },
      { context: contextOf(caller) },
    );
    if (doc.onHold === true) {
      throw new HttpError(409, 'on_hold', 'document is on legal hold');
    }

    res.json({ ...doc, title });
  });

  /**
   * RBAC. Attaching a role to a document is one write, and it grants the
   * permission to everyone holding that role without the document naming them.
   */
  app.post('/api/v1/documents/:id/roles', async (req, res) => {
    const caller = callerOf(req);
    const doc = documentById(String(req.params.id));
    const role = (req.body as { role?: unknown } | undefined)?.role;
    const relation =
      (req.body as { relation?: unknown } | undefined)?.relation ?? 'editor';
    if (typeof role !== 'string' || typeof relation !== 'string') {
      throw badRequest('expected { role: string, relation?: string }');
    }

    await authz.assert(
      {
        subject: userRef(caller.userId),
        permission: 'document.write',
        resource: docRef(doc.id),
      },
      { context: contextOf(caller) },
    );

    // A userset edge takes a userset subject, so the grant names the role
    // qualified by the relation the edge walks. An unknown `relation` is
    // rejected by the model at write time — a 400, not a 403.
    await authz.grant({
      subject: `role:${role}#holder`,
      relation,
      resource: docRef(doc.id),
    });
    res.status(201).json({ attached: `role:${role}#${relation}`, to: docRef(doc.id) });
  });

  /**
   * The reverse direction, and the one that makes a role worth having: give
   * someone the role, and every document already carrying it changes answer. No
   * document is touched.
   */
  app.post('/api/v1/roles/:role/holders', async (req, res) => {
    const caller = callerOf(req);
    const userId = (req.body as { userId?: unknown } | undefined)?.userId;
    if (typeof userId !== 'string') throw badRequest('expected { userId: string }');

    const target = userRef(userId);
    const decision = await authz.check(
      {
        subject: userRef(caller.userId),
        permission: 'workspace.administer',
        resource: workspaceRef('acme'),
      },
      { context: contextOf(caller) },
    );
    if (!decision.allowed) throw new HttpError(403, 'forbidden', 'forbidden');

    await authz.grant({
      subject: target,
      relation: 'holder',
      resource: `role:${String(req.params.role)}`,
    });
    res.status(201).json({ granted: `role:${String(req.params.role)}`, to: target });
  });

  app.get('/api/v1/workspaces/:id', async (req, res) => {
    const caller = callerOf(req);
    const id = String(req.params.id);
    const workspace = workspaces.find((w) => w.id === id);
    if (workspace === undefined) throw notFound(`no workspace ${id}`);

    const decision = await authz.check(
      {
        subject: userRef(caller.userId),
        permission: 'workspace.administer',
        resource: workspaceRef(id),
      },
      { context: contextOf(caller) },
    );
    if (!decision.allowed) throw new HttpError(403, 'forbidden', 'forbidden');
    res.json(workspace);
  });

  /**
   * "Why can't they open it?" Every leaf cites the tuples that produced it or the
   * query that came back empty, so the answer names the edge that failed instead
   * of guessing. The tree is plain JSON for a support UI; the text is a view of
   * the same structure, so the two cannot disagree.
   */
  app.get('/api/v1/documents/:id/why', async (req, res) => {
    // Evaluated with the *asking* caller's context, because the question is
    // "why can't I open this" and a trace computed without the caller's own state
    // would explain a decision nobody made.
    const caller = callerOf(req);
    const target = String(req.query.subject ?? '');
    if (target === '') throw badRequest('expected ?subject=user:alice');

    const doc = documentById(String(req.params.id));
    const result = await authz.explain(
      {
        subject: target,
        permission: String(req.query.permission ?? 'document.read'),
        resource: docRef(doc.id),
      },
      { context: contextOf(caller) },
    );

    res.json({
      subject: target,
      askedBy: userRef(caller.userId),
      allowed: result.allowed,
      reads: result.reads,
      trace: result.tree,
    });
  });

  /** The folder tree, so a caller can see how inheritance reaches a document. */
  app.get('/api/v1/folders/:id/children', (req, res) => {
    const id = String(req.params.id);
    const folder = folders.find((f) => f.id === id);
    if (folder === undefined) throw notFound(`no folder ${id}`);
    res.json({ folder, children: folders.filter((f) => f.parentId === id) });
  });

  /**
   * One error handler, and the distinction that matters.
   *
   * `isAuthorizationError` is true for a *denied check* and also for a *rejected
   * write*, and mapping both to 403 is how a typo in a request body reports itself
   * as "you are not allowed", with nothing in the logs to say the server is at
   * fault. Branch on `code`.
   */
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (isAuthorizationError(err)) {
      if (err.code === 'invalid_tuple') {
        res.status(400).json({ error: err.code, message: err.message });
        return;
      }
      if (err.code === 'access_denied') {
        res.status(403).json({ error: err.code, message: err.message });
        return;
      }
      // `evaluation_limit` and friends: the library is confused, so it said no.
      // Fail closed, but say so in the log — this is the one that means "we do
      // not actually know", and an operator needs to see it.
      console.error('authorization failed closed:', err);
      res.status(403).json({ error: err.code, message: err.message });
      return;
    }
    console.error('unhandled error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
