import { z } from 'zod';

/**
 * The search grammar and time window every /ops list page shares.
 *
 * One syntax across eight tabs is the difference between a tool you learn once
 * and eight pages you re-read every time. All state lives in the URL, so a
 * filtered view is a link an operator can paste into an incident channel and
 * the back button behaves.
 */

export const WINDOWS = {
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
} as const;

export type WindowKey = keyof typeof WINDOWS;
export const DEFAULT_WINDOW: WindowKey = '24h';

export function isWindowKey(value: string): value is WindowKey {
  return value in WINDOWS;
}

export interface TimeWindow {
  key: WindowKey;
  since: Date;
  until: Date;
  label: string;
}

export function resolveWindow(key: string | undefined, now = new Date()): TimeWindow {
  const resolved: WindowKey = key && isWindowKey(key) ? key : DEFAULT_WINDOW;
  return {
    key: resolved,
    since: new Date(now.getTime() - WINDOWS[resolved]),
    until: now,
    label: resolved,
  };
}

/** `since:2h` / `since:30m` / `since:7d` inside the search box. */
const RELATIVE = /^(\d+)(m|h|d)$/;

export function parseRelative(value: string, now = new Date()): Date | null {
  const match = RELATIVE.exec(value);
  if (!match) {
    const absolute = new Date(value);
    return Number.isNaN(absolute.getTime()) ? null : absolute;
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return new Date(now.getTime() - amount * ms);
}

export interface ParsedSearch {
  /** Everything that was not a `key:value` token. */
  text: string;
  tokens: Record<string, string>;
  /** The raw input, so the box can be re-rendered exactly as typed. */
  raw: string;
}

const TOKEN = /(\w+):("[^"]*"|\S+)/g;

/**
 * Split `level:error route:/loans/:id timeout` into filters and free text.
 *
 * Note the route value itself contains a colon — so tokens are matched by a
 * leading `key:` at a word boundary and the *rest* is taken verbatim, rather
 * than splitting on every colon.
 */
export function parseSearch(input: string | undefined): ParsedSearch {
  const raw = (input ?? '').trim();
  if (!raw) return { text: '', tokens: {}, raw: '' };

  const tokens: Record<string, string> = {};
  const text = raw
    .replace(TOKEN, (match, key: string, value: string) => {
      if (!KNOWN_KEYS.has(key)) return match; // not a filter; leave it as text
      tokens[key] = value.replace(/^"|"$/g, '');
      return '';
    })
    .replace(/\s+/g, ' ')
    .trim();

  return { text, tokens, raw };
}

/**
 * Only these are treated as filters. Anything else stays free text, so a search
 * for `timeout:30` in a log message is not silently swallowed as a filter that
 * matches nothing.
 */
export const KNOWN_KEYS = new Set([
  'level',
  'route',
  'feature',
  'group',
  'status',
  'queue',
  'kind',
  'method',
  'wf',
  'req',
  'job',
  'since',
  'before',
  'slower',
  'name',
]);

/** pino's numeric levels, which is what `ops.logs.level` stores. */
export const LOG_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

export function levelNumber(name: string): number | undefined {
  return LOG_LEVELS[name.toLowerCase() as keyof typeof LOG_LEVELS];
}

export function levelName(value: number): string {
  const found = Object.entries(LOG_LEVELS).find(([, n]) => n === value);
  return found?.[0] ?? String(value);
}

export const ListQuerySchema = z.object({
  q: z.string().max(500).optional(),
  window: z.string().max(10).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** Which facet rail is showing: by route, by feature, or by group. */
  by: z.enum(['route', 'feature', 'group']).optional(),
  live: z.coerce.boolean().optional(),
});

export type ListQuery = z.infer<typeof ListQuerySchema>;

/**
 * Rebuild the current URL with some parameters replaced.
 * Used for every link and form on a list page, so filter state composes instead
 * of each link resetting the others.
 */
export function urlWith(
  base: string,
  current: Record<string, unknown>,
  changes: Record<string, unknown>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...current, ...changes })) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
