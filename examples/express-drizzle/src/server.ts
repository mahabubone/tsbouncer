import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Authz, createAuthz } from '@tsbouncer/core';
import { createApp, withErrorHandling } from './app.js';
import { type Handle, openDatabase } from './db/index.js';
import * as schema from './db/schema.js';
import { model } from './model.js';
import * as seed from './seed.js';

/**
 * Booting the app: migrate, seed, listen, hand back a base URL.
 *
 * Port 0 asks the OS for a free port, so a suite can start this as many times as it
 * likes without coordinating and without a fixed port going stale.
 */
export interface AppHandle {
  readonly baseUrl: string;
  readonly authz: Authz;
  readonly db: Handle['db'];
  close(): Promise<void>;
}

export interface StartOptions {
  /** Write the fixture rows and the access graph on boot. Default true. */
  readonly seed?: boolean;
}

export async function startApp(
  file: string,
  options: StartOptions = {},
): Promise<AppHandle> {
  const handle = openDatabase(file);
  const authz = createAuthz({ model, store: handle.store });

  if (options.seed ?? true) {
    /**
     * The two halves of the fixture, inserted the way each belongs.
     *
     * The domain rows go in as plain Drizzle inserts — `db.insert(table).values()`,
     * which is the ordinary way this application writes its own data. The access
     * graph goes in through `authz.write`, because that is the only path that runs
     * write-time model validation, and a tuple naming a relation the model does not
     * declare should fail here at boot rather than deny access silently for ever.
     *
     * That is worth the two different code paths: one insert shape the ORM knows
     * about, and one the model knows about, and the model is the stricter of the two.
     */
    const { db } = handle;
    db.insert(schema.organizations).values(seed.organizations).run();
    db.insert(schema.users).values(seed.users).run();
    db.insert(schema.projects).values(seed.projects).run();
    db.insert(schema.folders).values(seed.folders).run();
    db.insert(schema.documents).values(seed.documents).run();
    await authz.write(seed.tuples);
  }

  const server = createServer(withErrorHandling(createApp(handle.db, authz)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    authz,
    db: handle.db,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      handle.close();
    },
  };
}

/** Boot against an existing file without re-seeding — what a real deployment does. */
export function openServer(file: string): Promise<AppHandle> {
  return startApp(file, { seed: false });
}

/** One request, the way a client would make it. */
export async function call(
  baseUrl: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  headers: Readonly<Record<string, string>> = {},
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: parse(text) };
}

/**
 * A real client's problem, not a test's: a framework's own 404 is HTML, and a
 * helper that assumes JSON turns a routing mistake into a parse error with the
 * actual cause nowhere in the message.
 */
function parse(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}
