import { Hono } from 'hono';
import type { Authz } from 'tsbouncer';
import { caller, type Env, identify, requirePermission } from './auth.js';
import { assignableRoles, documents, relationForRole } from './data.js';
import { HttpError, onError } from './http.js';

/**
 * The whole API, in one file.
 *
 * The rule every route below obeys, in this order:
 *
 *   1. who is calling          — `caller()`, 401 if nobody
 *   2. are they allowed        — `requirePermission()`, 403 if not
 *   3. does the row exist      — 404 only for someone who was allowed to ask
 *   4. do the work, and write  — and every write goes through the model
 *
 * The 403-before-404 order is the one worth copying. A caller who may not read a
 * document learns nothing about whether it exists, so the API cannot be used to
 * enumerate other people's data. Most hand-written permission checks get this
 * backwards and hand out a free existence oracle.
 */
export function createApp(authz: Authz): Hono<Env> {
  const app = new Hono<Env>();
  app.onError(onError);
  app.use('*', identify(authz));

  app.get('/health', (c) => c.json({ ok: true }));

  /**
   * What can this person read?
   *
   * `listResources` asks the graph rather than filtering a list of rows in
   * application code, so the answer is correct for every rule the model declares —
   * including a rule added next week that nobody remembers to write a query for.
   *
   * The result is `{ resources, truncated }`, not a bare array. A budget that runs
   * out mid-enumeration produces a partial list, and a plain array cannot tell you
   * that — so the field is returned even when it is `false`, and a client that
   * pages through everything is expected to read it.
   */
  app.get('/api/documents', async (c) => {
    const subject = caller(c);
    const { resources, truncated } = await authz.listResources({
      subject,
      permission: 'document.read',
    });
    const ids = resources.map((reference) => reference.slice('document:'.length));
    return c.json({ documents: documents.findMany(ids), truncated });
  });

  app.get('/api/documents/:id', async (c) => {
    const id = c.req.param('id');
    await requirePermission(c, 'document.read', `document:${id}`);
    const document = documents.find(id);
    if (document === undefined)
      throw new HttpError(404, 'not_found', `no document ${id}`);
    return c.json(document);
  });

  /**
   * Create a document.
   *
   * Any authenticated caller may create one, and the creator becomes its owner in
   * the same request. Two writes, in a fixed order: the row first, so a failure
   * leaves an orphan grant rather than a document nobody can see.
   */
  app.post('/api/documents', async (c) => {
    const subject = caller(c);
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    const title =
      typeof body.title === 'string' && body.title !== '' ? body.title : 'Untitled';
    if (documents.find(documents.nextId()) !== undefined) {
      throw new HttpError(409, 'conflict', 'document id already exists');
    }

    const document = documents.insert({
      id: documents.nextId(),
      title,
      body: '',
    });
    await authz.grant({
      subject,
      relation: 'owner',
      resource: `document:${document.id}`,
    });
    return c.json(document, 201);
  });

  app.patch('/api/documents/:id', async (c) => {
    const id = c.req.param('id');
    await requirePermission(c, 'document.write', `document:${id}`);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: unknown;
      body?: unknown;
    };
    return c.json(
      documents.update(id, {
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.body === 'string' ? { body: body.body } : {}),
      }),
    );
  });

  /**
   * Hand a document to a role.
   *
   * `document.manage` is owned by the owner, never by an editor: this route
   * changes who can read the document, so it is not the same permission as
   * changing what the document says.
   *
   * The grant is one tuple whose subject is the *holders of a role*. Bob gains
   * access to every document this is applied to, and to every document it is
   * applied to in future, without any of them being touched again.
   *
   * Note the `#holder` on the subject: the model's userset edge walks the `holder`
   * relation, so the tuple has to name the userset, not the role object. Writing
   * `role:acme:editor` here is rejected by write-time validation.
   */
  app.post('/api/documents/:id/roles', async (c) => {
    const id = c.req.param('id');
    await requirePermission(c, 'document.manage', `document:${id}`);

    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown };
    if (typeof body.role !== 'string') {
      throw new HttpError(
        400,
        'invalid_role',
        `expected one of: ${Object.keys(assignableRoles).join(', ')}`,
      );
    }
    const relation = relationForRole(body.role);
    if (relation === undefined) {
      throw new HttpError(400, 'invalid_role', `unknown role ${body.role}`);
    }

    await authz.grant({
      subject: `role:${body.role}#holder`,
      relation,
      resource: `document:${id}`,
    });
    return c.json(
      {
        granted: {
          subject: `role:${body.role}#holder`,
          relation,
          resource: `document:${id}`,
        },
      },
      201,
    );
  });

  /** Take a role away again. Revoking is a first-class operation, not a rewrite. */
  app.delete('/api/documents/:id/roles/:role', async (c) => {
    const id = c.req.param('id');
    const role = c.req.param('role');
    await requirePermission(c, 'document.manage', `document:${id}`);

    const relation = relationForRole(role);
    if (relation === undefined)
      throw new HttpError(400, 'invalid_role', `unknown role ${role}`);

    await authz.revoke({
      subject: `role:${role}#holder`,
      relation,
      resource: `document:${id}`,
    });
    return c.body(null, 204);
  });

  /**
   * Why?
   *
   * `explain()` returns the whole decision tree — which relations were tried, what
   * each one resolved to, and how many store reads it took. This is the tool for
   * the question that actually gets asked in support ("why can't this person see
   * that?"), and it needs no debugging and no logging, because the answer is
   * computed from the same evaluation that produced the refusal.
   */
  app.get('/api/documents/:id/why', async (c) => {
    const id = c.req.param('id');
    await requirePermission(c, 'document.read', `document:${id}`);
    const result = await authz.explain({
      subject: caller(c),
      permission: 'document.read',
      resource: `document:${id}`,
    });
    return c.json(result);
  });

  return app;
}
