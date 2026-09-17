import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '../config/index.js';
import {
  HEALTH_CHECK,
  type HealthCheck,
  type HealthReport,
  type HealthStatus,
  worstStatus,
} from './health.types.js';

const BOOTED_AT = Date.now();

@Injectable()
export class HealthService {
  constructor(
    @Inject(HEALTH_CHECK) private readonly checks: HealthCheck[],
    private readonly config: ConfigService,
  ) {}

  /**
   * Runs every check concurrently. One slow check must not hide the others, so
   * each is bounded independently and a timeout reports `unknown` rather than
   * failing the whole report — the other checks' answers are still true.
   */
  async report(timeoutMs = 3_000): Promise<HealthReport> {
    const results = await Promise.all(
      this.checks.map(async (check) => {
        const outcome = await Promise.race([
          check.run(),
          sleep(timeoutMs).then(
            () =>
              ({
                status: 'unknown' as HealthStatus,
                detail: `check did not answer within ${timeoutMs}ms`,
              }) as const,
          ),
        ]);
        return { name: check.name, critical: check.critical, ...outcome };
      }),
    );

    const status = worstStatus(results.map((r) => r.status));
    // Readiness is about critical checks only. A degraded telemetry database
    // should not pull a healthy process out of the load balancer.
    const ready = results.every((r) => !r.critical || r.status === 'ok');

    return {
      status,
      ready,
      role: this.config.get('ROLE'),
      version: this.config.get('GIT_SHA'),
      uptimeSeconds: Math.floor((Date.now() - BOOTED_AT) / 1000),
      checkedAt: new Date().toISOString(),
      checks: results,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
