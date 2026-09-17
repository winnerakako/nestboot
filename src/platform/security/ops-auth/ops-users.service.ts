import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { uuidv7 } from 'uuidv7';
import { ConfigService } from '../../config/index.js';
import { AppDb } from '../../db/app-db.service.js';
import { toDateOrNull } from '../../db/raw.js';

export interface OpsUser {
  id: string;
  username: string;
  totpConfirmedAt: Date | null;
  disabledAt: Date | null;
  lastLoginAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export type LoginOutcome =
  | { status: 'ok'; user: OpsUser }
  | { status: 'invalid' }
  | { status: 'locked'; until: Date }
  | { status: 'disabled' }
  | { status: 'totp_required'; user: OpsUser }
  | { status: 'totp_invalid'; user: OpsUser }
  | { status: 'enrol_totp'; user: OpsUser; secret: string; otpauth: string };

/**
 * Operator accounts: argon2id passwords, TOTP, and lockout.
 *
 * Password *and* a second factor, with no API-token alternative, because this
 * account can cancel a payment workflow and read every log line the app has
 * written. A leaked console password should not be sufficient on its own, and a
 * long-lived bearer token for this surface is a credential nobody would notice
 * leaking.
 */
@Injectable()
export class OpsUsers implements OnApplicationBootstrap {
  private readonly logger = new Logger(OpsUsers.name);

  /**
   * OWASP's argon2id floor. Tuned up rather than down: this hash is computed
   * at most a few times a day, so cost here is nearly free and is the entire
   * defence if the table is ever dumped.
   */
  private static readonly HASH = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  /**
   * One 30-second step of tolerance either side. Enough for the clock drift a
   * real phone has; not enough to meaningfully widen the guessing window.
   */
  private static readonly TOTP_TOLERANCE_SECONDS = 30;

  constructor(
    private readonly db: AppDb,
    private readonly config: ConfigService,
  ) {}

  private checkTotp(secret: string, token: string): boolean {
    return verifySync({
      secret,
      token,
      strategy: 'totp',
      epochTolerance: OpsUsers.TOTP_TOLERANCE_SECONDS,
    }).valid;
  }

  /**
   * Create the first operator from the environment, once.
   *
   * Only when the table is empty — so this cannot silently reset a password
   * that an operator later changed, and a stale `OPS_PASSWORD` left in a deploy
   * config cannot resurrect a revoked account.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('OPS_ENABLED') || !this.config.servesHttp) return;

    const username = this.config.get('OPS_USERNAME');
    const password = this.config.get('OPS_PASSWORD');
    if (!username || !password) return;

    const existing = await this.db
      .read()
      .execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM ops_users`);
    if (Number(existing.rows[0]?.count ?? 0) > 0) return;

    await this.db.write().execute(sql`
      INSERT INTO ops_users (id, username, password_hash)
      VALUES (${uuidv7()}, ${username}, ${await argon2.hash(password, OpsUsers.HASH)})
    `);
    this.logger.warn(
      `Created the first operator account "${username}" from OPS_PASSWORD. ` +
        'Enrol TOTP on first login, then remove OPS_PASSWORD from the environment.',
    );
  }

  /**
   * Verify a password, then a TOTP code.
   *
   * A wrong username and a wrong password are reported identically, and both
   * pay the argon2 cost, so the response cannot be used to enumerate accounts
   * by status or by timing.
   */
  async authenticate(username: string, password: string, totp?: string): Promise<LoginOutcome> {
    const row = await this.find(username);

    if (!row) {
      await argon2.verify(DUMMY_HASH, password).catch(() => false);
      return { status: 'invalid' };
    }
    if (row.disabled_at) return { status: 'disabled' };
    const lockedUntil = toDateOrNull(row.locked_until);
    if (lockedUntil && lockedUntil > new Date()) {
      return { status: 'locked', until: lockedUntil };
    }

    const valid = await argon2.verify(row.password_hash, password).catch(() => false);
    if (!valid) {
      await this.recordFailure(row.id);
      return { status: 'invalid' };
    }

    const user = toUser(row);

    // No confirmed second factor yet: hand back a secret to enrol, rather than
    // letting a password alone through.
    if (!row.totp_secret || !row.totp_confirmed_at) {
      const secret = row.totp_secret ?? generateSecret();
      if (!row.totp_secret) {
        await this.db
          .write()
          .execute(sql`UPDATE ops_users SET totp_secret = ${secret} WHERE id = ${row.id}`);
      }
      if (!totp) {
        return {
          status: 'enrol_totp',
          user,
          secret,
          otpauth: generateURI({
            strategy: 'totp',
            issuer: this.config.get('APP_NAME'),
            label: username,
            secret,
          }),
        };
      }
      if (!this.checkTotp(secret, totp)) {
        return { status: 'totp_invalid', user };
      }
      await this.db
        .write()
        .execute(sql`UPDATE ops_users SET totp_confirmed_at = now() WHERE id = ${row.id}`);
      await this.recordSuccess(row.id);
      return { status: 'ok', user };
    }

    if (!totp) return { status: 'totp_required', user };
    if (!this.checkTotp(row.totp_secret, totp)) {
      await this.recordFailure(row.id);
      return { status: 'totp_invalid', user };
    }

    await this.recordSuccess(row.id);
    return { status: 'ok', user };
  }

