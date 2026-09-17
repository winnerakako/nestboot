import type { CursorPage } from '../http/cursor.js';

/**
 * The seams `/ops` talks through.
 *
 * Every tab reads an interface, never a table directly, so that moving logs to
 * ClickHouse or rate-limit counters to Redis is a new implementation and a
 * changed provider — not an edit to eight pages. The Postgres implementations
 * are the only ones shipped; the interfaces exist so the second one is cheap,
 * and they are written now because retrofitting an interface under a page that
 * already hand-writes SQL is the expensive direction.
 */

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface LogRecord {
  id: string;
  ts: Date;
  level: number;
  msg: string;
  ctx: Record<string, unknown>;
  requestId?: string | null;
  workflowId?: string | null;
  jobId?: string | null;
  step?: string | null;
  traceId?: string | null;
  route?: string | null;
  method?: string | null;
  status?: number | null;
  feature?: string | null;
  group?: string | null;
}

export interface LogQuery {
  /** Free text, matched with the simple dictionary. See the data contract. */
  search?: string;
  minLevel?: number;
  levels?: number[];
  route?: string;
  feature?: string;
  group?: string;
  requestId?: string;
  workflowId?: string;
  jobId?: string;
  since?: Date;
  before?: Date;
  cursor?: string;
  limit?: number;
}

/** A dimension's values with counts, for the left rail of a list page. */
export interface FacetCount {
  value: string;
  count: number;
}

export interface LogStore {
  query(query: LogQuery): Promise<CursorPage<LogRecord>>;
  /** Counts by route / feature / group for the current window. */
  facets(dimension: 'route' | 'feature' | 'group', query: LogQuery): Promise<FacetCount[]>;
  countsByLevel(query: LogQuery): Promise<Record<number, number>>;
}

export const LOG_STORE = Symbol('LOG_STORE');

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface RequestRecord {
  id: string;
  ts: Date;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  feature?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  bytesOut?: number | null;
  sampleRate: number;
}

export interface RequestQuery {
  search?: string;
  route?: string;
  feature?: string;
  method?: string;
  minStatus?: number;
  maxStatus?: number;
  minDurationMs?: number;
  since?: Date;
  before?: Date;
  cursor?: string;
  limit?: number;
}

export interface RouteStats {
  route: string;
  method: string;
  /** `sum(1 / sample_rate)`, never `count(*)`. Sampling makes a count a lie. */
  volume: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  maxDurationMs: number;
}

export interface RequestStore {
  query(query: RequestQuery): Promise<CursorPage<RequestRecord>>;
  byRoute(query: RequestQuery): Promise<RouteStats[]>;
  facets(dimension: 'route' | 'feature', query: RequestQuery): Promise<FacetCount[]>;
}

export const REQUEST_STORE = Symbol('REQUEST_STORE');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ErrorOccurrence {
  id: string;
  ts: Date;
  fingerprint: string;
  type: string;
  message: string;
  stack?: string | null;
  status?: number | null;
  route?: string | null;
  feature?: string | null;
  group?: string | null;
  requestId?: string | null;
  workflowId?: string | null;
  traceId?: string | null;
  userId?: string | null;
}

export interface ErrorGroup {
  fingerprint: string;
  type: string;
  message: string;
  route?: string | null;
  feature?: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrences: number;
  status: 'open' | 'resolved' | 'muted';
  mutedUntil?: Date | null;
  resolvedAt?: Date | null;
  resolvedBy?: string | null;
  note?: string | null;
}

export interface ErrorQuery {
  search?: string;
  route?: string;
  feature?: string;
  status?: 'open' | 'resolved' | 'muted';
  since?: Date;
  before?: Date;
  cursor?: string;
  limit?: number;
}

export interface ErrorStore {
  groups(query: ErrorQuery): Promise<CursorPage<ErrorGroup>>;
  group(fingerprint: string): Promise<ErrorGroup | null>;
  occurrences(fingerprint: string, query: ErrorQuery): Promise<CursorPage<ErrorOccurrence>>;
  facets(dimension: 'route' | 'feature', query: ErrorQuery): Promise<FacetCount[]>;
  resolve(fingerprint: string, by: string, note?: string): Promise<void>;
  mute(fingerprint: string, until: Date, by: string): Promise<void>;
  reopen(fingerprint: string): Promise<void>;
}

export const ERROR_STORE = Symbol('ERROR_STORE');

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  expired: number;
}

export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  /**
   * Read through: return the cached value, or compute, store and return it.
   * The only cache API most code should use — it is what stops an AI reaching
   * for a module-level `Map` and creating a cross-request leak.
   */
  remember<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T>;
  forget(key: string): Promise<void>;
  forgetPrefix(prefix: string): Promise<number>;
  stats(): Promise<CacheStats>;
}

export const CACHE_STORE = Symbol('CACHE_STORE');

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitSubject {
  kind: 'ip' | 'user' | 'org' | 'api_key';
  id: string;
}

export interface RateLimitHit {
  count: number;
  windowStart: Date;
}

export interface RateLimitStore {
  /** Atomically record one request and return the running count for the window. */
  increment(
    subject: RateLimitSubject,
    routeGroup: string,
    windowSeconds: number,
  ): Promise<RateLimitHit>;
  peek(subject: RateLimitSubject, routeGroup: string, windowSeconds: number): Promise<RateLimitHit>;
  reset(subject: RateLimitSubject, routeGroup: string): Promise<void>;
  topOffenders(
    routeGroup: string | undefined,
    limit: number,
  ): Promise<Array<RateLimitSubject & { count: number }>>;
}

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');
