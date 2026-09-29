import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scenarios } from '../src/scenarios.js';
import { call, openApp, startApp } from '../src/server.js';

/**
 * The API, verified over real HTTP.
 *
 * A real listening socket and real `fetch` calls. If authorization only worked when
 * invoked in-process — a stubbed store, a direct call into the handler, a
 * supertest shim — this suite is what notices, and it is the only place the Hono
 * wiring itself is covered at all.
 *
 * The scenario table is shared with `src/main.ts`, so the tour and this gate are
 * the same assertions and cannot drift apart.
 */
describe('hono + json file', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tsbouncer-hono-test-'));
    file = join(dir, 'authz.json');
    app = await startApp(file);
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers every scenario in the tour', async () => {
    const failures: string[] = [];

    for (const scenario of scenarios) {
      const { status, body } = await call(
        app.baseUrl,
        scenario.method,
        scenario.path,
        scenario.headers,
        scenario.body,
      );

      if (status !== scenario.expectStatus) {
        failures.push(
          `${scenario.label}: status ${status}, want ${scenario.expectStatus}`,
        );
        continue;
      }
      try {
        scenario.expect?.(body);
      } catch (error) {
        failures.push(
          `${scenario.label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // One assertion for the whole table, so the failure output names every broken
    // scenario rather than only the first.
    expect(failures).toEqual([]);

    // A guard against the table being quietly emptied, and a check that the tour
    // still covers every group it claims to — an example that silently stops
    // demonstrating roles is worse than one that never did.
    expect(scenarios.length).toBeGreaterThan(15);
    expect(new Set(scenarios.map((s) => s.style))).toEqual(
      new Set(['identity', 'roles', 'ownership', 'diagnostics']),
    );
  });
});

/**
 * A few invariants asserted directly, each against a fresh file, because they are
 * the ones worth protecting when the tour is edited.
 */
describe('the json file is the source of truth', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tsbouncer-hono-store-'));
    file = join(dir, 'authz.json');
    app = await startApp(file);
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const doc = (id: string) =>
    call(app.baseUrl, 'GET', `/api/documents/${id}`, { 'x-user-id': 'alice' });

  it('a write is on disk by the time the request returns', async () => {
    const before = JSON.parse(readFileSync(file, 'utf8')) as { tuples: unknown[] };
    expect(before.tuples.length).toBeGreaterThan(0);

    await app.authz.grant({
      subject: 'role:acme:viewer#holder',
      relation: 'viewer',
      resource: 'document:1',
    });

    // Read straight off the filesystem, not through the store: that is the claim.
    const after = JSON.parse(readFileSync(file, 'utf8')) as { tuples: unknown[] };
    expect(after.tuples.length).toBe(before.tuples.length + 1);
  });

  it("a second app over the same file sees the first one's writes", async () => {
    // Nothing is shared but the file. No in-process cache, no singleton — which is
    // what makes this store usable as a checked-in fixture and in CI. Note `openApp`
    // and not `startApp`: a second process does not re-seed, and the store would
    // (correctly) reject the duplicate.
    const other = await openApp(file);
    try {
      expect((await doc('1')).status).toBe(200);
      expect(
        (await call(other.baseUrl, 'GET', '/api/documents/1', { 'x-user-id': 'carol' }))
          .status,
      ).toBe(200);
    } finally {
      await other.close();
    }
  });

  it('a fresh file is an empty store, not an error', async () => {
    // The first-run path: a checkout with no authz.json at all. The file is created
    // on the first write, so only the directory has to exist.
    const fresh = await openApp(join(dir, 'not-created-yet.json'));
    try {
      const res = await call(fresh.baseUrl, 'GET', '/api/documents', {
        'x-user-id': 'alice',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ documents: [], truncated: false });
    } finally {
      await fresh.close();
    }
  });
});

describe('authorization invariants', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tsbouncer-hono-authz-'));
    app = await startApp(join(dir, 'authz.json'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the permission union is a type, not a convention', async () => {
    // If `document.manag` were accepted, the scenario table could deny forever with
    // no error anywhere. The model is the only source of truth for the name.
    await expect(
      app.authz.can('user:alice', 'document.manag', 'document:1'),
    ).rejects.toThrow();
  });

  it('a write-time typo is rejected, not stored and silently denied', async () => {
    await expect(
      app.authz.grant({
        subject: 'user:alice',
        relation: 'ownerr',
        resource: 'document:1',
      }),
    ).rejects.toThrow(/ownerr/);
  });

  it('listing and reading agree', async () => {
    const headers = { 'x-user-id': 'bob' };
    const list = await call(app.baseUrl, 'GET', '/api/documents', headers);
    const documents = (list.body as { documents: { id: string }[] }).documents;

    expect(documents.length).toBeGreaterThan(0);
    for (const { id } of documents) {
      const read = await call(app.baseUrl, 'GET', `/api/documents/${id}`, headers);
      expect(read.status).toBe(200);
    }
  });
});
