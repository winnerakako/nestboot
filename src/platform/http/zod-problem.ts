import type { ZodError } from 'zod';
import type { FieldErrors } from './platform.exception.js';

/**
 * Flatten a zod error into the `errors` member of a 422 problem document:
 * `{ "address.city": ["Required"] }`.
 *
 * Numeric path segments are kept as `items.0.sku` rather than `items[0].sku`
 * because that is the form a client can feed straight back into a form-field
 * lookup, and it matches how the DTO's own path reads.
 */
export function zodToFieldErrors(error: ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    const messages = errors[field];
    if (messages) messages.push(issue.message);
    else errors[field] = [issue.message];
  }
  return errors;
}
