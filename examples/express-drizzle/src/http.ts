import type { Authz, ModelShapeOf, PermissionOf } from '@tsbouncer/tsbouncer';
import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import type { Db } from './db/index.js';
import { organizations, users } from './db/schema.js';
import type { model } from './model.js';

/**
 * Identity, request context, and the one authorization call.
 *
 * Everything the conditions in `model.ts` need is read from the application's own
 * tables. That is the whole safety argument for attribute-based access, and it is
 * worth stating plainly:
 *
 *   **A request may fill in a condition's unbound parameters. So the only safe
 *   source of those parameters is your own database.**
 *
 * The bound ones are different — a grant's own `context` is authoritative and a
 * request cannot overwrite it — but the unbound ones come from here. If this file
 * read `callerRegion` off a query parameter, `sameRegion` would be a suggestion
 * the client ignores at will. The scenario table has a case for exactly that,
 * because it is the mistake everyone makes once.
 */

export type Permission = PermissionOf<ModelShapeOf<typeof model>>;

export interface Caller {
  readonly userId: string;
  readonly suspended: boolean;
  readonly organizationId: string;
  readonly organizationRegion: 'eu' | 'us';
  readonly seatsUsed: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own convention.
  namespace Express {
    interface Request {
      caller?: Caller;
      authz?: Authz;
    }
  }
}

/**
 * Resolve `x-user-id` into everything the request needs to be evaluated with.
 *
 * Two lookups, and the second one is the interesting one. The *tenant* the request
 * is made against is not a property of the user — a user can be acting inside more
 * than one organization — and it is what decides the data region. In production it
 * comes from the host (`acme.example.com`); here it is a header, with a comment
 * because a header is the one thing a client must not be allowed to choose.
 */
export async function resolveCaller(db: Db, req: Request): Promise<Caller> {
  const id = req.header('x-user-id');
  if (id === undefined || id === '') {
    throw new HttpError(401, 'unauthenticated', 'provide an x-user-id header');
  }

  // The user row is application data, not authorization data: it holds the caller's
  // own attributes, which are *read* here and handed to the evaluator. No grant
  // ever names them.
  const user = db.select().from(users).where(eq(users.id, id)).get();
  if (user === undefined) throw new HttpError(401, 'unauthenticated', `no user ${id}`);

  const organizationId = req.header('x-org') ?? 'acme';
  const organization = db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get();
  if (organization === undefined) {
    throw new HttpError(400, 'unknown_organization', `no organization ${organizationId}`);
  }

  return {
    userId: user.id,
    suspended: user.suspended,
    organizationId: organization.id,
    organizationRegion: organization.region,
    seatsUsed: organization.seatsUsed,
  };
}

/**
 * The condition context for one request.
 *
 * Three keys, three conditions. A condition that asks for a key not in here does not
 * fall back to anything — it denies, and says why in `explain()`.
 */
export function contextFor(caller: Caller) {
  return {
    callerRegion: caller.organizationRegion,
    suspended: caller.suspended,
    usedSeats: caller.seatsUsed,
  };
}

export function identify(db: Db, authz: Authz) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      req.caller = await resolveCaller(db, req);
      req.authz = authz;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function callerOf(req: Request): Caller {
  if (req.caller === undefined) throw new HttpError(401, 'unauthenticated');
  return req.caller;
}

export function authzOf(req: Request): Authz {
  if (req.authz === undefined) throw new HttpError(500, 'not_initialized');
  return req.authz;
}

/**
 * The one authorization call, and the ordering rule that goes with it.
 *
 * **Authorize before the row lookup.** A caller who may not read a document gets 403
 * whether or not it exists, so the API cannot be used to enumerate ids. The price is
 * that a 404 only happens for someone who was allowed to ask — which in a real
 * system means "the grant outlived the row", and that is a case worth being able to
 * see rather than a 403 that looks like a policy decision.
 */
export async function requirePermission(
  req: Request,
  permission: Permission,
  resource: string,
): Promise<void> {
  const caller = callerOf(req);
  const allowed = await authzOf(req).can(`user:${caller.userId}`, permission, resource, {
    context: contextFor(caller),
  });
  if (!allowed) {
    throw new HttpError(403, 'forbidden', `${permission} on ${resource} is not yours`);
  }
}

/** A policy denial is a 403; a bug is a 500 with no detail for the caller. */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: 'internal_error' });
}
