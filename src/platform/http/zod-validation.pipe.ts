import { type ArgumentMetadata, Body, type PipeTransform, Query } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { ValidationException } from './platform.exception.js';
import { zodToFieldErrors } from './zod-problem.js';

/**
 * Validates and *replaces* the input with the parsed value, so a controller
 * receives the DTO's inferred type rather than `any` shaped like it. Unknown
 * keys are stripped by zod's object parsing, which is the mass-assignment
 * defence: a field the DTO does not name cannot reach an action.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) throw new ValidationException(zodToFieldErrors(error));
      throw error;
    }
  }
}

/** `@ZodBody(CreateInvoiceSchema) data: CreateInvoiceData` */
export const ZodBody = <T>(schema: ZodType<T>) => Body(new ZodValidationPipe(schema));

/** `@ZodQuery(ListInvoicesSchema) query: ListInvoicesQuery` */
export const ZodQuery = <T>(schema: ZodType<T>) => Query(new ZodValidationPipe(schema));
