/**
 * Typed stream map for the application.
 * Every stream and its payload is defined here — single source of truth.
 *
 * When adding a new stream:
 *   1. Add the stream name + payload type below
 *   2. Publish via: this.stream.publish('your.stream', payload)
 *   3. Consume via: BaseStreamConsumer with { stream: 'your.stream' }
 *
 * Extend this interface in your project with your domain streams.
 */
export interface StreamMap {
  // ─── Add your domain streams below ─────────────────────
  // 'payment.confirmed': { paymentId: string; loanId: string; amount: number; currency: string };
  // 'payment.failed': { paymentId: string; reason: string };
  // 'loan.approved': { loanId: string; userId: string; amount: number };
  // 'loan.defaulted': { loanId: string; userId: string; daysOverdue: number };
  // 'user.created': { userId: string; email: string };
  // 'device.locked': { deviceId: string; loanId: string; reason: string };
}

export type StreamName = keyof StreamMap;
