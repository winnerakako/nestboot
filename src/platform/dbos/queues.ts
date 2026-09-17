import { WorkflowQueue } from '@dbos-inc/dbos-sdk';

/**
 * Every queue in the app, declared once.
 *
 * A queue is a concurrency budget with a name, and the reason they are all here
 * rather than next to the work is isolation: if the mail queue can occupy every
 * worker slot, one slow SMTP host stops payments. Naming them in one file makes
 * "what can starve what" a question you can answer by reading twenty lines.
 *
 * `workerConcurrency` is per process, so total in-flight work is this times the
 * number of worker containers. `rateLimit` is global and is the one to reach
 * for when a third party publishes a quota.
 */
export const Queues = {
  /** Anything without a reason to be elsewhere. */
  default: new WorkflowQueue('default', { workerConcurrency: 10 }),

  /** Outbound mail, rate-limited to stay under a typical provider's quota. */
  mail: new WorkflowQueue('mail', {
    workerConcurrency: 5,
    rateLimit: { limitPerPeriod: 100, periodSec: 60 },
  }),

  /** Domain-event listeners. Wide, because handlers are usually small. */
  events: new WorkflowQueue('events', { workerConcurrency: 20 }),

  /** Inbound webhook processing. Wide: a provider retry storm must drain fast. */
  webhooksIn: new WorkflowQueue('webhooks-in', { workerConcurrency: 20 }),

  /** Outbound webhook delivery. Narrow: a dead endpoint must not occupy the fleet. */
  webhooksOut: new WorkflowQueue('webhooks-out', { workerConcurrency: 5 }),

  /**
   * Partition maintenance, retention sweeps, backups.
   * Narrow on purpose: housekeeping is never the thing that should win a
   * contended moment against a user-facing job.
   */
  housekeeping: new WorkflowQueue('housekeeping', { workerConcurrency: 2 }),
} as const;

export type QueueName = (typeof Queues)[keyof typeof Queues]['name'];

export function allQueues(): WorkflowQueue[] {
  return Object.values(Queues);
}

export function queueByName(name: string): WorkflowQueue | undefined {
  return allQueues().find((q) => q.name === name);
}
