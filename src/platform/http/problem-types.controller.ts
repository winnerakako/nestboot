import { Controller, Get, Param } from '@nestjs/common';
import { RawResponse } from './envelope.interceptor.js';
import { NotFoundException } from './platform.exception.js';
import { knownProblemTypes } from './problem.js';

/**
 * Makes every `type` URI in a problem document dereferenceable.
 *
 * RFC 9457 says the type URI "should" resolve to human-readable documentation.
 * Serving it from the app means the registry cannot drift from the docs — there
 * is only the registry.
 */
@Controller('problems')
export class ProblemTypesController {
  @Get()
  @RawResponse()
  list() {
    return { types: knownProblemTypes() };
  }

  @Get(':slug')
  @RawResponse()
  show(@Param('slug') slug: string) {
    const type = knownProblemTypes().find((t) => t.slug === slug);
    if (!type) throw new NotFoundException('problem type', slug);
    return type;
  }
}
