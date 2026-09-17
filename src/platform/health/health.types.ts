/**
 * Health has three states, not two.
 *
 * `unknown` is the important one: a check that cannot reach the thing it
 * observes must say so, because "I could not look" and "nothing is wrong" are
 * different facts and reporting the second when the first is true is how an
 * outage stays invisible for an hour.
 */
export type HealthStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface HealthCheckResult {
  status: HealthStatus;
  /** One line an operator reads at 3am. Say what is wrong, not that something is. */
  detail?: string;
  data?: Record<string, unknown>;
  durationMs?: number;
}

export interface HealthCheck {
  readonly name: string;
  /**
   * A failing critical check makes the process unready and takes it out of the
   * load balancer. Reserve it for things that make every request fail — the
   * product database, not the backup age.
   */
  readonly critical: boolean;
  run(): Promise<HealthCheckResult>;
}

export interface HealthReport {
  status: HealthStatus;
  ready: boolean;
  role: string;
  version: string;
  uptimeSeconds: number;
  checkedAt: string;
  checks: Array<HealthCheckResult & { name: string; critical: boolean }>;
}

export const HEALTH_CHECK = Symbol('HEALTH_CHECK');

const RANK: Record<HealthStatus, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

/** A group is as healthy as its worst member. */
export function worstStatus(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'ok');
}
