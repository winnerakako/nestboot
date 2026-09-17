import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { AppDb } from '../../db/app-db.service.js';
import { toDateOrNull } from '../../db/raw.js';
import type { RateLimitSubject } from '../../stores/stores.js';

export interface RateLimitPolicy {
  id: string;
  routeGroup: string;
  subjectKind: string;
  subjectId: string | null;
  maxRequests: number;
  windowSeconds: number;
  burst: number | null;
  action: 'reject' | 'log_only';
  priority: number;
  enabled: boolean;
  note: string | null;
  expiresAt: Date | null;
}

/**
 * Policy lookup, cached in process.
 *
 * Every request would otherwise do a policy query before doing its work, which
 * makes the rate limiter the slowest thing on the hot path — the opposite of
 * its job. The cache is invalidated by a version bump on write, so an operator
 * raising a limit during an incident sees it take effect on the next request
 * rather than after a deploy or a TTL.
 */
@Injectable()
export class RateLimitPolicies {
  private cache: RateLimitPolicy[] = [];
  private loadedAt = 0;
  private loading?: Promise<void>;

  /** Short enough that another pod's edit lands quickly; long enough to matter. */
  private static readonly TTL_MS = 10_000;

  constructor(private readonly db: AppDb) {}

  async all(): Promise<RateLimitPolicy[]> {
    if (Date.now() - this.loadedAt < RateLimitPolicies.TTL_MS) return this.cache;
    // Collapse a stampede: on a cold cache under load, one query, not hundreds.
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    await this.loading;
    return this.cache;
  }

  private async load(): Promise<void> {
    const rows = await this.db.read().execute<RawPolicy>(sql`
      SELECT id, route_group, subject_kind, subject_id, max_requests, window_seconds,
             burst, action, priority, enabled, note, expires_at
      FROM rate_limit_policies
      WHERE enabled AND (expires_at IS NULL OR expires_at > now())
    `);
    this.cache = rows.rows.map(toPolicy);
    this.loadedAt = Date.now();
  }

  /** Force the next read to hit the database. Called after any write. */
  invalidate(): void {
    this.loadedAt = 0;
  }

  /**
   * The one policy that applies to this subject on this route group.
   *
   * Most specific wins, in this order:
   *   1. an exact subject id  (this customer, this abusive IP)
   *   2. a subject kind       (all users / all IPs)
   *   3. `*`                  (anything)
   * and within each, a named route group beats `*`. `priority` breaks ties,
   * so an incident override can be made to win without renaming anything.
   */
  async resolve(
    subject: RateLimitSubject,
    routeGroup: string,
  ): Promise<RateLimitPolicy | undefined> {
    const candidates = (await this.all()).filter(
      (policy) =>
        (policy.routeGroup === routeGroup || policy.routeGroup === '*') &&
        (policy.subjectKind === subject.kind || policy.subjectKind === '*') &&
        (policy.subjectId === null || policy.subjectId === subject.id),
    );

    return candidates.sort(
      (a, b) => specificity(b, subject, routeGroup) - specificity(a, subject, routeGroup),
    )[0];
  }

  async upsert(policy: Omit<RateLimitPolicy, 'id'> & { id?: string }): Promise<string> {
    const id = policy.id ?? uuidv7();
    await this.db.write().execute(sql`
      INSERT INTO rate_limit_policies
        (id, route_group, subject_kind, subject_id, max_requests, window_seconds, burst,
         action, priority, enabled, note, expires_at)
      VALUES
        (${id}, ${policy.routeGroup}, ${policy.subjectKind}, ${policy.subjectId},
         ${policy.maxRequests}, ${policy.windowSeconds}, ${policy.burst}, ${policy.action},
         ${policy.priority}, ${policy.enabled}, ${policy.note}, ${policy.expiresAt})
      ON CONFLICT (route_group, subject_kind, coalesce(subject_id, '')) DO UPDATE SET
        max_requests = excluded.max_requests,
        window_seconds = excluded.window_seconds,
        burst = excluded.burst,
        action = excluded.action,
        priority = excluded.priority,
        enabled = excluded.enabled,
        note = excluded.note,
        expires_at = excluded.expires_at,
        updated_at = now()
    `);
    this.invalidate();
    return id;
  }

  async delete(id: string): Promise<void> {
    await this.db.write().execute(sql`DELETE FROM rate_limit_policies WHERE id = ${id}`);
    this.invalidate();
  }

  /**
   * Block one subject for a while. The bluntest tool in the console, and the
   * one an operator actually reaches for at 3am — so it is a policy row with an
   * expiry rather than a separate mechanism that outlives the incident.
   */
  async block(subject: RateLimitSubject, minutes: number, note: string): Promise<string> {
    return this.upsert({
      routeGroup: '*',
      subjectKind: subject.kind,
      subjectId: subject.id,
      maxRequests: 0,
      windowSeconds: 60,
      burst: null,
      action: 'reject',
      priority: 1000,
      enabled: true,
      note,
      expiresAt: new Date(Date.now() + minutes * 60_000),
    });
  }
}

function specificity(
  policy: RateLimitPolicy,
  subject: RateLimitSubject,
  routeGroup: string,
): number {
  let score = policy.priority;
  if (policy.subjectId === subject.id) score += 400;
  if (policy.subjectKind === subject.kind) score += 200;
  if (policy.routeGroup === routeGroup) score += 100;
  return score;
}

interface RawPolicy {
  [column: string]: unknown;
  id: string;
  route_group: string;
  subject_kind: string;
  subject_id: string | null;
  max_requests: number;
  window_seconds: number;
  burst: number | null;
  action: string;
  priority: number;
  enabled: boolean;
  note: string | null;
  expires_at: string | null;
}

function toPolicy(row: RawPolicy): RateLimitPolicy {
  return {
    id: row.id,
    routeGroup: row.route_group,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    maxRequests: row.max_requests,
    windowSeconds: row.window_seconds,
    burst: row.burst,
    action: row.action as RateLimitPolicy['action'],
    priority: row.priority,
    enabled: row.enabled,
    note: row.note,
    expiresAt: toDateOrNull(row.expires_at),
  };
}
