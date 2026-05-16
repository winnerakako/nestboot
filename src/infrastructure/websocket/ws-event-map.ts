/**
 * Typed WebSocket event map.
 * Every WS event and its payload is defined here.
 *
 * Server → Client events: what the server pushes to clients
 * Client → Server events: what clients can send to the server
 *
 * Extend this in your project with your domain events.
 */

// ─── Server → Client Events ─────────────────────────────

export interface WsServerEvents {
  /** Server is shutting down — client should prepare to reconnect */
  'server:shutdown': { message: string; reconnectAfterMs: number };

  /** Connection rate limited */
  'error:rate-limited': { message: string };

  /** Max connections exceeded */
  'error:max-connections': { message: string; max: number };

  // ─── Add your domain events below ─────────────────────
  // 'notification:new': { id: string; title: string; body: string };
  // 'payment:confirmed': { paymentId: string; amount: number };
  // 'loan:status-changed': { loanId: string; status: string };
  // 'device:locked': { deviceId: string; reason: string };
}

// ─── Client → Server Events ─────────────────────────────

export interface WsClientEvents {
  /** Ping — health check */
  ping: any;

  /** Join a custom room */
  'room:join': { room: string };

  /** Leave a custom room */
  'room:leave': { room: string };

  // ─── Add your domain events below ─────────────────────
  // 'chat:send': { to: string; message: string };
  // 'presence:typing': { conversationId: string };
}
