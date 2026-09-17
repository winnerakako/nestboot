import { beforeEach, describe, expect, it } from 'vitest';
import { defineJob, defineWorkflow } from './define.js';
import { OpsMeta } from './ops-meta.js';
import { Queues } from './queues.js';

describe('declaring background work', () => {
  beforeEach(() => {
    OpsMeta.reset();
  });

  it('records the operator metadata /ops groups by', () => {
    const ref = defineWorkflow({
      name: 'ReconcileLedgerSpec',
      meta: { group: 'payments', description: 'Reconcile the ledger against the processor' },
      run: async (_day: string) => {},
    });

    expect(ref.group).toBe('payments');
    expect(OpsMeta.get('ReconcileLedgerSpec')).toMatchObject({
      group: 'payments',
      kind: 'workflow',
      description: 'Reconcile the ledger against the processor',
    });
  });

  it('defaults a job to the default queue and honours an explicit one', () => {
    const fallback = defineJob({
      name: 'SpecDefaultQueueJob',
      meta: { group: 'spec', description: 'x' },
      run: async () => {},
    });
    const explicit = defineJob({
      name: 'SpecMailJob',
      meta: { group: 'notifications', description: 'x' },
      queue: Queues.mail,
      run: async () => {},
    });

    expect(fallback.queueName).toBe('default');
    expect(explicit.queueName).toBe('mail');
  });

  it('distinguishes a job from a workflow, so /ops can filter on intent', () => {
    const job = defineJob({
      name: 'SpecKindJob',
      meta: { group: 'spec', description: 'x' },
      run: async () => {},
    });
    const workflow = defineWorkflow({
      name: 'SpecKindWorkflow',
      meta: { group: 'spec', description: 'x' },
      run: async () => {},
    });

    expect(job.kind).toBe('job');
    expect(workflow.kind).toBe('workflow');
  });

  it('refuses two different functions registered under one name', () => {
    defineWorkflow({
      name: 'SpecDuplicate',
      meta: { group: 'spec', description: 'x' },
      run: async () => {},
    });

    // The name is what DBOS recovers by and /ops filters on; two of them would
    // silently make one of the pair unrecoverable.
    expect(() =>
      defineJob({
        name: 'SpecDuplicate',
        meta: { group: 'spec', description: 'x' },
        run: async () => {},
      }),
    ).toThrow(/must be unique/);
  });

  it('groups the registry the way the console renders it', () => {
    defineWorkflow({
      name: 'SpecChargeCard',
      meta: { group: 'payments', description: 'x' },
      run: async () => {},
    });
    defineJob({
      name: 'SpecSendReceipt',
      meta: { group: 'notifications', description: 'x' },
      run: async () => {},
    });

    expect(OpsMeta.groups()).toEqual(['notifications', 'payments']);
    expect(
      OpsMeta.byGroup()
        .get('payments')
        ?.map((e) => e.name),
    ).toEqual(['SpecChargeCard']);
  });

  it('attributes work defined outside a feature to the platform', () => {
    const ref = defineWorkflow({
      name: 'SpecFeatureInference',
      meta: { group: 'spec', description: 'x' },
      run: async () => {},
    });

    // This file lives under src/platform, so there is no feature to infer.
    expect(ref.feature).toBe('platform');
  });
});
