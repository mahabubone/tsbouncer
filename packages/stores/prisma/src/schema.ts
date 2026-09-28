/**
 * The canonical model name used when `prismaStore` is not told otherwise.
 *
 * The column set is byte-for-byte the one `@tsbouncer/kysely` and
 * `@tsbouncer/drizzle` expect, so an application can move between adapters
 * without migrating data. See the package README for the model to copy.
 */
export const DEFAULT_MODEL = 'TsbouncerTuple';

/**
 * The seven fields that together identify an edge, in the order the composite
 * unique constraint declares them.
 *
 * Absent values are `''`, never NULL. A unique constraint over NULL-containing
 * columns does not fire in Postgres — NULLs compare as distinct — so `insert`
 * mode would silently stop rejecting duplicates. `''` makes the constraint mean
 * the same thing on every database.
 */
export const KEY_FIELDS = [
  'subjectType',
  'subjectId',
  'subjectRelation',
  'relation',
  'resourceType',
  'resourceId',
  'condition',
] as const;

export const NULL_ABSENT = '';

/** Prisma model definition to paste into `schema.prisma`. */
export const MODEL_DDL = `model ${DEFAULT_MODEL} {
  id               Int    @id @default(autoincrement())
  subjectType      String
  subjectId        String
  subjectRelation  String
  relation         String
  resourceType     String
  resourceId       String
  condition        String
  context          String?

  @@unique([subjectType, subjectId, subjectRelation, relation, resourceType, resourceId, condition])
  @@index([subjectType, subjectId, relation])
  @@index([relation, resourceType, resourceId])
  @@index([resourceType, resourceId])
}`;
