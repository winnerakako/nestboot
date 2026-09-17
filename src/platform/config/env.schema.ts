import { z } from 'zod';

/**
 * The one place environment is described. Boot reads this once and fails with
 * every problem at once; nothing downstream ever touches `process.env`.
 *
 * A default here is a decision: it means "this value is safe to omit". Anything
 * that is unsafe to guess has no default and the app refuses to start without it.
 */

const bool = (fallback: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
    .default(fallback)
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1' || v === 'yes'));

const int = (fallback: number) => z.coerce.number().int().default(fallback);

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const postgresUrl = z
  .string()
  .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
    message: 'must be a postgres:// connection string',
  });

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /**
     * Which half of the app this process is. `web` serves HTTP and never runs a
     * workflow; `worker` runs workflows and schedules and serves no HTTP. Ship
     * the split from day one even when one container runs `all` — retrofitting
     * it once a workflow depends on request-scoped state is a rewrite.
     */
    ROLE: z.enum(['web', 'worker', 'all']).default('all'),

    APP_NAME: z.string().min(1).default('nestboot'),
    APP_URL: z.url().default('http://localhost:3000'),
    HOST: z.string().default('0.0.0.0'),
    PORT: int(3000),

    /** Signs cookies and ops sessions. No default, deliberately. */
    APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),

    /** Stamped into every log line and shown in /ops -> Health -> Config. */
    GIT_SHA: z.string().default('unknown'),

    // ---- data ----------------------------------------------------------
    DATABASE_URL: postgresUrl,
    /** Optional read replica. Falls back to DATABASE_URL, so `db.read()` is always valid. */
    DATABASE_READ_URL: postgresUrl.optional(),
    /** Telemetry lives in its own database from the first commit. See BLUEPRINT §5. */
    OPS_DATABASE_URL: postgresUrl,
    DATABASE_POOL_SIZE: int(10),
    OPS_DATABASE_POOL_SIZE: int(5),
    DATABASE_STATEMENT_TIMEOUT_MS: int(15_000),

    // ---- observability -------------------------------------------------
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    LOG_PRETTY: bool(false),
    /** Ship log lines to ops.logs. Errors and slow requests bypass sampling. */
    OPS_LOGS_ENABLED: bool(true),
    OPS_REQUESTS_ENABLED: bool(true),
    /** Fraction of ordinary requests recorded, 0..1. Errors and slow requests are always kept. */
    OPS_REQUEST_SAMPLE: z.coerce.number().min(0).max(1).default(1),
    OPS_SLOW_REQUEST_MS: int(1000),

    // ---- security ------------------------------------------------------
    /**
     * No default beyond "deny": an empty CORS_ORIGINS denies every cross-origin
     * request rather than allowing every one.
     */
    CORS_ORIGINS: csv,
    /** Must name the load balancer's CIDRs, or clients forge X-Forwarded-For. */
    TRUST_PROXY: z.string().default(''),
    BODY_LIMIT_BYTES: int(1_048_576),

    OPS_ENABLED: bool(true),
    OPS_PATH: z.string().default('/ops'),
    OPS_IP_ALLOWLIST: csv,
    OPS_SESSION_HOURS: int(12),
    OPS_MAX_LOGIN_ATTEMPTS: int(5),
    OPS_LOCKOUT_MINUTES: int(15),

    /**
     * Bootstraps the first operator account, and only when none exists — so it
     * can never silently reset a password somebody later changed. Remove both
     * from the environment once TOTP is enrolled.
     */
    OPS_USERNAME: z.string().min(1).default('admin'),
    OPS_PASSWORD: z.string().optional(),

    // ---- background ----------------------------------------------------
    DBOS_APP_VERSION: z.string().optional(),
    /** Retention, in days, for each class of operational data. */
    RETENTION_LOGS_DAYS: int(14),
    RETENTION_REQUESTS_DAYS: int(30),
    RETENTION_ERRORS_DAYS: int(90),
    RETENTION_SECURITY_DAYS: int(180),
    RETENTION_WORKFLOWS_DAYS: int(30),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    // Production-only refusals. Each of these is a default that is fine on a
    // laptop and a vulnerability on the internet, so it fails at deploy rather
    // than sitting quietly wrong.
    if (!env.TRUST_PROXY) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message:
          'required in production: set it to the load balancer CIDR (e.g. 10.0.0.0/8), or ' +
          'clients can spoof X-Forwarded-For and defeat IP rate limiting',
      });
    }
    if (env.APP_URL.startsWith('http://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'must be https:// in production — cookies are issued Secure',
      });
    }
    // A short console password in production is a short password on the thing
    // that can cancel payments and read every log line.
    if (env.OPS_PASSWORD !== undefined && env.OPS_PASSWORD.length < 16) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPS_PASSWORD'],
        message:
          'must be at least 16 characters in production — it is the bootstrap credential for ' +
          'the operator console. Generate one: openssl rand -base64 24',
      });
    }
    if (env.OPS_REQUEST_SAMPLE === 0 && env.OPS_REQUESTS_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPS_REQUEST_SAMPLE'],
        message: 'is 0 while OPS_REQUESTS_ENABLED is true — set OPS_REQUESTS_ENABLED=false instead',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** Keys whose values are never printed, logged, or rendered in /ops. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'APP_SECRET',
  'DATABASE_URL',
  'DATABASE_READ_URL',
  'OPS_DATABASE_URL',
  'OPS_PASSWORD',
  'OPS_TOTP_SECRET',
  'S3_SECRET_ACCESS_KEY',
]);
