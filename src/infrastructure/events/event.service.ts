import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventMap, EventName } from './event-map';

/**
 * Type-safe event service wrapper around EventEmitter2.
 * Provides typed emit, error handling, and event discovery.
 *
 * Usage:
 *   // Emit (type-checked payload)
 *   this.events.emit('payment.confirmed', { paymentId: '123', amount: 50000, currency: 'NGN' });
 *
 *   // Emit async (waits for all listeners to complete)
 *   await this.events.emitAsync('payment.confirmed', { ... });
 *
 *   // Listen (in any service)
 *   @OnEvent('payment.confirmed')
 *   handlePayment(payload: EventMap['payment.confirmed']) { ... }
 */
@Injectable()
export class EventService {
  private readonly logger = new Logger(EventService.name);

  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Emit an event (fire-and-forget).
   * Listener errors are caught and logged.
   */
  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    this.logger.debug(`Event emitted: ${String(event)}`);
    void this.invokeListenersSafely(String(event), payload, false);
  }

  /**
   * Emit an event and wait for ALL listeners to complete.
   * Use when downstream work must finish before proceeding.
   * Listener errors are caught individually — one failing listener
   * won't prevent others from executing.
   */
  async emitAsync<K extends EventName>(
    event: K,
    payload: EventMap[K],
  ): Promise<void> {
    this.logger.debug(`Event emitted (async): ${String(event)}`);
    await this.invokeListenersSafely(String(event), payload, true);
  }

  /**
   * Emit a dynamic/untyped event (e.g., webhook.paystack.charge.success).
   * Use for events with names generated at runtime.
   * Prefer the typed `emit()` for known events.
   */
  emitDynamic(event: string, payload: any): void {
    this.logger.debug(`Event emitted (dynamic): ${event}`);
    void this.invokeListenersSafely(event, payload, false);
  }

  /**
   * Emit a typed event and fail if any listener fails.
   * Use when the caller must know whether downstream work completed.
   */
  async emitStrict<K extends EventName>(
    event: K,
    payload: EventMap[K],
  ): Promise<void> {
    this.logger.debug(`Event emitted (strict): ${String(event)}`);
    await this.invokeListenersStrict(String(event), payload);
  }

  /**
   * Emit a dynamic event and fail if any listener fails.
   */
  async emitDynamicStrict(event: string, payload: any): Promise<void> {
    this.logger.debug(`Event emitted (dynamic strict): ${event}`);
    await this.invokeListenersStrict(event, payload);
  }

  /**
   * Check if any listeners are registered for an event.
   */
  hasListeners(event: EventName): boolean {
    return this.emitter.listenerCount(String(event)) > 0;
  }

  /**
   * Get count of listeners for an event.
   */
  listenerCount(event: EventName): number {
    return this.emitter.listenerCount(String(event));
  }

  /**
   * Get all event names that have registered listeners.
   * Useful for debugging and admin endpoints.
   */
  getActiveEvents(): string[] {
    return this.emitter.eventNames().map(String);
  }

  private async invokeListenersSafely(
    event: string,
    payload: any,
    waitForListeners: boolean,
  ): Promise<void> {
    const listenerPromises: Array<Promise<void>> = [];

    for (const listener of this.emitter.listeners(event)) {
      try {
        const result = (listener as (payload: any) => unknown)(payload);
        const maybePromise = result as PromiseLike<unknown> | undefined;

        if (maybePromise && typeof maybePromise.then === 'function') {
          const listenerPromise = Promise.resolve(maybePromise)
            .catch((error: unknown) => {
              this.logListenerError(event, error);
            })
            .then(() => undefined);

          if (waitForListeners) {
            listenerPromises.push(listenerPromise);
          } else {
            void listenerPromise;
          }
        }
      } catch (error) {
        this.logListenerError(event, error);
      }
    }

    if (waitForListeners) {
      await Promise.all(listenerPromises);
    }
  }

  private async invokeListenersStrict(
    event: string,
    payload: any,
  ): Promise<void> {
    const listenerPromises: Array<Promise<void>> = [];
    const errors: Error[] = [];

    for (const listener of this.emitter.listeners(event)) {
      try {
        const result = (listener as (payload: any) => unknown)(payload);
        const maybePromise = result as PromiseLike<unknown> | undefined;

        if (maybePromise && typeof maybePromise.then === 'function') {
          listenerPromises.push(
            Promise.resolve(maybePromise)
              .catch((error: unknown) => {
                const err = this.toError(error);
                errors.push(err);
                this.logListenerError(event, err);
              })
              .then(() => undefined),
          );
        }
      } catch (error) {
        const err = this.toError(error);
        errors.push(err);
        this.logListenerError(event, err);
      }
    }

    await Promise.all(listenerPromises);

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `${errors.length} event listeners failed for "${event}"`,
      );
    }
  }

  private logListenerError(event: string, error: unknown): void {
    const err = this.toError(error);
    this.logger.error(
      `Event listener failed for "${event}": ${err.message}`,
      err.stack,
    );
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
