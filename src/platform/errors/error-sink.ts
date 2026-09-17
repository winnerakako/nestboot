import { createHash } from 'node:crypto';
import type { CorrelationContext } from '../logging/correlation.js';

/**
 * Where a caught exception goes to be counted.
 *
 * An interface rather than a direct write so that the exception filter — which
 * runs on the worst request of the day — never depends on the telemetry
 * database being reachable. See `PostgresErrorSink` for the real one and
 * `NoopErrorSink` for what runs when recording is off.
 */
export interface ErrorSink {
  record(event: ErrorEvent): void;
}

export interface ErrorEvent {
  fingerprint: string;
  type: string;
  message: string;
  stack?: string;
  status: number;
  context: CorrelationContext;
  occurredAt: Date;
}

export const ERROR_SINK = Symbol('ERROR_SINK');

export class NoopErrorSink implements ErrorSink {
  record(): void {}
}

const FRAME = /at\s+(?:(.+?)\s+\()?(?:(.+?):(\d+):\d+)\)?/;

/**
 * Group occurrences of the same bug.
 *
 * Deliberately excludes the message: "no user with id 41" and "no user with id
 * 42" are one bug, and a fingerprint that includes the id produces one group
 * per request, which is the same as having no grouping at all. Line numbers are
 * included, so a release that moves code starts new groups — which is the
 * honest answer, since the old group's stack no longer points anywhere real.
 */
export function fingerprint(error: Error, extra: string[] = []): string {
  const frames: string[] = [];
  for (const line of (error.stack ?? '').split('\n').slice(1)) {
    if (frames.length >= 5) break;
    if (line.includes('node_modules') || line.includes('node:internal')) continue;
    const match = FRAME.exec(line);
    if (match) frames.push(`${match[1] ?? '<anon>'}@${match[2]}:${match[3]}`);
  }
  // With no app frames at all, fall back to the constructor name so the group
  // is at least stable, rather than hashing an empty string for every error.
  const parts = [error.name, ...extra, ...(frames.length > 0 ? frames : ['<no-app-frames>'])];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}
