import { Controller, Post } from '@nestjs/common';
import { ZodBody } from '../../../platform/http/zod-validation.pipe.js';
import { RouteGroup, RouteGroups } from '../../../platform/security/rate-limit/subject.js';
import { __NAME__Action } from '../actions/__KEBAB__.action.js';
import { type __NAME__Data, __NAME__Schema } from '../dtos/__KEBAB__.dto.js';

/**
 * An adapter: validate -> authorize -> call the action -> format.
 *
 * It holds no business logic and no authorization rules, touches no database,
 * and dispatches no jobs. A web controller and an API controller call the SAME
 * action; /ops is a third consumer, not a special case.
 */
@Controller('__FEATURE__')
@RouteGroup(RouteGroups.api)
export class __NAME__Controller {
  constructor(private readonly action: __NAME__Action) {}

  @Post('__KEBAB__')
  async handle(@ZodBody(__NAME__Schema) data: __NAME__Data) {
    // TODO: authorize here, via a policy, before calling the action.
    return this.action.run(data);
  }
}
