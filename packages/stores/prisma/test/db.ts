import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { prismaStore } from '../src/index.js';

export interface Handle {
  prisma: PrismaClient;
  destroy(): Promise<void>;
}

const CREATE_DDL = `CREATE TABLE IF NOT EXISTS "TsbouncerTuple" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "subjectRelation" TEXT NOT NULL,
  "relation" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "condition" TEXT NOT NULL,
  "context" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "TsbouncerTuple_key"
  ON "TsbouncerTuple" (subjectType, subjectId, subjectRelation, relation, resourceType, resourceId, condition);
CREATE INDEX IF NOT EXISTS "TsbouncerTuple_subject"
  ON "TsbouncerTuple" (subjectType, subjectId, relation);
CREATE INDEX IF NOT EXISTS "TsbouncerTuple_ttu"
  ON "TsbouncerTuple" (relation, resourceType, resourceId);
CREATE INDEX IF NOT EXISTS "TsbouncerTuple_list"
  ON "TsbouncerTuple" (resourceType, resourceId);
`;

/**
 * A fresh in-memory SQLite database behind a real Prisma client.
 *
 * Prisma 7 takes a driver adapter in the `PrismaClient` constructor and no
 * longer accepts `url` in the schema, so the adapter is constructed here. The
 * table is created with `$executeRawUnsafe` rather than a migration: these tests
 * are checking the store, not the migration path.
 */
export function createDb(): Handle {
  const adapter = new PrismaBetterSqlite3({ url: ':memory:' });
  const prisma = new PrismaClient({ adapter });
  return {
    prisma,
    async destroy() {
      await prisma.$disconnect();
    },
  };
}

/** `$executeRawUnsafe` accepts exactly one statement, so the DDL is split. */
export async function ensureTable(handle: Handle): Promise<void> {
  for (const statement of CREATE_DDL.split(';\n')) {
    const sql = statement.trim();
    if (sql.length > 0) await handle.prisma.$executeRawUnsafe(sql);
  }
}

export async function truncate(handle: Handle): Promise<void> {
  await handle.prisma.$executeRawUnsafe('DELETE FROM "TsbouncerTuple"');
}

export { prismaStore };