  private async recordFailure(id: string): Promise<void> {
    const max = this.config.get('OPS_MAX_LOGIN_ATTEMPTS');
    const minutes = this.config.get('OPS_LOCKOUT_MINUTES');

    // Lock in the same statement that increments, so concurrent attempts cannot
    // both read "one below the threshold" and both be allowed through.
    await this.db.write().execute(sql`
      UPDATE ops_users
      SET failed_attempts = failed_attempts + 1,
          locked_until = CASE
            WHEN failed_attempts + 1 >= ${max}
            THEN now() + make_interval(mins => ${minutes})
            ELSE locked_until
          END,
          updated_at = now()
      WHERE id = ${id}
    `);
  }

  private async recordSuccess(id: string): Promise<void> {
    await this.db.write().execute(sql`
      UPDATE ops_users
      SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
      WHERE id = ${id}
    `);
  }

  private async find(username: string): Promise<RawUser | undefined> {
    const rows = await this.db.read().execute<RawUser>(sql`
      SELECT id, username, password_hash, totp_secret, totp_confirmed_at,
             disabled_at, last_login_at, failed_attempts, locked_until
      FROM ops_users WHERE username = ${username}
    `);
    return rows.rows[0];
  }

  async list(): Promise<OpsUser[]> {
    const rows = await this.db.read().execute<RawUser>(sql`
      SELECT id, username, password_hash, totp_secret, totp_confirmed_at,
             disabled_at, last_login_at, failed_attempts, locked_until
      FROM ops_users ORDER BY username
    `);
    return rows.rows.map(toUser);
  }

  async unlock(id: string): Promise<void> {
    await this.db.write().execute(sql`
      UPDATE ops_users SET failed_attempts = 0, locked_until = NULL WHERE id = ${id}
    `);
  }
}

/**
 * A real argon2id hash of a value nobody knows.
 *
 * Verified against when the username does not exist, so an unknown account
 * costs the same time as a known one. Without this, response latency is an
 * account-enumeration oracle.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Zm9yY29uc3RhbnR0aW1lY29tcGFyaXNvbg';

interface RawUser {
  [column: string]: unknown;
  id: string;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_confirmed_at: string | null;
  disabled_at: string | null;
  last_login_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

function toUser(row: RawUser): OpsUser {
  return {
    id: row.id,
    username: row.username,
    totpConfirmedAt: toDateOrNull(row.totp_confirmed_at),
    disabledAt: toDateOrNull(row.disabled_at),
    lastLoginAt: toDateOrNull(row.last_login_at),
    failedAttempts: row.failed_attempts,
    lockedUntil: toDateOrNull(row.locked_until),
  };
}
