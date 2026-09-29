import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scenarios } from '../src/scenarios.js';
import { type AppHandle, call, type StoreName, startApp } from '../src/server.js';

/**
 * The API, verified over real HTTP.
 *
 * A real listening socket and real `fetch` calls, per store. If authorization only
 * worked when invoked in-process — a stubbed store, a direct call into the
 * handler, a supertest shim — this suite is what notices, and it is also the only
 * place the Express wiring itself is covered at all.
 *
 * The scenario table is shared with `src/main.ts`, so the tour in the README and
 * this gate are the same assertions and cannot drift.
 */

const STORES: readonly StoreName[] = ['memory', 'json', 'sqlite'];

describe.each(STORES)('API on the %s store', (store) => {
  let app: AppHandle;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), `tsbouncer-api-${store}-`));
    app = await startApp(store, store === 'memory' ? '' : join(dir, 'authz.db'));
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
    // still covers every style it claims to — an example that silently stops
    // demonstrating ABAC is worse than one that never did.
    expect(scenarios.length).toBeGreaterThan(40);
    expect(new Set(scenarios.map((s) => s.style))).toEqual(
      new Set(['RBAC', 'ReBAC', 'ABAC', 'app']),
    );
  });
});

/**
 * A few invariants asserted directly, each on a fresh app, because they are the
 * ones worth protecting when the tour is edited.
 */
describe('authorization invariants', () => {
  let app: AppHandle;

  beforeAll(async () => {
    app = await startApp('memory', '');
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, headers: Record<string, string>) =>
    call(app.baseUrl, 'GET', path, headers);

  it('a denied check and a rejected write are different statuses', async () => {
    // The distinction that keeps a server-side typo from reporting itself to the
    // user as "you are not allowed".
    const denied = await get('/api/v1/documents/1', {
      'x-user-id': 'frank',
      'x-region': 'eu',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden');

    const rejected = await call(
      app.baseUrl,
      'POST',
      '/api/v1/documents/1/roles',
      { 'x-user-id': 'alice', 'x-region': 'eu' },
      { role: 'acme:viewer', relation: 'superuser' },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('invalid_tuple');
  });

  it('identity is required before any authorization question', async () => {
    const anon = await get('/api/v1/documents/1', {});
    expect(anon.status).toBe(401);
  });

  it('a resource the caller cannot see is 403, and a missing one is 404', async () => {
    expect(
      (await get('/api/v1/documents/6', { 'x-user-id': 'alice', 'x-region': 'eu' }))
        .status,
    ).toBe(403);
    expect(
      (await get('/api/v1/documents/999', { 'x-user-id': 'alice', 'x-region': 'eu' }))
        .status,
    ).toBe(404);
  });

  it('listing and reading agree, including for conditioned grants', async () => {
    // The bug this whole suite grew out of: `listResources` accepted a `context`
    // and did not forward it, so a document readable only under a condition was
    // missing from the list while `check` allowed it.
    const headers = { 'x-user-id': 'dave', 'x-region': 'eu' };
    const list = await get('/api/v1/documents', headers);
    const ids = (list.body.documents as ReadonlyArray<{ id: string }>).map((d) => d.id);

    for (const id of ids) {
      expect((await get(`/api/v1/documents/${id}`, headers)).status).toBe(200);
    }
    // doc 1 is reachable only through a region-bound grant.
    expect(ids).toContain('1');
  });

  it('a client cannot forge the ABAC context it is evaluated against', async () => {
    const asDave = { 'x-user-id': 'dave', 'x-region': 'eu' };
    const bound = await get('/api/v1/documents/2', asDave);
    expect(bound.status).toBe(403);

    const forged = await get('/api/v1/documents/2?callerRegion=us', asDave);
    expect(forged.status).toBe(403);
  });

  it('the same subject gets different answers in different regions', async () => {
    const eu = await get('/api/v1/documents/1', {
      'x-user-id': 'dave',
      'x-region': 'eu',
    });
    const us = await get('/api/v1/documents/1', {
      'x-user-id': 'dave',
      'x-region': 'us',
    });
    expect(eu.status).toBe(200);
    expect(us.status).toBe(403);
  });

  it('cross-tenant isolation holds', async () => {
    const acme = { 'x-user-id': 'alice', 'x-region': 'eu' };
    expect((await get('/api/v1/documents/6', acme)).status).toBe(403);

    const globex = { 'x-user-id': 'root', 'x-region': 'us' };
    expect((await get('/api/v1/documents/6', globex)).status).toBe(200);
  });

  it('explain reports a decision and the reads it took', async () => {
    const res = await get(
      '/api/v1/documents/1/why?subject=user:dave&permission=document.read',
      {
        'x-user-id': 'alice',
        'x-region': 'eu',
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);
    expect(res.body.reads).toBeGreaterThan(0);
  });
});
