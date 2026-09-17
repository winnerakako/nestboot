/**
 * RFC 9457 problem details. Both surfaces answer with these; there is no second
 * error shape anywhere in the app.
 *
 * `type` is the stable, machine-readable identity of a failure — the one field
 * a client is allowed to branch on. It comes from the registry below and is
 * never assembled at a throw site, because a string invented in a `throw` is a
 * contract nobody knows they published.
 */

export interface ProblemType {
  /** Kebab-case, unique. Becomes the last segment of the `type` URI. */
  readonly slug: string;
  /** Short, human-readable, and the same for every occurrence of this type. */
  readonly title: string;
  readonly status: number;
}

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Correlation id, so a user can quote it and an operator can find the request. */
  requestId?: string;
  [extension: string]: unknown;
}

const registry = new Map<string, ProblemType>();

/**
 * Register a problem type. Features call this at import time from their own
 * `problems.ts`; the registry is read-only after boot.
 */
export function defineProblem(slug: string, title: string, status: number): ProblemType {
  const existing = registry.get(slug);
  if (existing) {
    if (existing.title !== title || existing.status !== status) {
      throw new Error(
        `Problem type "${slug}" is already registered as ${existing.status} "${existing.title}".\n` +
          'FIX: two different failures cannot share one type — a client branches on it. ' +
          'Give this one its own slug.',
      );
    }
    return existing;
  }
  const type: ProblemType = Object.freeze({ slug, title, status });
  registry.set(slug, type);
  return type;
}

export function knownProblemTypes(): ProblemType[] {
  return [...registry.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function isRegisteredProblem(slug: string): boolean {
  return registry.has(slug);
}

/** `https://<app>/problems/<slug>` — dereferenceable, so the docs can live there. */
export function problemTypeUri(slug: string, baseUrl: string): string {
  return new URL(`/problems/${slug}`, baseUrl).toString();
}

// ---- the types every app has ------------------------------------------------

export const Problems = {
  validationFailed: defineProblem('validation-failed', 'Validation failed', 422),
  unauthenticated: defineProblem('unauthenticated', 'Authentication required', 401),
  forbidden: defineProblem('forbidden', 'Not permitted', 403),
  notFound: defineProblem('not-found', 'Not found', 404),
  conflict: defineProblem('conflict', 'Conflict', 409),
  preconditionFailed: defineProblem('precondition-failed', 'Precondition failed', 412),
  payloadTooLarge: defineProblem('payload-too-large', 'Payload too large', 413),
  unsupportedMediaType: defineProblem('unsupported-media-type', 'Unsupported media type', 415),
  rateLimited: defineProblem('rate-limited', 'Too many requests', 429),
  internal: defineProblem('internal-error', 'Internal server error', 500),
  unavailable: defineProblem('service-unavailable', 'Service unavailable', 503),
  timeout: defineProblem('timeout', 'The request timed out', 504),
} as const;
