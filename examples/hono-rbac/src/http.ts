import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The application owns its HTTP layer.
 *
 * This library decides who may do what; it has no opinion about status codes, and
 * it never throws through to a framework. So an error class and one handler is
 * the entire integration: a route throws something with a status, and this turns
 * it into a response. Everything unrecognised becomes a 500 with no detail,
 * because a stack trace is not a client-facing message.
 */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

export const onError: ErrorHandler = (error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  // A bug, not a policy decision. Log it here, return nothing useful to the caller.
  console.error(error);
  return c.json({ error: 'internal_error' }, 500);
};
