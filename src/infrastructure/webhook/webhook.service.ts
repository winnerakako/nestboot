import {
  Injectable,
  HttpStatus,
  Logger,
  OnModuleInit,
  RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventService } from '../events/event.service';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { CacheService } from '../cache/cache.service';
import { BusinessException } from '../../common/filters';

export interface WebhookProviderConfig {
  name: string;
  secret: string;
  signatureHeader: string;
  algorithm?: string;
  signaturePrefix?: string;
}

export interface WebhookEvent {
  provider: string;
  eventType: string;
  payload: any;
  rawBody: string;
  receivedAt: Date;
  idempotencyKey: string;
}

const WEBHOOK_PROCESSED_TTL_SECONDS = 86400;
const WEBHOOK_PROCESSING_TTL_SECONDS = 300;
// Max expected HMAC hex length: sha512 = 128 hex chars + optional prefix (e.g. "sha512=")
const MAX_SIGNATURE_LENGTH = 256;

@Injectable()
export class WebhookService implements OnModuleInit {
  private readonly logger = new Logger(WebhookService.name);
  private readonly providers = new Map<string, WebhookProviderConfig>();

  constructor(
    private readonly configService: ConfigService,
    private readonly events: EventService,
    private readonly cache: CacheService,
  ) {}

  onModuleInit() {
    this.registerConfiguredProviders();
  }

  registerProvider(config: WebhookProviderConfig) {
    this.providers.set(config.name, {
      algorithm: 'sha512',
      ...config,
    });
    this.logger.log(`Webhook provider registered: ${config.name}`);
  }

