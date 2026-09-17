import { describe, expect, it } from 'vitest';
import { ConfigError, ConfigService, loadEnv } from './config.service.js';

const valid = {
  APP_SECRET: 'a'.repeat(32),
  DATABASE_URL: 'postgres://u:p@localhost:5443/app',
  OPS_DATABASE_URL: 'postgres://u:p@localhost:5443/ops',
};

describe('environment validation', () => {
  it('reports every problem at once, not the first', () => {
    // A deploy that fails three times because each run reveals one more missing
    // variable is three deploys. Fail once, with the whole list.
    try {
      loadEnv({ DATABASE_URL: 'not-a-postgres-url' } as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems.join('\n');
      expect(problems).toContain('APP_SECRET');
      expect(problems).toContain('DATABASE_URL');
      expect(problems).toContain('OPS_DATABASE_URL');
    }
  });

  it('rejects an APP_SECRET short enough to be guessed', () => {
    expect(() => loadEnv({ ...valid, APP_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(
      /at least 32/,
    );
  });

  it('denies all cross-origin requests when CORS_ORIGINS is unset', () => {
    expect(loadEnv(valid as NodeJS.ProcessEnv).CORS_ORIGINS).toEqual([]);
  });

  it('coerces the string booleans that real environments actually contain', () => {
    const env = loadEnv({ ...valid, LOG_PRETTY: 'true', OPS_ENABLED: '0' } as NodeJS.ProcessEnv);
    expect(env.LOG_PRETTY).toBe(true);
    expect(env.OPS_ENABLED).toBe(false);
  });

  describe('in production', () => {
    const prod = { ...valid, NODE_ENV: 'production', APP_URL: 'https://example.com' };

    it('refuses to start without TRUST_PROXY, which would let clients spoof their IP', () => {
      expect(() => loadEnv(prod as NodeJS.ProcessEnv)).toThrow(/TRUST_PROXY/);
    });

    it('refuses a plaintext APP_URL, because cookies are issued Secure', () => {
      expect(() =>
        loadEnv({
          ...prod,
          TRUST_PROXY: '10.0.0.0/8',
          APP_URL: 'http://example.com',
        } as NodeJS.ProcessEnv),
      ).toThrow(/https/);
    });

    it('accepts a correctly configured production environment', () => {
      const env = loadEnv({ ...prod, TRUST_PROXY: '10.0.0.0/8' } as NodeJS.ProcessEnv);
      expect(env.NODE_ENV).toBe('production');
    });
  });
});

describe('ConfigService', () => {
  it('derives the role split rather than making every caller re-read ROLE', () => {
    const web = new ConfigService(loadEnv({ ...valid, ROLE: 'web' } as NodeJS.ProcessEnv));
    expect(web.servesHttp).toBe(true);
    expect(web.runsWorkflows).toBe(false);

    const worker = new ConfigService(loadEnv({ ...valid, ROLE: 'worker' } as NodeJS.ProcessEnv));
    expect(worker.servesHttp).toBe(false);
    expect(worker.runsWorkflows).toBe(true);

    const all = new ConfigService(loadEnv({ ...valid, ROLE: 'all' } as NodeJS.ProcessEnv));
    expect(all.servesHttp && all.runsWorkflows).toBe(true);
  });

  it('makes read() valid without a replica by falling back to the primary', () => {
    expect(new ConfigService(loadEnv(valid as NodeJS.ProcessEnv)).readUrl).toBe(valid.DATABASE_URL);

    const withReplica = new ConfigService(
      loadEnv({ ...valid, DATABASE_READ_URL: 'postgres://u:p@replica/app' } as NodeJS.ProcessEnv),
    );
    expect(withReplica.readUrl).toBe('postgres://u:p@replica/app');
  });

  describe('the masked view /ops renders', () => {
    const masked = new ConfigService(loadEnv(valid as NodeJS.ProcessEnv)).masked();

    it('never exposes a database password', () => {
      expect(JSON.stringify(masked)).not.toContain('p@');
      expect(String(masked.DATABASE_URL)).toContain('***');
    });

    it('keeps the host visible, because that is what tells deployments apart', () => {
      expect(String(masked.DATABASE_URL)).toContain('localhost:5443');
    });

    it('never exposes the app secret in any form', () => {
      expect(String(masked.APP_SECRET)).not.toContain('aaaa');
      expect(String(masked.APP_SECRET)).toContain('32 chars');
    });

    it('leaves non-secret values readable', () => {
      expect(masked.LOG_LEVEL).toBe('info');
      expect(masked.PORT).toBe(3000);
    });
  });
});
