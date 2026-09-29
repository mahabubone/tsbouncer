import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzleStore } from '@tsbouncer/drizzle';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documents, tsbouncerTuples } from '../src/db/schema.js';
import { scenarios } from '../src/scenarios.js';
import { type AppHandle, call, openServer, startApp } from '../src/server.js';

/**
 * The API, verified over real HTTP against a real SQLite file.
 *
 * If authorization only worked when called in-process — a stubbed store, a
 * supertest shim, a mock ORM — this suite is what notices. The scenario table is
 * shared with `src/main.ts`, so the tour and this gate are the same assertions.
 */
describe('the documents API', () => {
  let app: AppHandle;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tsbouncer-drizzle-test-'));
    app = await startApp(join(dir, 'app.db'));
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
    // demonstrating ABAC is worse than one that never did.
    expect(scenarios.length).toBeGreaterThan(45);
    expect(new Set(scenarios.map((s) => s.style))).toEqual(
      new Set([
        'identity',
        'rbac',
        'rebac',
        'abac',
        'exclusion',
        'queries',
        'lifecycle',
        'errors',
      ]),
    );
  });
});

/**
 * The invariants worth protecting when the tour is edited. Each runs against a
 * fresh database, because several of them mutate the access graph.
 */
describe('invariants', () => {
  let app: AppHandle;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tsbouncer-drizzle-inv-'));
    app = await startApp(join(dir, 'app.db'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (user: string, org = 'acme') => ({ 'x-user-id': user, 'x-org': org });

  it('a suspension blocks the conditioned grant but not a wildcard', async () => {
    // Deliberate, and the reason it is asserted: `notSuspended` is attached to
    // erin's grant on document 4, so it is a property of that edge. It is not a
    // global account lock — erin still reaches document 5, which is public.
    //
    // A system that wants a hard lock adds it as a condition to every grant, or
    // refuses the request in middleware before authorization is asked. Both are
    // legitimate; neither happens by accident, so the boundary is written down.
    expect(
      (await call(app.baseUrl, 'GET', '/api/v1/documents/4', as('erin'))).status,
    ).toBe(403);
    expect(
      (await call(app.baseUrl, 'GET', '/api/v1/documents/5', as('erin'))).status,
    ).toBe(200);
  });

  it('listing and reading agree, at every level of the tree', async () => {
    // The bug this whole suite grew out of, in its other form: `listResources`
    // accepted a `context` and dropped it, so a conditionally-granted document was
    // missing from the list while `check` allowed it. And then the same query lost
    // a second level of a self-referential folder chain, which `can` resolved and
    // the walk did not.
    for (const user of ['alice', 'bob', 'carol', 'dana', 'dave', 'mallory']) {
      const list = await call(app.baseUrl, 'GET', '/api/v1/me/documents', as(user));
      expect(list.status).toBe(200);
      const ids = (list.body as { documents: { id: string }[] }).documents.map(
        (d) => d.id,
      );

      for (const id of ids) {
        const read = await call(app.baseUrl, 'GET', `/api/v1/documents/${id}`, as(user));
        expect(read.status, `${user} was listed for ${id} but cannot read it`).toBe(200);
      }
    }
  });

  it('document 2, two folders down, is visible to the team that can see the top', async () => {
    // Named separately because it is the case a self-referential `parent` chain
    // gets wrong, and both the walk and the evaluator have to agree on it.
    expect(
      (await call(app.baseUrl, 'GET', '/api/v1/documents/2', as('bob'))).status,
    ).toBe(200);
    const list = await call(app.baseUrl, 'GET', '/api/v1/me/documents', as('bob'));
    expect(
      (list.body as { documents: { id: string }[] }).documents.map((d) => d.id),
    ).toContain('2');
  });

  it('a write naming a relation the model does not declare is refused, not stored', async () => {
    await expect(
      app.authz.grant({
        subject: 'user:alice',
        relation: 'supervisor',
        resource: 'document:1',
      }),
    ).rejects.toThrow(/supervisor/);

    // And nothing was written on the way out.
    const stored = await app.authz.store.read({ relation: 'supervisor' });
    expect(stored.items).toEqual([]);
  });

  it('a duplicate grant is rejected by the unique index, not silently accepted', async () => {
    // The reason the key columns are `NOT NULL` with `''` for absent: a NULL in a
    // unique index never compares equal, so `insert` would quietly stop rejecting
    // duplicates and every "already granted" error would disappear.
    await expect(
      app.authz.grant({
        subject: 'user:alice',
        relation: 'owner',
        resource: 'document:1',
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('explain reports the decision and the reads it took', async () => {
    const res = await call(
      app.baseUrl,
      'GET',
      '/api/v1/documents/1/why?permission=document.read',
      as('carol'),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ allowed: false });
    expect((res.body as { reads: number }).reads).toBeGreaterThan(0);
  });
});

describe('the store inside a caller-owned transaction', () => {
  let app: AppHandle;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tsbouncer-drizzle-tx-'));
    app = await startApp(join(dir, 'app.db'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a rollback leaves neither the row nor the grant moved', async () => {
    const before = app.db.select().from(documents).where(eq(documents.id, '3')).get();
    expect(before?.folderId).toBe('design');

    // The shape the `move` route uses, with a throw in the middle. On a
    // synchronous driver the callback must not be async and the store's promise
    // must not be returned — Drizzle rejects a promise-returning transaction
    // callback outright. The write is still applied synchronously, before the
    // first `await` inside `write`, which is why the throw below rolls it back.
    let issued: Promise<unknown> | undefined;
    expect(() =>
      app.db.transaction((tx) => {
        tx.update(documents).set({ folderId: 'eng' }).where(eq(documents.id, '3')).run();
        issued = drizzleStore(tx, tsbouncerTuples).write({
          tuples: [{ subject: 'folder:eng', relation: 'parent', resource: 'document:3' }],
        });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    await issued;

    // The row is where it was, and the grant is too: the `design` parent edge is
    // still there and the `eng` one was never committed. A move that updated one
    // without the other would leave a document whose access nobody can explain.
    expect(
      app.db.select().from(documents).where(eq(documents.id, '3')).get()?.folderId,
    ).toBe('design');
    const parents = await app.authz.store.read({
      relation: 'parent',
      resource: 'document:3',
    });
    expect(parents.items.map((t) => t.subject)).toEqual(['folder:design']);
  });

  it('the store reports what it can do, and a transaction is one of the things', async () => {
    // The capability record is how a caller learns that enlistment is available at
    // all, and it is the same record for every driver.
    expect(app.authz.store.capabilities.atomicWrite).toBe(true);
    expect(app.authz.store.capabilities.pagination).toBe(false);
  });

  it('a filter delete removes exactly what its query matches', async () => {
    // Worth being explicit about, because the near-miss is silent. Filtering on
    // `relation: ''` looks like "rows with no relation" and matches nothing, so a
    // delete written that way appears to succeed and removes nothing. An *empty*
    // query is the one that really does mean "everything" — which is exactly what
    // `kind: 'replace'` is built on.
    const before = await app.authz.store.read({
      relation: 'owner',
      resource: 'document:1',
    });
    expect(before.items.length).toBeGreaterThan(0);

    await app.authz.delete({
      kind: 'filter',
      query: { relation: 'owner', resource: 'document:1' },
    });

    const after = await app.authz.store.read({
      relation: 'owner',
      resource: 'document:1',
    });
    expect(after.items).toEqual([]);

    // The neighbouring rows are untouched, so the filter was not over-broad.
    expect(
      (await app.authz.store.read({ relation: 'owner', resource: 'document:4' })).items,
    ).toHaveLength(1);
  });
});

describe('the file on disk', () => {
  it("a second server over the same file sees the first one's writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsbouncer-drizzle-file-'));
    const file = join(dir, 'app.db');
    const first = await startApp(file);
    let second: AppHandle | undefined;

    try {
      await first.authz.grant({
        subject: 'user:heidi',
        relation: 'viewer',
        resource: 'document:6',
      });

      // `openServer` and not `startApp`: a second process does not re-seed, and
      // the unique index would (correctly) reject the duplicate fixture.
      second = await openServer(file);
      const res = await call(second.baseUrl, 'GET', '/api/v1/documents/6', {
        'x-user-id': 'heidi',
        'x-org': 'globex',
      });
      expect(res.status).toBe(200);
    } finally {
      await second?.close();
      await first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the tuple table holds what the seed wrote, and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsbouncer-drizzle-rows-'));
    const app = await startApp(join(dir, 'app.db'));
    try {
      const rows = app.db
        .select({ n: sql<number>`count(*)` })
        .from(tsbouncerTuples)
        .get();
      const seedCount = (await app.authz.store.read()).items.length;
      expect(rows?.n).toBe(seedCount);
      expect(seedCount).toBeGreaterThan(30);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
