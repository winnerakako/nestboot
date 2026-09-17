import { uuidv7 } from 'uuidv7';
import { Correlation } from '../logging/correlation.js';

/**
 * Domain events.
 *
 * These exist on day one for one reason: without them, the second feature that
 * needs to react to the first imports its action directly, and the single
 * boundary rule this template has is broken by the second feature anybody
 * writes. Events make the legal move the obvious one.
 *
 * An event class lives in the **emitting** feature's `contracts/events/`, so a
 * subscriber can import it without reaching into anything private.
 */
export abstract class DomainEvent {
  readonly id: string = uuidv7();
  readonly occurredAt: Date = new Date();
  /** Captured at construction so the reaction is traceable to its cause. */
  readonly requestId?: string = Correlation.requestId;

  /** Stable name used for routing and rendered in /ops. */
  get name(): string {
    return this.constructor.name;
  }
}

export type EventClass<T extends DomainEvent = DomainEvent> = new (...args: never[]) => T;

export interface EventListener<T extends DomainEvent = DomainEvent> {
  handle(event: T): Promise<void>;
}

export interface ListenerRegistration {
  eventName: string;
  listenerName: string;
  /** The durable workflow that runs this listener, started by the EventBus. */
  ref: ListenerWorkflow;
}

/**
 * Structural, not the imported `WorkflowRef`, so this file stays free of a
 * dependency on the DBOS wrapper — it is imported by feature contracts.
 */
export interface ListenerWorkflow {
  readonly name: string;
  readonly className: string;
  readonly queueName: string;
  readonly group: string;
  readonly feature: string;
  readonly kind: string;
}

const registrations: ListenerRegistration[] = [];

export function registerListener(registration: ListenerRegistration): void {
  const duplicate = registrations.find((entry) => entry.listenerName === registration.listenerName);
  if (duplicate) {
    throw new Error(
      `Two listeners are both named "${registration.listenerName}".\n` +
        'FIX: the name becomes part of the workflow id that makes delivery exactly-once, ' +
        'so two listeners sharing one name would silently collapse into a single delivery.',
    );
  }
  registrations.push(registration);
}

export function listenersFor(eventName: string): ListenerRegistration[] {
  return registrations.filter((entry) => entry.eventName === eventName);
}

export function allListeners(): readonly ListenerRegistration[] {
  return registrations;
}

/** Test-only: registrations happen at import time and are frozen in practice. */
export function resetListeners(): void {
  registrations.length = 0;
}
