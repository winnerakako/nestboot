import { z } from 'zod';

/**
 * Validation lives here, once, and every surface consumes it: the HTTP pipe,
 * the CLI, a workflow's input, and the tests. A surface may ADD a rule; it may
 * not contradict one.
 */
export const __NAME__Schema = z.object({
  // TODO: the fields this operation takes.
  // Unknown keys are stripped by zod's object parsing — that is the
  // mass-assignment defence, so do not switch it to .passthrough().
});

export type __NAME__Data = z.infer<typeof __NAME__Schema>;
