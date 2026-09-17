/**
 * Helpers for rows that come back from a raw `db.execute()`.
 *
 * Intentional: `drizzle-orm` installs its own `pg` type parsers and hands back
 * `timestamptz` as a **string**, because it parses timestamps per-column in the
 * query builder instead. That is invisible on the query-builder path and a trap
 * on the raw-SQL path: a row typed `{ locked_until: Date }` is actually a
 * string, and `row.locked_until > new Date()` then compares a string to an
 * object and is quietly always false. That exact mistake disabled account
 * lockout here once.
 *
 * So every `Raw*` row type declares timestamps as `string | null` — which makes
 * the compiler refuse to let one reach a `Date` field unconverted — and these
 * are the only way to convert them.
 */

export function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toDateOrNull(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return toDate(value);
}

export function toDateOrUndefined(value: string | Date | null | undefined): Date | undefined {
  return toDateOrNull(value) ?? undefined;
}
