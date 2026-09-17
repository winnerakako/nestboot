import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabases } from '../../../test/setup/database.js';
import { ExecutorBackend, WorkflowRuntime } from '../dbos/runtime.js';
import { EventBus, onEvent } from './event-bus.js';
import { DomainEvent } from './events.js';

/**
 * The event bus, end to end, against a real executor.
 *
 * Everything this is for happens across a process boundary: the listener runs
 * as its own durable workflow, its arguments are serialised, and delivery is
 * deduplicated by a workflow id. None of that is observable without actually
 * running it.
 */

class InvoicePaid extends DomainEvent {
  constructor(
    readonly invoiceId: string,
    readonly amountMinor: number,
  ) {
    super();
  }
}

class NobodyListensToThis extends DomainEvent {}

/** What the listeners did. Module-level because the handlers run in-process. */
const received: { receipts: string[]; ledger: string[] } = { receipts: [], ledger: [] };

onEvent({
  event: InvoicePaid,
  name: 'SendReceiptOnPaid',
  meta: { group: 'notifications', description: 'Email a receipt' },
  handle: async (event) => {
    received.receipts.push(event.invoiceId);
  },
});

onEvent({
  event: InvoicePaid,
  name: 'RecordInLedgerOnPaid',
  meta: { group: 'payments', description: 'Record the payment' },
  handle: async (event) => {
    received.ledger.push(`${event.invoiceId}:${event.amountMinor}`);
  },
});

describe('domain events', () => {
  const databases = useTestDatabases();
  let bus: EventBus;
  let runtime: WorkflowRuntime;

  beforeAll(async () => {
    DBOS.setConfig({
      name: 'nestboot-events-spec',
      systemDatabaseUrl: databases.appUrl,
      logLevel: 'error',
      runAdminServer: false,
    });
    await DBOS.launch();
    runtime = new WorkflowRuntime(() => new ExecutorBackend());
    bus = new EventBus(runtime);
  }, 120_000);

  afterAll(async () => {
    await DBOS.shutdown();
  });

  beforeEach(() => {
    received.receipts = [];
    received.ledger = [];
  });

  /** Listeners run as queued workflows, so completion is awaited explicitly. */
  async function settle(workflowIds: string[]): Promise<void> {
    await Promise.all(workflowIds.map((id) => runtime.get(id).then(() => waitFor(id))));
  }

  async function waitFor(id: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await runtime.get(id);
      if (status && ['SUCCESS', 'ERROR', 'CANCELLED'].includes(status.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`workflow ${id} never finished`);
  }

  it('delivers one event to every listener registered for it', async () => {
    const started = await bus.emit(new InvoicePaid('inv_1', 4200));
    expect(started).toHaveLength(2);

    await settle(started);

    expect(received.receipts).toEqual(['inv_1']);
    expect(received.ledger).toEqual(['inv_1:4200']);
  });

  it('is a no-op for an event nobody listens to', async () => {
    // Not an error: an event with no subscribers is how a feature stays
    // decoupled from features that do not exist yet.
    expect(await bus.emit(new NobodyListensToThis())).toEqual([]);
  });

  it('delivers exactly once per listener, however many times it is emitted', async () => {
    const event = new InvoicePaid('inv_dedupe', 100);

    const first = await bus.emit(event);
    const second = await bus.emit(event);

    await settle([...first, ...second]);

    // The workflow id is `${event.id}:${listener}`, so the second emit resolves
    // to the same workflows rather than a second set of side effects. This is
    // what replaces an outbox table: the workflow record IS the outbox row.
    expect(second).toEqual(first);
    expect(received.receipts).toEqual(['inv_dedupe']);
    expect(received.ledger).toEqual(['inv_dedupe:100']);
  });

  it('treats two different events as two deliveries', async () => {
    const started = [
      ...(await bus.emit(new InvoicePaid('inv_a', 1))),
      ...(await bus.emit(new InvoicePaid('inv_b', 2))),
    ];
    await settle(started);

    expect(received.receipts.sort()).toEqual(['inv_a', 'inv_b']);
  });

  it('carries the event payload across the serialisation boundary', async () => {
    const started = await bus.emit(new InvoicePaid('inv_payload', 999));
    await settle(started);

    // Arguments reach the handler as JSON, so a field survives and a method
    // would not. The ledger line proves both fields arrived intact.
    expect(received.ledger).toEqual(['inv_payload:999']);
  });

  it('makes each delivery a workflow /ops can see, tagged with its group', async () => {
    const started = await bus.emit(new InvoicePaid('inv_visible', 7));
    await settle(started);

    const workflows = await runtime.list({ ids: started });
    expect(workflows).toHaveLength(2);

    const groups = workflows.map((workflow) => workflow.group).sort();
    expect(groups).toEqual(['notifications', 'payments']);
    expect(workflows.every((workflow) => workflow.kind === 'listener')).toBe(true);
    expect(workflows.every((workflow) => workflow.queueName === 'events')).toBe(true);
  });
});
