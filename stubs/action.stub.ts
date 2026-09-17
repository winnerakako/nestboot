import { Injectable } from '@nestjs/common';
import type { __NAME__Data } from '../dtos/__KEBAB__.dto.js';

/**
 * TODO: describe what this operation does, in a sentence a product person
 * would recognise.
 */
@Injectable()
export class __NAME__Action {
  // Inject what you need. NOT the request, the session, or `auth()` — an action
  // must run unchanged in a queue worker, and the actor travels on the DTO.
  constructor() {}

  /**
   * Takes a typed DTO, returns a domain object.
   *
   * Failure is a typed exception extending `PlatformException`, never `null`
   * and never a `Result` to branch on — a caller that forgets to check a
   * `Result` compiles and ships, and the failure becomes a wrong answer.
   *
   * Assumes an authorized caller: the policy runs in the adapter. Calling this
   * from a job or a command means acting as the system, deliberately — say so
   * at the call site.
   */
  async run(data: __NAME__Data): Promise<unknown> {
    throw new Error(`__NAME__Action is not implemented yet (received ${JSON.stringify(data)})`);
  }
}
