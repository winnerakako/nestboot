import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Drizzle tables for the product database.
 *
 * These describe the schema for querying; `migrations/app/*.sql` is what
 * creates it. `schema.spec.ts` asserts the two agree against a live database,
 * so a table declared here and never migrated — or migrated and never declared
 * — fails `pnpm verify` rather than the first query that touches it.
 *
 * A feature's own tables live in `features/<name>/entities/` and are re-exported
 * from there, not added here.
 */

export const migrations = pgTable('_migrations', {
  key: text('key').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer('duration_ms').notNull(),
});
