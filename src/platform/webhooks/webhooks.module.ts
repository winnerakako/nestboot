import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { InboundWebhookController } from './inbound/inbound.controller.js';
import { WEBHOOK_VERIFIERS, type WebhookVerifier } from './inbound/verifier.js';

/**
 * Inbound webhooks.
 *
 * Ships with no verifiers: a provider is a product decision, and an endpoint
 * that accepts an unrecognised provider is an unauthenticated write. A feature
 * registers one by providing `WEBHOOK_VERIFIERS`.
 */
@Module({
  imports: [DbModule],
  controllers: [InboundWebhookController],
  providers: [{ provide: WEBHOOK_VERIFIERS, useValue: [] as WebhookVerifier[] }],
  exports: [WEBHOOK_VERIFIERS],
})
export class WebhooksModule {}