  async handleWebhook(
    providerName: string,
    req: RawBodyRequest<Request>,
  ): Promise<{ received: boolean }> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new BusinessException(`Unknown webhook provider: ${providerName}`);
    }

    const rawBody = req.rawBody?.toString() || JSON.stringify(req.body);

    // Verify signature
    const signatureHeader = req.headers[provider.signatureHeader.toLowerCase()];
    const signature = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;
    if (!signature) {
      this.logger.warn(`Missing signature header for ${providerName}`);
      throw new BusinessException('Missing webhook signature');
    }

    if (signature.length > MAX_SIGNATURE_LENGTH) {
      this.logger.warn(`Oversized signature header for ${providerName}`);
      throw new BusinessException('Invalid webhook signature');
    }

    if (!this.verifySignature(rawBody, signature, provider)) {
      this.logger.warn(`Invalid webhook signature for ${providerName}`);
      throw new BusinessException('Invalid webhook signature');
    }

    // Parse payload safely
    let payload: any;
    try {
      payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      this.logger.warn(`Invalid JSON payload from ${providerName}`);
      throw new BusinessException('Invalid webhook payload');
    }

    const eventType = this.extractEventType(payload, providerName);

    // Idempotency check
    const idempotencyKey = `webhook:${providerName}:${eventType}:${this.generateIdempotencyKey(payload, rawBody)}`;
    const processingKey = `${idempotencyKey}:processing`;
    const redis = this.cache.getClient();
    let acquired: string | null;
    let releaseProcessingMarker = false;

    try {
      const processed = await redis.get(idempotencyKey);
      if (processed) {
        this.logger.log(
          `Duplicate webhook ignored: ${providerName}/${eventType}`,
        );
        return { received: true };
      }

      acquired = await redis.set(
        processingKey,
        '1',
        'EX',
        WEBHOOK_PROCESSING_TTL_SECONDS,
        'NX',
      );
    } catch (error) {
      this.logger.error(
        `Webhook idempotency unavailable for ${providerName}: ${(error as Error).message}`,
      );
      throw new BusinessException(
        'Webhook idempotency temporarily unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    if (!acquired) {
      this.logger.warn(
        `Webhook already processing: ${providerName}/${eventType}`,
      );
      throw new BusinessException(
        'Webhook is already being processed',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    releaseProcessingMarker = true;

    const event: WebhookEvent = {
      provider: providerName,
      eventType,
      payload,
      rawBody,
      receivedAt: new Date(),
      idempotencyKey,
    };

    const specificEvent = `webhook.${providerName}.${eventType}`;
    const genericEvent = `webhook.${providerName}`;

    try {
      // Dynamic events for specific webhook handlers
      await this.events.emitDynamicStrict(specificEvent, event);
      await this.events.emitDynamicStrict(genericEvent, event);

      // Typed event for generic webhook listeners
      await this.events.emitStrict('webhook.received', {
        provider: providerName,
        eventType,
        payload,
      });

      try {
        await redis.set(
          idempotencyKey,
          '1',
          'EX',
          WEBHOOK_PROCESSED_TTL_SECONDS,
        );
      } catch (error) {
        releaseProcessingMarker = false;
        this.logger.error(
          `Webhook processed but idempotency marker was not saved for ${providerName}: ${(error as Error).message}`,
        );
        throw new BusinessException(
          'Webhook idempotency marker was not saved',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      this.logger.log(`Webhook received: ${specificEvent}`);

      return { received: true };
    } catch (error) {
      this.logger.error(
        `Webhook processing failed: ${specificEvent}: ${(error as Error).message}`,
      );
      throw error;
    } finally {
      if (releaseProcessingMarker) {
        try {
          await redis.del(processingKey);
        } catch {
          // Processing marker will expire via TTL.
        }
      }
    }
  }

  private verifySignature(
    rawBody: string,
    signature: string,
    provider: WebhookProviderConfig,
  ): boolean {
    const expectedHmac = createHmac(
      provider.algorithm || 'sha512',
      provider.secret,
    )
      .update(rawBody)
      .digest('hex');

    let sig = signature.trim();
    if (provider.signaturePrefix && sig.startsWith(provider.signaturePrefix)) {
      sig = sig.slice(provider.signaturePrefix.length);
    }

    if (!/^[a-f0-9]+$/i.test(sig)) {
      return false;
    }

    // Length check before timingSafeEqual to avoid exceptions
    const expectedBuf = Buffer.from(expectedHmac, 'hex');
    const sigBuf = Buffer.from(sig, 'hex');

    if (expectedBuf.length !== sigBuf.length) {
      return false;
    }

    return timingSafeEqual(expectedBuf, sigBuf);
  }

  private extractEventType(payload: any, providerName: string): string {
    return (
      payload.event ||
      payload.type ||
      payload.action ||
      payload.event_type ||
      `${providerName}.unknown`
    );
  }

  private generateIdempotencyKey(payload: any, rawBody: string): string {
    return (
      payload.id ||
      payload.reference ||
      payload.transaction_id ||
      payload.data?.id ||
      payload.data?.reference ||
      createHash('sha256').update(rawBody).digest('hex')
    );
  }

  private registerConfiguredProviders() {
    this.registerProvidersFromJson();
    this.registerPaystackProvider();
  }

  private registerProvidersFromJson() {
    const raw = this.configService.get<string>('WEBHOOK_PROVIDERS');
    if (!raw) return;

    try {
      const providers = JSON.parse(raw) as WebhookProviderConfig[];
      if (!Array.isArray(providers)) {
        throw new Error('WEBHOOK_PROVIDERS must be a JSON array');
      }

      for (const provider of providers) {
        if (provider.name && provider.secret && provider.signatureHeader) {
          this.registerProvider(provider);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Invalid WEBHOOK_PROVIDERS config: ${(error as Error).message}`,
      );
    }
  }

  private registerPaystackProvider() {
    const secret = this.configService.get<string>('PAYSTACK_WEBHOOK_SECRET');
    if (!secret) return;

    this.registerProvider({
      name: 'paystack',
      secret,
      signatureHeader: 'x-paystack-signature',
      algorithm: 'sha512',
    });
  }
}
