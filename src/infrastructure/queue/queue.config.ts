/**
 * Default job options applied to all queues unless overridden.
 * These are production-safe defaults.
 */
export const DEFAULT_JOB_OPTIONS = {
  /** Number of retry attempts on failure */
  attempts: 3,
  /** Exponential backoff between retries */
  backoff: {
    type: 'exponential' as const,
    delay: 1000, // 1s, 2s, 4s
  },
  /** Remove completed jobs after 24 hours (keeps Redis clean) */
  removeOnComplete: {
    age: 86400, // 24 hours in seconds
    count: 1000, // Keep last 1000 completed jobs
  },
  /** Keep failed jobs for 7 days for debugging */
  removeOnFail: {
    age: 604800, // 7 days in seconds
    count: 5000, // Keep last 5000 failed jobs
  },
};

/**
 * Default worker options.
 */
export const DEFAULT_WORKER_OPTIONS = {
  /** Max concurrent jobs per worker */
  concurrency: 5,
  /** Lock duration — how long a job can run before being considered stalled */
  lockDuration: 60000, // 60 seconds
  /** How often to check for stalled jobs */
  stalledInterval: 30000, // 30 seconds
  /** Max stalled count before marking as failed */
  maxStalledCount: 2,
};
