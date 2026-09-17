import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ErrorsModule } from '../errors/errors.module.js';
import { EnvelopeInterceptor } from './envelope.interceptor.js';
import { ProblemFilter } from './problem.filter.js';
import { ProblemTypesController } from './problem-types.controller.js';

/**
 * Registers the response contract globally, so a controller cannot opt out of
 * problem+json or the envelope by forgetting a decorator.
 */
@Module({
  imports: [ErrorsModule],
  controllers: [ProblemTypesController],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
  ],
})
export class HttpModule {}
