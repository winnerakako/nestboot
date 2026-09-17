import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConfigService } from '../../config/index.js';
import { AppDb } from '../../db/app-db.service.js';
import { toDate } from '../../db/raw.js';

export const OPS_SESSION_COOKIE = 'ops_session';

export interface ActiveSession {
  tokenHash: string;
  userId: string;
  username: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Server-side sessions for the console.
 *
 * Postgres rows rather than a signed JWT, for one reason that matters here:
 * revocation. "Log every operator out now" has to be a single statement during
 * an incident, and a stateless token cannot be withdrawn before it expires.
 *
 * Only the SHA-256 of the cookie is stored. A database dump — or a backup, or a
 * screenshot of a support query — then contains no usable credential.
 */
@Injectable()
export class OpsSessions {
  constructor(
    private readonly db: AppDb,
    private readonly config: ConfigService,
  ) {}

  async create(userId: string, request: FastifyRequest, reply: FastifyReply): Promise<string> {
    // 32 bytes from the CSPRNG: not a uuid, which is structured and partly
    // predictable, and not a hash of anything the user controls.
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.get('OPS_SESSION_HOURS') * 3_600_000);

    await this.db.write().execute(sql`
      INSERT INTO ops_sessions (token_hash, user_id, expires_at, ip, user_agent)
      VALUES (${hash(token)}, ${userId}, ${expiresAt}, ${request.ip}::inet,
              ${userAgent(request)})
    `);

    void reply.setCookie(OPS_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: this.config.get('OPS_PATH'),
      expires: expiresAt,
      signed: false,
    });

    return token;
  }

  /**
   * Resolve the cookie to a live session, refreshing `last_seen_at`.
   *
   * Expiry and revocation are both checked in the query, so a revoked session
   * stops working on the next request rather than at its original expiry.
   */
  async resolve(request: FastifyRequest): Promise<ActiveSession | null> {
    const token = request.cookies?.[OPS_SESSION_COOKIE];
    if (!token) return null;

    const rows = await this.db.write().execute<RawSession>(sql`
      UPDATE ops_sessions s
      SET last_seen_at = now()
      FROM ops_users u
      WHERE s.token_hash = ${hash(token)}
        AND s.user_id = u.id
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.disabled_at IS NULL
      RETURNING s.token_hash, s.user_id, u.username, s.created_at, s.last_seen_at,
                s.expires_at, s.ip::text AS ip, s.user_agent
    `);

    const row = rows.rows[0];
    return row ? toSession(row) : null;
  }

  async revoke(tokenHash: string): Promise<void> {
    await this.db.write().execute(sql`
      UPDATE ops_sessions SET revoked_at = now() WHERE token_hash = ${tokenHash}
    `);
  }

  async revokeByToken(token: string): Promise<void> {
    await this.revoke(hash(token));
  }

  /** Every operator, out, now. The control an incident actually needs. */
  async revokeAll(): Promise<number> {
    const result = await this.db.write().execute(sql`
      UPDATE ops_sessions SET revoked_at = now() WHERE revoked_at IS NULL AND expires_at > now()
    `);
    return result.rowCount ?? 0;
  }

  async active(): Promise<ActiveSession[]> {
    const rows = await this.db.read().execute<RawSession>(sql`
      SELECT s.token_hash, s.user_id, u.username, s.created_at, s.last_seen_at,
             s.expires_at, s.ip::text AS ip, s.user_agent
      FROM ops_sessions s
      JOIN ops_users u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL AND s.expires_at > now()
      ORDER BY s.last_seen_at DESC
    `);
    return rows.rows.map(toSession);
  }

  clearCookie(reply: FastifyReply): void {
    void reply.clearCookie(OPS_SESSION_COOKIE, { path: this.config.get('OPS_PATH') });
  }

  /** Housekeeping: expired rows are unreadable and only cost space. */
  async prune(): Promise<number> {
    const result = await this.db.write().execute(sql`
      DELETE FROM ops_sessions WHERE expires_at < now() - interval '7 days'
    `);
    return result.rowCount ?? 0;
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function userAgent(request: FastifyRequest): string | null {
  const value = request.headers['user-agent'];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.slice(0, 500) ?? null;
}

interface RawSession {
  [column: string]: unknown;
  token_hash: string;
  user_id: string;
  username: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
}

function toSession(row: RawSession): ActiveSession {
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    username: row.username,
    createdAt: toDate(row.created_at),
    lastSeenAt: toDate(row.last_seen_at),
    expiresAt: toDate(row.expires_at),
    ip: row.ip,
    userAgent: row.user_agent,
  };
}
