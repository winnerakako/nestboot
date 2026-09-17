import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export interface WebhookRequest {
  /** The EXACT bytes received. Re-serialising JSON breaks every signature. */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface VerifiedWebhook {
  valid: boolean;
  /** The provider's id for this event; the dedupe key. */
  externalId?: string;
  eventType?: string;
  reason?: string;
}

/**
 * How a feature teaches the platform to check one provider's signatures.
 *
 * Every provider does this differently, and none of them can be trusted
 * generically — so verification is per-provider code, and the platform only
 * guarantees that it *runs* before anything else touches the payload.
 */
export interface WebhookVerifier {
  readonly provider: string;
  verify(request: WebhookRequest): VerifiedWebhook | Promise<VerifiedWebhook>;
}

export const WEBHOOK_VERIFIERS = Symbol('WEBHOOK_VERIFIERS');

/**
 * Compare two signatures without leaking their contents through timing.
 *
 * `a === b` on a signature returns as soon as it finds a differing byte, which
 * is enough to reconstruct a valid signature one byte at a time over enough
 * requests. This is the one string comparison in the app that must not be `===`.
 */
export function signaturesMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hmacSha256(
  secret: string,
  payload: Buffer | string,
  encoding: 'hex' | 'base64' = 'hex',
): string {
  return createHmac('sha256', secret).update(payload).digest(encoding);
}

/**
 * A verifier that rejects everything, registered for any provider nobody has
 * written one for.
 *
 * Intentional: unknown providers are refused rather than accepted-and-logged.
 * An endpoint that stores unverified payloads is an unauthenticated write to
 * your database that a workflow will later act on.
 */
@Injectable()
export class RejectUnknownProvider implements WebhookVerifier {
  readonly provider = '*';
  verify(): VerifiedWebhook {
    return { valid: false, reason: 'no verifier is registered for this provider' };
  }
}
