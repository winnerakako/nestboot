import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ConfigService } from '../config/index.js';
import { ERROR_SINK, type ErrorSink, fingerprint } from '../errors/error-sink.js';
import { Correlation } from '../logging/correlation.js';
import {
  InternalException,
  PlatformException,
  RateLimitedException,
  ValidationException,
} from './platform.exception.js';
import { type ProblemDocument, Problems, type ProblemType, problemTypeUri } from './problem.js';
import { zodToFieldErrors } from './zod-problem.js';

const BY_STATUS = new Map<number, ProblemType>(
  Object.values(Problems).map((p) => [p.status, p] as const),
);

/**
 * The one place an exception becomes a response.
 *
 * Every surface answers `application/problem+json`; there is no second error
 * shape and no per-controller try/catch. Anything that is not a
 * `PlatformException` is a bug, and is reported as a bare 500 with its detail
 * withheld outside development — an unexpected error's message is written for
 * us, not for the caller, and it routinely contains connection strings, SQL and
 * file paths.
 */
@Catch()
@Injectable()
export class ProblemFilter implements ExceptionFilter {
  constructor(
    private readonly config: ConfigService,
    @Inject(ERROR_SINK) private readonly sink: ErrorSink,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const normalised = this.normalise(exception);
    const document = this.render(normalised, request);

    // A 5xx is a bug and is always recorded; a 4xx is the caller being told
    // "no", which is not an error and would drown the errors tab in noise.
    if (document.status >= 500) {
      this.sink.record({
        fingerprint: fingerprint(normalised, [document.type]),
        type: normalised.name,
        message: normalised.message,
        stack: normalised.stack,
        status: document.status,
        context: Correlation.get(),
        occurredAt: new Date(),
      });
    }

    void reply
      .status(document.status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .headers(this.extraHeaders(normalised))
      .send(document);
  }

  private normalise(exception: unknown): PlatformException | Error {
    if (exception instanceof PlatformException) return exception;

    if (exception instanceof ZodError) {
      return new ValidationException(zodToFieldErrors(exception));
    }

    // Nest throws its own for things we never see (404 on an unmatched route,
    // 415 from the body parser). Translate rather than let them out untouched.
    if (exception instanceof HttpException) {
      return new PassthroughHttpException(exception);
    }

    return exception instanceof Error ? exception : new Error(String(exception));
  }

  private render(error: PlatformException | Error, request: FastifyRequest): ProblemDocument {
    const appUrl = this.config.get('APP_URL');
    const isPlatform = error instanceof PlatformException;
    const problem = isPlatform ? error.problem : Problems.internal;

    const document: ProblemDocument = {
      type: problemTypeUri(problem.slug, appUrl),
      title: problem.title,
      status: problem.status,
      instance: request.url,
    };

    const requestId = Correlation.requestId;
    if (requestId) document.requestId = requestId;

    if (isPlatform) {
      document.detail = error.detail;
      Object.assign(document, error.extensions);
    } else if (!this.config.isProduction) {
      // Development only: the message and stack of an unexpected error are
      // debugging aids, and are exactly what must never reach a real caller.
      document.detail = error.message;
      document.stack = error.stack?.split('\n').slice(0, 12);
    } else {
      document.detail = new InternalException().detail;
    }

    return document;
  }

  private extraHeaders(error: PlatformException | Error): Record<string, string> {
    if (error instanceof RateLimitedException) {
      return { 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterSeconds))) };
    }
    return {};
  }
}

/**
 * Wraps a framework `HttpException` so it renders through the registry like
 * everything else. Its status maps to a registered problem type when one
 * matches, and to `internal` when the framework invents a status we have not
 * described — which is itself worth noticing.
 */
class PassthroughHttpException extends PlatformException {
  readonly problem: ProblemType;

  constructor(source: HttpException) {
    const status = source.getStatus();
    const response = source.getResponse();
    const detail =
      typeof response === 'string'
        ? response
        : ((response as { message?: string | string[] }).message ?? source.message);

    super(Array.isArray(detail) ? detail.join('; ') : detail);
    this.problem = BY_STATUS.get(status) ?? Problems.internal;
    this.stack = source.stack;
  }
}
