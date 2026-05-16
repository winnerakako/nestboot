import { AsyncLocalStorage } from 'async_hooks';

interface LogRequestContext {
  requestId?: string;
  userId?: string;
  dbQueries: {
    model: string;
    operation: string;
    duration: number;
  }[];
  spans: { name: string; start: number; duration?: number }[];
}

const asyncStorage = new AsyncLocalStorage<LogRequestContext>();

/**
 * Request-scoped context for correlating logs, queries, and spans
 * to a single HTTP request via AsyncLocalStorage.
 *
 * Uses `enterWith()` so the context persists across the entire async
 * chain — including DB queries and service calls that execute after
 * the synchronous interceptor setup.
 */
export const LogContext = {
  /**
   * Enter a request context. Called by the RequestLoggerInterceptor.
   * Unlike `run()`, `enterWith()` persists through the full async chain.
   */
  enter(context: Partial<LogRequestContext>) {
    const ctx: LogRequestContext = {
      requestId: context.requestId,
      userId: context.userId,
      dbQueries: [],
      spans: [],
    };
    asyncStorage.enterWith(ctx);
  },

  get(): LogRequestContext | undefined {
    return asyncStorage.getStore();
  },

  getRequestId(): string | undefined {
    return asyncStorage.getStore()?.requestId;
  },

  getUserId(): string | undefined {
    return asyncStorage.getStore()?.userId;
  },

  recordQuery(model: string, operation: string, duration: number) {
    const ctx = asyncStorage.getStore();
    if (ctx) {
      ctx.dbQueries.push({ model, operation, duration });
    }
  },

  startSpan(name: string) {
    const ctx = asyncStorage.getStore();
    if (ctx) {
      ctx.spans.push({ name, start: Date.now() });
    }
  },

  endSpan(name: string) {
    const ctx = asyncStorage.getStore();
    if (!ctx) return;
    const span = ctx.spans.find((s) => s.name === name && !s.duration);
    if (span) {
      span.duration = Date.now() - span.start;
    }
  },
};
