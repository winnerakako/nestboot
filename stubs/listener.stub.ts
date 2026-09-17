import { onEvent } from '../../../platform/events/event-bus.js';
import { __EVENT__ } from '../../__EVENT_FEATURE__/contracts/events/__EVENT_KEBAB__.event.js';

/**
 * Reacts to an event, durably.
 *
 * Runs as its own workflow, so it retries independently and cannot be
 * duplicated: the workflow id is `${event.id}:__NAME__`.
 *
 * The event arrives as plain data, not as an instance — read fields, do not
 * call methods on it.
 */
export const __NAME__ = onEvent({
  event: __EVENT__,
  name: '__NAME__',
  meta: { group: 'TODO', description: 'TODO: what this reaction does' },
  handle: async (event) => {
    throw new Error(`__NAME__ is not implemented yet (event ${event.id})`);
  },
});
