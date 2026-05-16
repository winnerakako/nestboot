/**
 * Typed event map for the application.
 * Every event and its payload is defined here — single source of truth.
 *
 * When adding a new event:
 *   1. Add the event name + payload type below
 *   2. Emit via: this.events.emit('your.event', payload)
 *   3. Listen via: @OnEvent('your.event') handler(payload: EventMap['your.event']) { ... }
 *
 * TypeScript will enforce correct payloads at emit time and correct types at listen time.
 *
 * Extend this interface in your project with your domain events.
 */
export interface EventMap {
  // ─── Scaffold Events (built-in) ───────────────────────
  'app.ready': { timestamp: Date };
  'app.shutdown': { reason: string };

  // ─── Webhook Events ───────────────────────────────────
  'webhook.received': {
    provider: string;
    eventType: string;
    payload: any;
    requestId?: string;
  };

  // ─── Cron Events ────────────────────────────────────────
  'cron.alert': {
    cronName: string;
    category?: string;
    consecutiveFailures: number;
    lastError?: string;
    lastRunStatus: string;
    lastRunDuration: number;
    timestamp: Date;
  };

  // ─── Add your domain events below ─────────────────────
  // 'user.created': { userId: string; email: string };
  // 'user.deleted': { userId: string };
  // 'payment.confirmed': { paymentId: string; amount: number; currency: string };
  // 'payment.failed': { paymentId: string; reason: string };
  // 'loan.approved': { loanId: string; userId: string; amount: number };
  // 'loan.defaulted': { loanId: string; userId: string };
  // 'notification.send': { to: string; template: string; context: Record<string, any> };
}

/**
 * All known event names. Use for autocomplete and validation.
 */
export type EventName = keyof EventMap;
