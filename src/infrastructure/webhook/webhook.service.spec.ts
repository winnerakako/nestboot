import type { RawBodyRequest } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import type { Request } from 'express';
import type { CacheService } from '../cache/cache.service';
import type { EventService } from '../events/event.service';
import { WebhookService } from './webhook.service';

describe('WebhookService', () => {
  function sign(rawBody: string, secret: string) {
    return createHmac('sha512', secret).update(rawBody).digest('hex');
  }

  it('includes event type in webhook idempotency keys', async () => {
    const redisGet = jest.fn().mockResolvedValue(null);
    const redisSet = jest.fn().mockResolvedValue('OK');
    const redisDel = jest.fn().mockResolvedValue(1);
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      {
        emitStrict: jest.fn().mockResolvedValue(undefined),
        emitDynamicStrict: jest.fn().mockResolvedValue(undefined),
      } as unknown as EventService,
      {
        getClient: () => ({ get: redisGet, set: redisSet, del: redisDel }),
      } as unknown as CacheService,
    );

    service.registerProvider({
      name: 'paystack',
      secret: 'secret',
      signatureHeader: 'x-paystack-signature',
    });

    for (const event of ['charge.success', 'transfer.success']) {
      const body = { event, reference: 'same-reference' };
      const rawBody = JSON.stringify(body);

      await service.handleWebhook('paystack', {
        rawBody: Buffer.from(rawBody),
        body,
        headers: {
          'x-paystack-signature': sign(rawBody, 'secret'),
        },
      } as unknown as RawBodyRequest<Request>);
    }

    expect(redisSet).toHaveBeenNthCalledWith(
      1,
      'webhook:paystack:charge.success:same-reference:processing',
      '1',
      'EX',
      300,
      'NX',
    );
    expect(redisSet).toHaveBeenNthCalledWith(
      2,
      'webhook:paystack:charge.success:same-reference',
      '1',
      'EX',
      86400,
    );
    expect(redisSet).toHaveBeenNthCalledWith(
      3,
      'webhook:paystack:transfer.success:same-reference:processing',
      '1',
      'EX',
      300,
      'NX',
    );
    expect(redisSet).toHaveBeenNthCalledWith(
      4,
      'webhook:paystack:transfer.success:same-reference',
      '1',
      'EX',
      86400,
    );
  });

  it('releases the processing marker and does not mark failed listener work as processed', async () => {
    const redisGet = jest.fn().mockResolvedValue(null);
    const redisSet = jest.fn().mockResolvedValue('OK');
    const redisDel = jest.fn().mockResolvedValue(1);
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      {
        emitStrict: jest.fn().mockResolvedValue(undefined),
        emitDynamicStrict: jest.fn().mockRejectedValue(new Error('boom')),
      } as unknown as EventService,
      {
        getClient: () => ({ get: redisGet, set: redisSet, del: redisDel }),
      } as unknown as CacheService,
    );

    service.registerProvider({
      name: 'paystack',
      secret: 'secret',
      signatureHeader: 'x-paystack-signature',
    });

    const body = { event: 'charge.success', reference: 'same-reference' };
    const rawBody = JSON.stringify(body);

    await expect(
      service.handleWebhook('paystack', {
        rawBody: Buffer.from(rawBody),
        body,
        headers: {
          'x-paystack-signature': sign(rawBody, 'secret'),
        },
      } as unknown as RawBodyRequest<Request>),
    ).rejects.toThrow('boom');

    expect(redisSet).toHaveBeenCalledTimes(1);
    expect(redisSet).toHaveBeenCalledWith(
      'webhook:paystack:charge.success:same-reference:processing',
      '1',
      'EX',
      300,
      'NX',
    );
    expect(redisDel).toHaveBeenCalledWith(
      'webhook:paystack:charge.success:same-reference:processing',
    );
  });

  it('fails closed before processing when webhook idempotency is unavailable', async () => {
    const redisGet = jest.fn().mockRejectedValue(new Error('redis down'));
    const emitDynamicStrict = jest.fn().mockResolvedValue(undefined);
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      {
        emitStrict: jest.fn().mockResolvedValue(undefined),
        emitDynamicStrict,
      } as unknown as EventService,
      {
        getClient: () => ({
          get: redisGet,
          set: jest.fn(),
          del: jest.fn(),
        }),
      } as unknown as CacheService,
    );

    service.registerProvider({
      name: 'paystack',
      secret: 'secret',
      signatureHeader: 'x-paystack-signature',
    });

    const body = { event: 'charge.success', reference: 'same-reference' };
    const rawBody = JSON.stringify(body);

    await expect(
      service.handleWebhook('paystack', {
        rawBody: Buffer.from(rawBody),
        body,
        headers: {
          'x-paystack-signature': sign(rawBody, 'secret'),
        },
      } as unknown as RawBodyRequest<Request>),
    ).rejects.toThrow('Webhook idempotency temporarily unavailable');

    expect(emitDynamicStrict).not.toHaveBeenCalled();
  });

  it('does not acknowledge a duplicate delivery while the first is still processing', async () => {
    const redisGet = jest.fn().mockResolvedValue(null);
    const redisSet = jest.fn().mockResolvedValue(null);
    const emitDynamicStrict = jest.fn().mockResolvedValue(undefined);
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      {
        emitStrict: jest.fn().mockResolvedValue(undefined),
        emitDynamicStrict,
      } as unknown as EventService,
      {
        getClient: () => ({
          get: redisGet,
          set: redisSet,
          del: jest.fn(),
        }),
      } as unknown as CacheService,
    );

    service.registerProvider({
      name: 'paystack',
      secret: 'secret',
      signatureHeader: 'x-paystack-signature',
    });

    const body = { event: 'charge.success', reference: 'same-reference' };
    const rawBody = JSON.stringify(body);

    await expect(
      service.handleWebhook('paystack', {
        rawBody: Buffer.from(rawBody),
        body,
        headers: {
          'x-paystack-signature': sign(rawBody, 'secret'),
        },
      } as unknown as RawBodyRequest<Request>),
    ).rejects.toThrow('Webhook is already being processed');

    expect(emitDynamicStrict).not.toHaveBeenCalled();
  });

  it('fails closed when the processed idempotency marker cannot be saved', async () => {
    const redisGet = jest.fn().mockResolvedValue(null);
    const redisSet = jest
      .fn()
      .mockResolvedValueOnce('OK')
      .mockRejectedValueOnce(new Error('redis down'));
    const redisDel = jest.fn();
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      {
        emitStrict: jest.fn().mockResolvedValue(undefined),
        emitDynamicStrict: jest.fn().mockResolvedValue(undefined),
      } as unknown as EventService,
      {
        getClient: () => ({ get: redisGet, set: redisSet, del: redisDel }),
      } as unknown as CacheService,
    );

    service.registerProvider({
      name: 'paystack',
      secret: 'secret',
      signatureHeader: 'x-paystack-signature',
    });

    const body = { event: 'charge.success', reference: 'same-reference' };
    const rawBody = JSON.stringify(body);

    await expect(
      service.handleWebhook('paystack', {
        rawBody: Buffer.from(rawBody),
        body,
        headers: {
          'x-paystack-signature': sign(rawBody, 'secret'),
        },
      } as unknown as RawBodyRequest<Request>),
    ).rejects.toThrow('Webhook idempotency marker was not saved');

    expect(redisDel).not.toHaveBeenCalled();
  });
});
