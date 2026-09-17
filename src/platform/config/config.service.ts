import { Injectable } from '@nestjs/common';
import { type Env, EnvSchema, SECRET_KEYS } from './env.schema.js';

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parse the environment or die. Called once, before Nest exists, so a bad
 * deploy fails in the first second with every problem listed rather than on the
 * first request that happens to read the missing key.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;

  throw new ConfigError(
    result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  );
}

@Injectable()
export class ConfigService {
  constructor(private readonly env: Env) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }

  get all(): Readonly<Env> {
    return this.env;
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }

  /** True when this process serves HTTP. */
  get servesHttp(): boolean {
    return this.env.ROLE === 'web' || this.env.ROLE === 'all';
  }

  /** True when this process executes workflows, jobs and schedules. */
  get runsWorkflows(): boolean {
    return this.env.ROLE === 'worker' || this.env.ROLE === 'all';
  }

  /** `db.read()` is always valid: without a replica it is the primary. */
  get readUrl(): string {
    return this.env.DATABASE_READ_URL ?? this.env.DATABASE_URL;
  }

  /**
   * Every resolved value with secrets replaced by a fingerprint. This is what
   * /ops -> Health -> Config renders: enough to tell two deployments apart and
   * to confirm a value changed, never enough to use.
   */
  masked(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.env)) {
      out[key] = SECRET_KEYS.has(key) ? maskSecret(value) : value;
    }
    return out;
  }
}

function maskSecret(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(unset)';
  const str = String(value);
  // A connection string's host is operationally useful and not a secret; its
  // credentials are. Show the shape, never the password.
  try {
    const url = new URL(str);
    if (url.password) url.password = '***';
    if (url.username) url.username = `${url.username.slice(0, 2)}***`;
    return url.toString();
  } catch {
    return `${'*'.repeat(8)} (${str.length} chars)`;
  }
}
