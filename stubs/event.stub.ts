import { DomainEvent } from '../../../../platform/events/events.js';

/**
 * Lives in the EMITTING feature's contracts/events/, so a subscriber can import
 * it without reaching into anything private.
 *
 * Carry ids and facts, not objects: an event crosses a process boundary as
 * JSON, so methods and class instances do not survive the trip.
 */
export class __NAME__ extends DomainEvent {
  constructor(readonly id: string) {
    super();
  }
}
