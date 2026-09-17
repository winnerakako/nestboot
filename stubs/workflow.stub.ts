import { defineWorkflow, step } from '../../../platform/dbos/define.js';
import { Queues } from '../../../platform/dbos/queues.js';

/**
 * A multi-step, durable process.
 *
 * Reach for a workflow whenever failing halfway through would leave the world
 * inconsistent — money moved but nothing recorded, an account created but never
 * provisioned. A single external call with retries is a job, not this.
 */
export const __NAME__ = defineWorkflow({
  name: '__NAME__',
  meta: {
    // The label an operator would use. Reuse an existing one where you can.
    group: 'TODO',
    description: 'TODO: what this does, in one line',
  },
  queue: Queues.default,
  run: async (input: { id: string }) => {
    // Everything with an outside effect goes in a step: HTTP calls, sending
    // mail, writing to another system, reading the clock, generating an id.
    // A completed step never runs again, even when the workflow resumes.
    const first = await step('describeWhatThisDoes', async () => {
      throw new Error(`__NAME__ is not implemented yet (input ${JSON.stringify(input)})`);
    });

    // Retries are per-step, and only safe when the step is idempotent.
    // await step('callProvider', { retries: 5, intervalSeconds: 10 }, async () => …);

    return { first };
  },
});
