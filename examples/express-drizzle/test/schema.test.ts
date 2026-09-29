import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';

/**
 * The committed SQL and the Drizzle schema are two descriptions of one database, so
 * something has to hold them together.
 *
 * Normally `drizzle-kit generate` does it: you change the schema, it writes the
 * migration. That is not available here, and the reason is worth recording rather
 * than working around silently — `drizzle-kit` resolves the schema module with
 * CommonJS semantics, and every store in this repo is ESM-only with an `exports`
 * map that has no `require` condition:
 *
 *   Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in
 *   .../@tsbouncer/drizzle/package.json
 *
 * Adding a `require` condition would mean shipping a dual build, which this
 * repository does not do, so the migration here is hand-maintained instead. These
 * tests are what make that safe.
 *
 * The gap is not hypothetical. `organizations.region` was added to the schema and
 * not to the SQL, and the failure was a runtime `SqliteError: table organizations
 * has no column named region` on the first seed insert — a long way from the edit
 * that caused it.
 */

// Read the same directory the application migrates from, so a renamed file cannot
// leave this suite green against a path nothing opens.
const sqlText = readFileSync(join(MIGRATIONS_DIR, '0000_init.sql'), 'utf8');

/** The `CREATE TABLE name (...)` block, as one string, without the statement head. */
function createTable(name: string): string {
  const match = new RegExp(`CREATE TABLE ${name} \\(([\\s\\S]*?)\\n\\);`, 'i').exec(
    sqlText,
  );
  if (match?.[1] === undefined) {
    throw new Error(`no CREATE TABLE for ${name} in the migration`);
  }
  return match[1];
}

const TABLES = {
  organizations: schema.organizations,
  users: schema.users,
  projects: schema.projects,
  folders: schema.folders,
  documents: schema.documents,
  tsbouncer_tuples: schema.tsbouncerTuples,
} as const;

describe('the committed migration matches the Drizzle schema', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    it(`declares every column of ${name}`, () => {
      const body = createTable(name);
      for (const column of Object.values(getTableConfig(table).columns)) {
        expect(body, `${name}.${column.name} is missing from the migration`).toContain(
          column.name,
        );
      }
    });

    it(`gives every non-nullable column of ${name} a NOT NULL`, () => {
      const body = createTable(name);
      for (const column of Object.values(getTableConfig(table).columns)) {
        if (!column.notNull) continue;
        // Column-per-line, so the constraint has to be on the same line as the
        // column it belongs to rather than somewhere else in the block.
        const line = body
          .split('\n')
          .find((candidate) => candidate.trim().startsWith(column.name));
        expect(line, `${name}.${column.name} has no line in the migration`).toBeDefined();
        expect(
          line?.toUpperCase(),
          `${name}.${column.name} is NOT NULL in the schema but not in the migration`,
        ).toContain('NOT NULL');
      }
    });
  }

  it('the tuples table rejects duplicates with a unique index over its key columns', () => {
    // The reason every key column is `NOT NULL` with `''` for absent: in Postgres
    // two NULLs never compare equal, so a unique index containing one never fires
    // and `write({ mode: 'insert' })` silently stops rejecting duplicates.
    expect(sqlText).toContain('CREATE UNIQUE INDEX tsbouncer_tuples_key');

    const key = /CREATE UNIQUE INDEX tsbouncer_tuples_key[\s\S]*?\(([^)]*)\)/i.exec(
      sqlText,
    );
    const columns = (key?.[1] ?? '').split(',').map((c) => c.trim());
    expect(columns).toEqual([
      'subject_type',
      'subject_id',
      'subject_relation',
      'relation',
      'resource_type',
      'resource_id',
      'condition',
    ]);
  });

  it('the tuples table is indexed for the three questions the evaluator asks', () => {
    // "Which subjects touch this resource", "which resources does this subject
    // touch", and the tuple-to-userset walk. Missing any of them is not a
    // correctness bug, which is exactly why it needs a test.
    for (const index of [
      'tsbouncer_tuples_subject',
      'tsbouncer_tuples_ttu',
      'tsbouncer_tuples_list',
    ]) {
      expect(sqlText, `${index} is missing from the migration`).toContain(index);
    }
  });

  it('the tuples table built by the store is the one the migration describes', () => {
    // The package owns the column contract; this example's SQL is a copy of it. If
    // the package ever changes, this fails rather than the two quietly diverging
    // and the store writing to columns the database does not have.
    const config = getTableConfig(schema.tsbouncerTuples);
    expect(config.name).toBe('tsbouncer_tuples');

    const byName = new Map(
      config.columns.map((column) => [column.name, column] as const),
    );
    expect(byName.get('context')?.notNull, 'context is the one nullable column').toBe(
      false,
    );
    for (const key of ['subject_relation', 'condition'] as const) {
      expect(
        byName.get(key)?.notNull,
        `${key} must be NOT NULL, with '' when absent`,
      ).toBe(true);
    }
  });
});
