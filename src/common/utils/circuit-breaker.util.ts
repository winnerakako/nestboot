import { Logger } from '@nestjs/common';

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms before attempting recovery (default: 60000) */
  resetTimeoutMs?: number;
  /** Number of successes in HALF_OPEN to close the circuit (default: 2) */
  successThreshold?: number;
  /** Label for logging */
  name?: string;
}

/**
 * Circuit breaker for external service calls.
 * Prevents cascading failures by short-circuiting calls
 * to a failing service.
 *
 * Usage:
 *   private readonly breaker = new CircuitBreaker({
 *     name: 'PaystackAPI',
 *     failureThreshold: 5,
 *     resetTimeoutMs: 30000,
 *   });
 *
 *   const result = await this.breaker.exec(() =>
 *     this.httpService.post('https://api.paystack.co/charge')
 *   );
 */
export class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly name: string;
  private readonly logger: Logger;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 60000;
    this.successThreshold = options.successThreshold ?? 2;
    this.name = options.name ?? 'CircuitBreaker';
    this.logger = new Logger(this.name);
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        this.logger.warn('Circuit half-open — testing recovery');
      } else {
        throw new Error(`${this.name}: Circuit is OPEN. Service unavailable.`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        this.logger.log('Circuit closed — service recovered');
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure() {
    this.failureCount++;
    this.successCount = 0;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.logger.error(`Circuit opened after ${this.failureCount} failures`);
    }
  }

  getState(): string {
    return this.state;
  }

  reset() {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.logger.log('Circuit manually reset');
  }
}
