-- 0000_init.sql
--
-- The application's schema, including the authorization table.
--
-- It is hand-maintained rather than generated, and `test/schema.test.ts` is what
-- makes that safe: that test reads the Drizzle schema and fails if this file and
-- it disagree about a column, a NOT NULL, or an index. Two sources of truth are
-- only a problem when nothing checks them.
--
-- The `tsbouncer_tuples` table below is not hand-written from scratch — the
-- package builds the same table object with `sqliteTsbouncerTuples()`, and those
-- two are what the test compares. The contract that matters:
--
--   * every key column is NOT NULL, with '' meaning absent. A NULL in a unique
--     index never compares equal to another NULL, so `insert` would silently stop
--     rejecting duplicates;
--   * a unique index over the seven key columns, which is what enforces that;
--   * three lookup indexes, because the evaluator's three questions are "which
--     subjects touch this resource", "which resources does this subject touch",
--     and "walk up to the parent for a tuple-to-userset".

CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  region TEXT NOT NULL,
  seats_used INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  suspended INTEGER DEFAULT 0 NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  name TEXT NOT NULL
);

CREATE TABLE folders (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (id),
  parent_id TEXT,
  name TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY NOT NULL,
  folder_id TEXT NOT NULL REFERENCES folders (id),
  title TEXT NOT NULL,
  region TEXT NOT NULL,
  on_hold INTEGER DEFAULT 0 NOT NULL
);

CREATE TABLE tsbouncer_tuples (
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_relation TEXT NOT NULL,
  relation TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  condition TEXT NOT NULL,
  context TEXT
);

CREATE UNIQUE INDEX tsbouncer_tuples_key ON tsbouncer_tuples (
  subject_type, subject_id, subject_relation, relation, resource_type, resource_id, condition
);

CREATE INDEX tsbouncer_tuples_subject ON tsbouncer_tuples (subject_type, subject_id, relation);

CREATE INDEX tsbouncer_tuples_ttu ON tsbouncer_tuples (relation, resource_type, resource_id);

CREATE INDEX tsbouncer_tuples_list ON tsbouncer_tuples (resource_type, resource_id);
