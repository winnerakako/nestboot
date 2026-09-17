import { Problems, type ProblemType } from './problem.js';

/**
 * The only kind of failure an action is allowed to signal.
 *
 * Not `null`, not a `Result` to branch on: a caller that forgets to check a
 * `Result` compiles and ships, and the failure becomes a wrong answer instead
 * of an error. An exception that carries its own HTTP mapping means the one
 * global filter needs no `instanceof` ladder, and a new failure type is
 * correctly rendered on both surfaces the moment it is thrown.
 */
export abstract class PlatformException extends Error {
  abstract readonly problem: ProblemType;

  /**
   * Extra members merged into the problem document. Machine-readable context
   * the client can act on — never internals, never anything secret; this is
   * serialised to the caller verbatim.
   */
  readonly extensions: Readonly<Record<string, unknown>>;

  constructor(detail: string, extensions: Record<string, unknown> = {}) {
    super(detail);
    this.name = new.target.name;
    this.extensions = Object.freeze({ ...extensions });
    Error.captureStackTrace?.(this, new.target);
  }

  get detail(): string {
    return this.message;
  }

  get status(): number {
    return this.problem.status;
  }
}

/** A field-level validation failure, the 422 shape both surfaces produce. */
export interface FieldErrors {
  [field: string]: string[];
}

export class ValidationException extends PlatformException {
  readonly problem = Problems.validationFailed;

  constructor(
    readonly errors: FieldErrors,
    detail = 'The request payload failed validation.',
  ) {
    super(detail, { errors });
  }
}

export class UnauthenticatedException extends PlatformException {
  readonly problem = Problems.unauthenticated;
  constructor(detail = 'Authentication is required to access this resource.') {
    super(detail);
  }
}

export class ForbiddenException extends PlatformException {
  readonly problem = Problems.forbidden;
  constructor(detail = 'You are not permitted to perform this action.') {
    super(detail);
  }
}

export class NotFoundException extends PlatformException {
  readonly problem = Problems.notFound;

  /**
   * Takes the resource kind and id rather than a sentence, so every 404 in the
   * app reads the same and the id is a machine-readable extension.
   */
  constructor(resource: string, id?: string) {
    super(id ? `No ${resource} with id ${id}.` : `No such ${resource}.`, { resource, id });
  }
}

export class ConflictException extends PlatformException {
  readonly problem = Problems.conflict;
}

export class RateLimitedException extends PlatformException {
  readonly problem = Problems.rateLimited;

  constructor(
    detail: string,
    readonly retryAfterSeconds: number,
    extensions: Record<string, unknown> = {},
  ) {
    super(detail, { ...extensions, retryAfterSeconds });
  }
}

export class PayloadTooLargeException extends PlatformException {
  readonly problem = Problems.payloadTooLarge;
}

export class ServiceUnavailableException extends PlatformException {
  readonly problem = Problems.unavailable;
}

/**
 * The catch-all. Thrown by the filter for anything that is not a
 * `PlatformException`, and usable directly when a dependency fails in a way the
 * caller genuinely cannot act on.
 */
export class InternalException extends PlatformException {
  readonly problem = Problems.internal;
  constructor(detail = 'An unexpected error occurred.') {
    super(detail);
  }
}
