import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The thread that ties a request to the job it enqueued, to the workflow that
 * job started, to the step that failed, to the log line that explains it.
 *
 * It lives in AsyncLocalStorage rather than being threaded through call
 * signatures because the alternative is every function in the app taking a
 * context parameter it does not use, and the first one that forgets breaks the
 * chain silently.
 */
export interface CorrelationContext {
  requestId?: string;
  /** The Fastify route *pattern* (`POST /loans/:id/approve`), never the concrete URL. */
  route?: string;
  method?: string;
  /** Filled in once the response is known, so an error line carries its status. */
  status?: number;
  feature?: string;
  group?: string;
  workflowId?: string;
  jobId?: string;
  step?: string;
  userId?: string;
  /** W3C traceparent trace-id, when one arrived on the request. */
  traceId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export const Correlation = {
  /** Run `fn` with this context. Nested calls merge onto the enclosing one. */
  run<T>(context: CorrelationContext, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...context }, fn);
  },

  get(): CorrelationContext {
    return storage.getStore() ?? {};
  },

  /**
   * Add fields to the *current* context in place.
   *
   * Intentional: this mutates the active store rather than starting a new one,
   * so a value discovered mid-request (the resolved user, the workflow id) is
   * visible to log lines already in flight further up the same async chain.
   * It is a no-op outside a `run()`, which is what makes it safe to call from
   * library code that may run either way.
   */
  merge(fields: CorrelationContext): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },

  get requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },
};
