export const DIALECTS = ['sqlite', 'postgres', 'mysql'] as const;
export type Dialect = (typeof DIALECTS)[number];

export const TABLE = 'tsbouncer_tuples';

export const TABLE_INDEX = 'tsbouncer_tuples_subject';
export const TABLE_INDEX_TTU = 'tsbouncer_tuples_ttu';
export const TABLE_INDEX_LIST = 'tsbouncer_tuples_list';

/**
 * The column contract every SQL store shares.
 *
 * References are split across `*_type` / `*_id` / `*_relation` columns rather
 * than stored as one opaque string, because `read()` is conjunctive equality and
 * each filter needs to be an indexable predicate. The engine still hands stores
 * whole reference strings; the adapter parses on the way in and reassembles on
 * the way out.
 */
export const COLUMNS = [
  'subject_type',
  'subject_id',
  'subject_relation',
  'relation',
  'resource_type',
  'resource_id',
  'condition',
  'context',
] as const;

export type Column = (typeof COLUMNS)[number];

/** Row shape as stored. Empty string means "absent" — see `NULL_ABSENT`. */
export interface TupleRow {
  subject_type: string;
  subject_id: string;
  subject_relation: string;
  relation: string;
  resource_type: string;
  resource_id: string;
  condition: string;
  context: string | null;
}

/**
 * Absent values are stored as `''`, never `NULL`.
 *
 * A unique constraint over these columns is how `write({ mode: 'insert' })`
 * detects duplicates. In Postgres, `NULL`s compare as distinct, so a unique
 * index containing a NULL column would never fire — every unconditioned tuple
 * would sail past the constraint and `insert` would silently stop rejecting
 * duplicates. MySQL and SQLite have their own NULL-in-unique behaviours. An
 * empty string makes the constraint mean the same thing on all three.
 *
 * This is a storage detail, not a public one: `Tuple` still uses `undefined`.
 */
export const NULL_ABSENT = '';

/** The seven columns that together identify an edge. Order matters for upserts. */
export const KEY_COLUMNS = [
  'subject_type',
  'subject_id',
  'subject_relation',
  'relation',
  'resource_type',
  'resource_id',
  'condition',
] as const;

export function isDialect(value: string): value is Dialect {
  return (DIALECTS as readonly string[]).includes(value);
}

function columnDefinitions(dialect: Dialect): string {
  const long = dialect === 'postgres' ? 'TEXT' : 'VARCHAR(512)';
  const short = 'VARCHAR(255)';
  return [
    `  subject_type ${short} NOT NULL`,
    `  subject_id ${long} NOT NULL`,
    `  subject_relation ${short} NOT NULL`,
    `  relation ${short} NOT NULL`,
    `  resource_type ${short} NOT NULL`,
    `  resource_id ${long} NOT NULL`,
    `  condition ${short} NOT NULL`,
    `  context ${long}`,
  ].join(',\n');
}

/**
 * DDL for the tuples table and its indexes.
 *
 * Ship this in a migration; do not run it on every boot. The indexes are not
 * decoration — each one backs a query the evaluator actually issues:
 *
 *  - `subject`  reverse walks and `listSubjects`
 *  - `ttu`      tuple-to-userset traversal, which reads by (relation, resource)
 *  - `list`     `listResources` and `expand`, which read by resource
 *
 * The unique constraint backs duplicate detection for `insert` mode.
 */
export function createTupleTableSql(dialect: Dialect): string {
  const unique = KEY_COLUMNS.map((c) => `"${c}"`).join(', ');

  const createTable = `CREATE TABLE IF NOT EXISTS ${TABLE} (\n${columnDefinitions(dialect)},\n  CONSTRAINT ${TABLE}_key UNIQUE (${unique})\n)`;
  const createIndexes = [
    [TABLE_INDEX, 'subject_type, subject_id, relation'],
    [TABLE_INDEX_TTU, 'relation, resource_type, resource_id'],
    [TABLE_INDEX_LIST, 'resource_type, resource_id'],
  ].map(([name, cols]) => `CREATE INDEX IF NOT EXISTS ${name} ON ${TABLE} (${cols})`);

  return `${[createTable, ...createIndexes].join(';\n\n')};\n`;
}

export function dropTupleTableSql(dialect: Dialect): string {
  if (dialect === 'sqlite') {
    return `DROP TABLE IF EXISTS ${TABLE};`;
  }
  return (
    `DROP TABLE IF EXISTS ${TABLE};\n` +
    `DROP INDEX IF EXISTS ${TABLE_INDEX};\n` +
    `DROP INDEX IF EXISTS ${TABLE_INDEX_TTU};\n` +
    `DROP INDEX IF EXISTS ${TABLE_INDEX_LIST};\n`
  );
}
