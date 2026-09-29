import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { type Authz, createAuthz, jsonStore } from 'tsbouncer';
import { createApp } from './app.js';
import { seed } from './data.js';
import { model } from './model.js';

/**
 * Booting the app: open a file, seed it, listen, hand back a base URL.
 *
 * Port 0 asks the OS for a free port, so a suite can start this as many times as
 * it likes without coordinating and without a fixed port going stale.
 */
export interface AppHandle {
  readonly baseUrl: string;
  readonly authz: Authz;
  close(): Promise<void>;
}

export interface StartOptions {
  /**
   * Write the seed tuples on boot. Default true, because the tour wants a
   * populated file.
   *
   * Production boot does not seed, and neither does a second process opening the
   * same file — it already has the data. Seeding twice is not a no-op: `insert`
   * mode rejects a duplicate, which is the store doing its job.
   */
  readonly seed?: boolean;
}

export async function startApp(
  file: string,
  options: StartOptions = {},
): Promise<AppHandle> {
  /**
   * One line, and it is the whole storage story.
   *
   * `jsonStore` reads the file synchronously while constructing and re-writes it
   * atomically after every mutation, so by the time an `await authz.write(...)`
   * resolves the data is on disk. There is no save to forget, and no transaction
   * to lose.
   *
   * A missing file is an empty store, which is what makes a checked-in fixture
   * work: commit `authz.json` and a fresh clone has the same access graph. The
   * *directory* has to exist, though — this store creates a file, not a tree.
   */
  const authz = createAuthz({ model, store: jsonStore({ file }) });

  if (options.seed ?? true) {
    // Through the public API, so write-time model validation runs: a tuple naming a
    // relation the model does not declare fails here rather than denying forever.
    await authz.write(seed);
  }

  const server = serve({ fetch: createApp(authz).fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    authz,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** Boot without seeding — what a real deployment does. */
export function openApp(file: string): Promise<AppHandle> {
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
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}
