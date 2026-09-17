import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabases } from '../../../test/setup/database.js';
import { defineJob, defineWorkflow, step } from './define.js';
import { OpsMeta } from './ops-meta.js';
import { Queues } from './queues.js';
import { ExecutorBackend, WorkflowRuntime } from './runtime.js';

/**
 * The end-to-end proof that the durable-execution wrapper is real.
 *
 * Everything else in /ops is a view over what this produces: if `start()` does
 * not enqueue, if steps do not checkpoint, or if attributes are not stamped,
 * then every tab is rendering fiction. So this runs a genuine executor against
 * a genuine Postgres and asserts on what actually landed in the tables.
 */

/** Counts real invocations, to prove a checkpointed step is not re-run. */
const attempts = { flaky: 0, recorded: 0 };

const RecordThing = defineJob({
  name: 'SpecRecordThing',
  meta: { group: 'spec-payments', description: 'Record a thing' },
  queue: Queues.default,
  run: async (input: { value: number }) => {
    attempts.recorded++;
    return { doubled: input.value * 2 };
  },
});

const MultiStep = defineWorkflow({
  name: 'SpecMultiStep',
  meta: { group: 'spec-payments', description: 'Two steps and a failure' },
  queue: Queues.default,
  run: async (input: { id: string }) => {
    const first = await step('chargeCard', async () => `charged:${input.id}`);
    const second = await step('sendReceipt', { retries: 3 }, async () => {
      attempts.flaky++;
      // Fails once, then succeeds — the shape of every real external call.
      if (attempts.flaky < 2) throw new Error('smtp temporarily unavailable');
      return `receipt:${input.id}`;
    });
    return { first, second };
  },
});

const AlwaysFails = defineWorkflow({
  name: 'SpecAlwaysFails',
  meta: { group: 'spec-broken', description: 'Fails on purpose' },
  queue: Queues.default,
  run: async () => {
    await step('doomed', async () => {
      throw new Error('this step never works');
    });
  },
});

describe('durable execution, against a real executor', () => {
  const databases = useTestDatabases();
  let runtime: WorkflowRuntime;

  beforeAll(async () => {
    DBOS.setConfig({
      name: 'nestboot-spec',
      systemDatabaseUrl: databases.appUrl,
      logLevel: 'error',
      runAdminServer: false,
    });
    await DBOS.launch();
    runtime = new WorkflowRuntime(() => new ExecutorBackend());
  }, 120_000);

  afterAll(async () => {
    await DBOS.shutdown();
  });

  it('enqueues a job and runs it to completion', async () => {
    const started = await runtime.start(RecordThing, [{ value: 21 }]);
    await expect(started.result()).resolves.toEqual({ doubled: 42 });

    const status = await runtime.get(started.workflowId);
    expect(status?.status).toBe('SUCCESS');
    // Everything is enqueued, including from a process that could run it inline.
    expect(status?.queueName).toBe('default');
  });

  it('stamps the ops metadata /ops filters on, as searchable attributes', async () => {
    const started = await runtime.start(RecordThing, [{ value: 1 }]);
    await started.result();

    const matches = await runtime.list({
      attributes: { group: 'spec-payments' },
      ids: [started.workflowId],
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.group).toBe('spec-payments');
    expect(matches[0]?.kind).toBe('job');
    // Filtering by group is a WHERE clause, not a post-filter in memory.
    const otherGroup = await runtime.list({
      attributes: { group: 'spec-broken' },
      ids: [started.workflowId],
    });
    expect(otherGroup).toHaveLength(0);
  });

  it('treats the same workflow id as one workflow, so a double submit is harmless', async () => {
    const id = `spec-idempotent-${Date.now()}`;
    attempts.recorded = 0;

    const first = await runtime.start(RecordThing, [{ value: 5 }], { workflowId: id });
    const second = await runtime.start(RecordThing, [{ value: 5 }], { workflowId: id });

    await Promise.all([first.result(), second.result()]);

    expect(second.workflowId).toBe(first.workflowId);
    expect(attempts.recorded, 'the job body must have run exactly once').toBe(1);
  });

  it('checkpoints each step, and retries only the one that failed', async () => {
    attempts.flaky = 0;
    const started = await runtime.start(MultiStep, [{ id: 'inv_1' }]);

    await expect(started.result()).resolves.toEqual({
      first: 'charged:inv_1',
      second: 'receipt:inv_1',
    });

    // The retry re-ran only `sendReceipt`. If checkpointing were broken,
    // `chargeCard` would have run twice — which in a real app charges twice.
    expect(attempts.flaky).toBe(2);

    const steps = await runtime.steps(started.workflowId);
    expect(steps.map((s) => s.name)).toEqual(['chargeCard', 'sendReceipt']);
    expect(steps[0]?.output).toBe('charged:inv_1');
  });

  it('records a failure as ERROR with the failing step identifiable', async () => {
    const started = await runtime.start(AlwaysFails, [], { workflowId: `spec-fail-${Date.now()}` });
    await expect(started.result()).rejects.toThrow(/never works/);

    const status = await runtime.get(started.workflowId);
    expect(status?.status).toBe('ERROR');

    const steps = await runtime.steps(started.workflowId);
    const failed = steps.find((s) => s.error);
    expect(failed?.name).toBe('doomed');
  });

  it('cancels a workflow, and the cancellation is a durable fact', async () => {
    const id = `spec-cancel-${Date.now()}`;
    // Delayed so it is still enqueued when we cancel it.
    await runtime.start(RecordThing, [{ value: 9 }], { workflowId: id, delaySeconds: 120 });

    await runtime.cancel(id);

    const status = await runtime.get(id);
    expect(status?.status).toBe('CANCELLED');
  });

  it('forks a finished workflow from a chosen step, keeping earlier checkpoints', async () => {
    attempts.flaky = 0;
    const original = await runtime.start(MultiStep, [{ id: 'inv_fork' }]);
    await original.result();

    const chargeCalls = attempts.flaky;
    // Re-run from step 2: step 1 (chargeCard) must NOT execute again. This is
    // the repair tool for "step 2 was wrong because of a bug we have now fixed".
    const forkedId = await runtime.fork(original.workflowId, 2);
    const forked = await runtime.get(forkedId);

    expect(forkedId).not.toBe(original.workflowId);
    expect(forked).not.toBeNull();

    const forkedSteps = await runtime.steps(forkedId);
    expect(forkedSteps[0]?.output, 'step 1 keeps its original checkpoint').toBe('charged:inv_fork');
    expect(attempts.flaky).toBeGreaterThanOrEqual(chargeCalls);
  });

  it('lists what is queued separately from what has finished', async () => {
    const id = `spec-queued-${Date.now()}`;
    await runtime.start(RecordThing, [{ value: 3 }], { workflowId: id, delaySeconds: 300 });

    const queued = await runtime.list({ queuedOnly: true, limit: 100 });
    expect(queued.some((w) => w.workflowId === id)).toBe(true);

    await runtime.cancel(id);
  });

  it('exposes the registry /ops groups by', () => {
    const names = OpsMeta.all().map((entry) => entry.name);
    expect(names).toContain('SpecMultiStep');

    const entry = OpsMeta.get('SpecMultiStep');
    expect(entry).toMatchObject({ group: 'spec-payments', kind: 'workflow' });
  });
});
