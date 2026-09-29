import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Result, type Style, scenarios } from './scenarios.js';
import { call, type StoreName, startApp } from './server.js';

/**
 * The tour.
 *
 * Real HTTP against a real socket, run twice — once over a JSON file, once over
 * SQLite — using identical application code. Every line below is a live request;
 * if authorization only worked when invoked in-process, this is what would
 * notice.
 *
 * The scenario table is shared with `test/api.test.ts`, so the demo you watch and
 * the suite that gates CI cannot drift apart.
 */

const BANNER: Record<Style, string> = {
  RBAC: 'role held by someone, attached to a resource',
  ReBAC: 'ownership, teams, folders, sharing',
  ABAC: 'constraints the writer bound, and state the caller supplies',
  app: 'the request lifecycle, which belongs to the application',
};

async function runStore(store: StoreName, dir: string): Promise<{ results: Result[] }> {
  const file = store === 'json' ? join(dir, 'authz.json') : join(dir, 'authz.sqlite');
  const handle = await startApp(store, file);
  const results: Result[] = [];

  try {
    let current: Style | undefined;
    for (const scenario of scenarios) {
      if (scenario.style !== current) {
        current = scenario.style;
        console.log(`\n  ${current} — ${BANNER[current]}`);
      }

      const { status, body } = await call(
        handle.baseUrl,
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

      results.push({ scenario, status, body, ok, error });
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${scenario.label.padEnd(48)} ${status}`);
    }
  } finally {
    await handle.close();
  }

  return { results };
}

let failures = 0;
let total = 0;

for (const store of ['memory', 'json', 'sqlite'] as const) {
  const dir = mkdtempSync(join(tmpdir(), `tsbouncer-api-${store}-`));
  console.log(`\n${store} store`);
  try {
    const { results } = await runStore(store, dir);
    total += results.length;
    failures += results.filter((r) => !r.ok).length;
    for (const r of results)
      if (!r.ok) console.log(`       ${r.scenario.label}: ${r.error}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${total - failures} of ${total} scenarios passed, on both stores`);
if (failures > 0) {
  console.error(`${failures} scenario(s) failed`);
  process.exit(1);
}
