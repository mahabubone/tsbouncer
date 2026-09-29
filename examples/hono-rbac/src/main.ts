import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Result, type Scenario, scenarios } from './scenarios.js';
import { call, startApp } from './server.js';

/**
 * The tour.
 *
 * Real HTTP against a real socket. Every line below is a live request, so if
 * authorization only worked when called in-process, this is what would notice.
 *
 * It also prints the JSON file at the end, because for this example the storage
 * format is half the point: the entire access graph of the application is a file
 * you can read, diff, and commit.
 */

const BANNER: Record<Scenario['style'], string> = {
  identity: 'who is calling, and what happens when nobody is',
  roles: 'a role attached to a document, and a role attached to nothing',
  ownership: 'who may change content, and who may change the access list',
  diagnostics: 'the question support actually asks',
};

const dir = mkdtempSync(join(tmpdir(), 'tsbouncer-hono-'));
const file = join(dir, 'authz.json');

let failures = 0;

try {
  const app = await startApp(file);
  const results: Result[] = [];
  let current: Scenario['style'] | undefined;

  console.log('hono + a json file');
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
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${scenario.label.padEnd(52)} ${status}`);
  }

  failures = results.filter((r) => !r.ok).length;
  for (const result of results) {
    if (!result.ok) console.log(`       ${result.scenario.label}: ${result.error}`);
  }

  console.log(`\n  ${results.length - failures} of ${results.length} scenarios passed`);

  console.log('\n  the whole access graph, as a file:');
  console.log(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
  );

  await app.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} scenario(s) failed`);
  process.exit(1);
}
