import { z } from 'zod';

/**
 * Cursor pagination, everywhere, with no offset variant offered.
 *
 * `OFFSET 50000` makes Postgres walk and discard fifty thousand rows, so the
 * last page of a list costs the most exactly when the table is biggest. It is
 * also wrong under concurrent writes: a row inserted during paging shifts every
 * subsequent page by one, so a client silently skips records. Ids are UUIDv7 —
 * time-ordered — so the id *is* the cursor and needs no encoding.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export const CursorQuerySchema = z.object({
  /** Return rows ordered before this id (newest-first lists). */
  before: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type CursorQuery = z.infer<typeof CursorQuerySchema>;

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Build a page from rows fetched with `limit + 1`.
 *
 * Fetching one extra row is how `hasMore` is known without a second
 * `COUNT(*)` over the same predicate — which on a partitioned telemetry table
 * costs more than the page itself.
 */
export function toCursorPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => string,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return {
    data,
    hasMore,
    nextCursor: hasMore && last !== undefined ? cursorOf(last) : null,
  };
}

/** The `limit` to pass to the query: always one more than the caller asked for. */
export function fetchLimit(limit: number): number {
  return limit + 1;
}

/**
 * A cursor into a time-partitioned table carries the timestamp as well as the
 * id.
 *
 * The id alone would be enough to order by, but not to *prune*: `WHERE id < $1`
 * gives Postgres nothing to exclude partitions with, so the next page scans
 * every day of history. Carrying the timestamp turns page two into a single
 * partition read.
 */
export function encodeTimeCursor(ts: Date, id: string): string {
  return Buffer.from(`${ts.toISOString()}|${id}`).toString('base64url');
}

export function decodeTimeCursor(cursor: string): { ts: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!iso || !id) return null;
    const ts = new Date(iso);
    return Number.isNaN(ts.getTime()) ? null : { ts, id };
  } catch {
    // A malformed cursor is a client mistake, not a server error: start over
    // from the top rather than 500 on a truncated URL.
    return null;
  }
}
