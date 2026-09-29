import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from './db/index.js';
import {
  documents,
  folders,
  organizations,
  projects,
  tsbouncerTuples,
  users,
} from './db/schema.js';
import { type Result, type Scenario, scenarios } from './scenarios.js';
import { call, startApp } from './server.js';

/**
 * The tour.
 *
 * Real HTTP against a real socket, over a real SQLite file. Every line below is a
 * live request, so if authorization only worked when called in-process, this is what
 * would notice.
 *
 * It ends by counting rows in both halves of the schema, because the split is the
 * point of the example: the application owns its tables, the store owns one more,
 * and nothing crosses between them but a string.
 */

const BANNER: Record<Scenario['style'], string> = {
  identity: 'who is calling, before any authorization question',
  rbac: 'roles attached to a project, so a document names nobody',
  rebac: 'teams, folders, and access inherited down a tree',
  abac: 'three conditions, all of them failing closed',
  exclusion: 'bans, wildcards, and publishing that needs two people',
  queries: 'the reverse walks, and what they refuse to invent',
  lifecycle: 'a move that rewrites the access path atomically',
  errors: 'a refusal and a typo are different statuses',
};

/** Row count, straight through the same Drizzle client the routes use. */
function count(db: Db, table: SQLiteTable): number {
  return db.select({ n: sql<number>`count(*)` }).from(table).get()?.n ?? 0;
}

const dir = mkdtempSync(join(tmpdir(), 'tsbouncer-drizzle-'));
let failures = 0;

try {
  const app = await startApp(join(dir, 'app.db'));
  const results: Result[] = [];
  let current: Scenario['style'] | undefined;

  console.log('express + drizzle + sqlite');
  for (const scenario of scenarios) {
    if (scenario.style !== current) {
      current = scenario.style;
      console.log(`\n  ${current} — ${BANNER[current]}`);
    }

    const { status, body } = await call(
      app.baseUrl,
      scenario.method,
      scenario.path,
      scenario.headers,
      scenario.body,
    );

    let error: string | undefined;
    let ok = status === scenario.expectStatus;
    if (ok && scenario.expect) {
      try {
        scenario.expect(body);
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : String(err);
      }
    }
    if (!ok && error === undefined) {
      error = `status ${status} (want ${scenario.expectStatus}) ${JSON.stringify(body)}`;
    }

    results.push({ scenario, ok, error });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${scenario.label.padEnd(58)} ${status}`);
  }

  failures = results.filter((r) => !r.ok).length;
  for (const result of results) {
    if (!result.ok) console.log(`       ${result.scenario.label}: ${result.error}`);
  }

  console.log(`\n  ${results.length - failures} of ${results.length} scenarios passed`);

  console.log("\n  the application's own tables, queried with Drizzle:");
  for (const [label, table] of [
    ['organizations', organizations],
    ['users', users],
    ['projects', projects],
    ['folders', folders],
    ['documents', documents],
  ] as const) {
    console.log(`    ${String(count(app.db, table)).padStart(3)}  ${label}`);
  }
  console.log('  and the one table the store owns, through the same client:');
  console.log(
    `    ${String(count(app.db, tsbouncerTuples)).padStart(3)}  tsbouncer_tuples`,
  );

  await app.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} scenario(s) failed`);
  process.exit(1);
}
