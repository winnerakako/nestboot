import { Injectable, Logger } from '@nestjs/common';
import { defineListener, type WorkflowRef } from '../dbos/define.js';
import type { OpsMetaInput } from '../dbos/ops-meta.js';
import { WorkflowRuntime } from '../dbos/runtime.js';
import { type DomainEvent, type EventClass, listenersFor, registerListener } from './events.js';

/**
 * Publishes a domain event to every registered listener, durably.
 *
 * Each listener is started as a workflow with
 * `workflowID = ${event.id}:${listenerName}`. That single line is what makes
 * delivery exactly-once per listener, retried on failure, and visible in /ops —
 * and it is why there is no outbox table and no relay job here: **the workflow
 * record IS the outbox row**. Emitting the same event twice is a no-op rather
 * than a duplicated side effect.
 *
 * The emitting feature never learns who reacted, which is the whole point.
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);

  constructor(private readonly runtime: WorkflowRuntime) {}

  async emit(event: DomainEvent): Promise<string[]> {
    const listeners = listenersFor(event.name);

    if (listeners.length === 0) {
      // Not an error — an event with no subscribers is normal, and is exactly
      // how a feature stays decoupled — but worth a line, because "my handler
      // never ran" is usually a listener that was never imported.
      this.logger.debug(`${event.name} emitted with no listeners`);
      return [];
    }

    const started = await Promise.all(
      listeners.map(async (listener) => {
        try {
          const handle = await this.runtime.start(
            listener.ref as WorkflowRef<[DomainEvent], void>,
            [event],
            {
              workflowId: `${event.id}:${listener.listenerName}`,
              attributes: { eventName: event.name, eventId: event.id },
            },
          );
          return handle.workflowId;
        } catch (error) {
          // One listener failing to *enqueue* must not stop the others.
          // Enqueueing writes a row and nothing else, so this is rare and means
          // the database is unreachable — which the health check will also say.
          this.logger.error(
            `failed to enqueue ${listener.listenerName} for ${event.name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }
      }),
    );

    return started.filter((id): id is string => id !== null);
  }
}

/**
 * Declare a listener for an event.
 *
 * The handler runs as a DBOS workflow, so anything it wraps in `step()` is
 * checkpointed and a crash resumes rather than restarts.
 *
 * Intentional: the handler receives the event as **plain data**, not as an
 * instance of the event class. Arguments cross a process boundary as JSON, so
 * methods and getters do not survive — a handler that calls `event.someMethod()`
 * works in a unit test and throws in a worker. Read fields only.
 */
export function onEvent<T extends DomainEvent>(options: {
  event: EventClass<T>;
  /** Unique across the app; it becomes part of the exactly-once workflow id. */
  name: string;
  meta: OpsMetaInput;
  handle: (event: T) => Promise<void>;
}): WorkflowRef<[T], void> {
  const ref = defineListener<[T], void>({
    name: options.name,
    meta: options.meta,
    run: options.handle,
  });

  registerListener({
    eventName: options.event.name,
    listenerName: options.name,
    ref,
  });

  return ref;
}
