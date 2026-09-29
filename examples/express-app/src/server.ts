import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Authz, createAuthz } from '@tsbouncer/core';
import { jsonStore } from '@tsbouncer/json';
import { createTupleTableSql, kyselyStore } from '@tsbouncer/kysely';
import { memoryStore } from '@tsbouncer/memory';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { createApp } from './app.js';
import { tuples } from './data.js';
import { model } from './model.js';

/**
 * Booting the app: seed, listen, hand back a base URL.
 *
 * Port 0 asks the OS for a free port, so a suite can start this as many times as
 * it likes without coordinating and without a fixed port going stale.
 */
export type StoreName = 'memory' | 'json' | 'sqlite';

export interface AppHandle {
  readonly baseUrl: string;
  readonly authz: Authz;
  close(): Promise<void>;
}

async function buildStore(
  store: StoreName,
  file: string,
): Promise<{ authz: Authz; close: () => Promise<void> }> {
  if (store === 'memory') {
    // The same app, with no persistence at all. Proving a route works against
    // three backends is stronger than proving it against one, and this is free.
    return {
      authz: createAuthz({ model, store: memoryStore() }),
      close: async () => {},
    };
  }
  if (store === 'json') {
    return {
      authz: createAuthz({ model, store: jsonStore({ file }) }),
      close: async () => {},
    };
  }

  // The adapter ships its own DDL, so the app's migration and its authorization
  // schema cannot drift apart.
  const raw = new Database(file);
  raw.exec(createTupleTableSql('sqlite'));
  const db = new Kysely<unknown>({ dialect: new SqliteDialect({ database: raw }) });

  return {
    authz: createAuthz({ model, store: kyselyStore(db) }),
    close: async () => {
      await db.destroy();
      raw.close();
    },
  };
}

export async function startApp(store: StoreName, file: string): Promise<AppHandle> {
  const { authz, close } = await buildStore(store, file);

  // Through the public API, so write-time model validation runs: a tuple naming a
  // relation the model does not declare fails here rather than denying forever.
  await authz.write(tuples);

  const server = createServer(createApp(authz));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    authz,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await close();
    },
  };
}

/** One request, the way a client would make it. */
export async function call(
  baseUrl: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  headers: Readonly<Record<string, string>> = {},
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}
