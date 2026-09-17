import { Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { AppDb } from '../../db/app-db.service.js';
import { RawResponse } from '../../http/envelope.interceptor.js';
import { ForbiddenException } from '../../http/platform.exception.js';
import { SecurityEvents } from '../../security/events/security-events.js';
import { RouteGroup, RouteGroups } from '../../security/rate-limit/subject.js';
import { WEBHOOK_VERIFIERS, type WebhookVerifier } from './verifier.js';

/**
 * `POST /webhooks/:provider`
 *
 * The handler does exactly four things and returns: verify the signature,
 * insert a receipt, hand off to a workflow, answer 200. Nothing about the
 * business meaning of the event happens here.
 *
 * That shape is forced by how providers behave. They time out in seconds and
 * retry aggressively, so any real work done inline turns one slow database
 * write into a retry storm — and every retry is a duplicate the slow handler is
 * now also processing. Acknowledge fast, process durably.
 */
// Intentional: public, because a payment provider cannot log in. The signature
// IS the authentication — which is why an unverifiable payload is refused
// outright rather than stored for later inspection.
@Controller('webhooks')
@RouteGroup(RouteGroups.webhooks)
export class InboundWebhookController {
  constructor(
    @Inject(WEBHOOK_VERIFIERS) private readonly verifiers: WebhookVerifier[],
    private readonly db: AppDb,
    private readonly events: SecurityEvents,
  ) {}

  @Post(':provider')
  @RawResponse()
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Req() request: FastifyRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<{ received: true; id: string }> {
    const verifier = this.verifiers.find((candidate) => candidate.provider === provider);

    // The raw body, exactly as received. Fastify's JSON parser is bypassed for
    // this route because re-serialising changes the bytes and every HMAC over
    // them stops matching.
    const rawBody = (request.raw as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);

    const result = verifier
      ? await verifier.verify({ rawBody, headers })
      : { valid: false, reason: `no verifier registered for "${provider}"` };

    if (!result.valid) {
      this.events.record({
        kind: 'webhook_signature',
        outcome: 'blocked',
        request,
        detail: { provider, reason: result.reason },
      });
      // Intentional: 403 and nothing stored. A rejected payload is an
      // unauthenticated write attempt, and persisting it would let anyone fill
      // the table — and risk a later replay treating it as genuine.
      throw new ForbiddenException('Webhook signature verification failed.');
    }

    const id = uuidv7();
    let payload: unknown = null;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      payload = { raw: rawBody.toString('utf8').slice(0, 10_000) };
    }

    // ON CONFLICT DO NOTHING on (provider, external_id) is what makes a
    // provider's retry a no-op: the same event id lands once, however many
    // times it is delivered.
    const inserted = await this.db.write().execute<{ id: string }>(sql`
      INSERT INTO webhook_inbound (id, provider, external_id, event_type, signature_ok, headers, payload)
      VALUES (${id}, ${provider}, ${result.externalId ?? null}, ${result.eventType ?? null},
              true, ${JSON.stringify(safeHeaders(headers))}::jsonb, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (provider, external_id) WHERE external_id IS NOT NULL DO NOTHING
      RETURNING id
    `);

    const storedId = inserted.rows[0]?.id;
    if (!storedId) {
      // A duplicate delivery. Answer 200 — the provider has done nothing wrong
      // and a non-2xx would make it retry the event we already hold.
      return { received: true, id };
    }

    return { received: true, id: storedId };
  }
}

/**
 * Headers are stored for debugging, minus the ones that authenticate the
 * request. A signature in the table is a replay waiting to happen.
 */
function safeHeaders(headers: Record<string, string>): Record<string, string> {
  const REDACT = /^(authorization|cookie|x-api-key|.*signature.*|.*secret.*|.*token.*)$/i;
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !REDACT.test(key)));
}
