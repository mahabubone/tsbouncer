import type { Authz, ModelShapeOf, PermissionOf } from '@tsbouncer/tsbouncer';
import type { Context, MiddlewareHandler } from 'hono';
import { HttpError } from './http.js';
import type { model } from './model.js';

/**
 * Every permission string the model declares, as a type.
 *
 * `PermissionOf` reads the keys of `typeof model`, so a renamed or deleted
 * permission stops compiling at the call site instead of becoming a 403 that
 * nobody can explain. This is the whole ergonomic argument for declaring the model
 * with `defineModel` rather than a plain object.
 */
export type Permission = PermissionOf<ModelShapeOf<typeof model>>;

export interface Env {
  readonly Variables: {
    readonly authz: Authz;
    /**
     * Undefined for an anonymous request. The distinction matters: anonymous is
     * 401, authenticated-but-refused is 403, and conflating them tells a user to
     * log in when logging in will not help.
     */
    readonly subject: string | undefined;
  };
}

/**
 * Identity, and nothing else.
 *
 * A real app reads a session, a verified token, or a trusted header from a
 * gateway. All of that ends the same way: one string, `user:alice`, in a context
 * variable. Authorization starts from that string and nothing else — the library
 * has no opinion on how you authenticated, and deliberately no way to be told.
 */
export function identify(authz: Authz): MiddlewareHandler<Env> {
  return async (c, next) => {
    c.set('authz', authz);
    const id = c.req.header('x-user-id');
    c.set('subject', id === undefined || id === '' ? undefined : `user:${id}`);
    await next();
  };
}

/** The caller's reference, or a 401. Call this first in every route. */
export function caller(c: Context<Env>): string {
  const subject = c.get('subject');
  if (subject === undefined) {
    throw new HttpError(401, 'unauthenticated', 'provide an x-user-id header');
  }
  return subject;
}

/**
 * The only authorization call in this application.
 *
 * Note the order every route follows: **authorize, then look the row up.** A caller
 * who may not read a document gets 403 whether or not that document exists, so
 * the API never becomes an oracle for what is in the database. Inverting those two
 * lines is the most common way an API leaks.
 */
export async function requirePermission(
  c: Context<Env>,
  permission: Permission,
  resource: string,
): Promise<void> {
  const subject = caller(c);
  const allowed = await c.get('authz').can(subject, permission, resource);
  if (!allowed) {
    // Deliberately not saying which permission or which relation. `explain()` gives
    // all of that to someone who is allowed to ask — see the `why` route.
    throw new HttpError(403, 'forbidden', `${permission} on ${resource} is not yours`);
  }
}
