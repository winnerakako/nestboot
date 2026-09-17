import { defineJob, step } from '../../../platform/dbos/define.js';
import { Queues } from '../../../platform/dbos/queues.js';

/**
 * One external effect, with retries.
 *
 * A job is a one-step workflow: same list, same retries, same resumability.
 * The difference is intent. If you find yourself adding a second step, it was
 * a workflow.
 */
export const __NAME__ = defineJob({
  name: '__NAME__',
  meta: { group: 'TODO', description: 'TODO: what this does, in one line' },
  queue: Queues.default,
  run: async (input: { id: string }) => {
    await step('perform', { retries: 3 }, async () => {
      throw new Error(`__NAME__ is not implemented yet (input ${JSON.stringify(input)})`);
    });
  },
});
