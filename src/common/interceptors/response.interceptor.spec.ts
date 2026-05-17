import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

describe('ResponseInterceptor', () => {
  const context = {} as ExecutionContext;
  const run = (value: unknown) =>
    lastValueFrom(
      new ResponseInterceptor().intercept(context, {
        handle: () => of(value),
      } as CallHandler),
    );

  it('flattens controller envelopes instead of nesting data', async () => {
    await expect(
      run({
        data: [{ id: 'user-1' }],
        meta: { total: 1 },
        message: 'Users loaded',
      }),
    ).resolves.toEqual({
      success: true,
      message: 'Users loaded',
      data: [{ id: 'user-1' }],
      meta: { total: 1 },
    });
  });

  it('does not flatten domain objects that merely contain a data field', async () => {
    await expect(
      run({ id: 'event-1', data: { type: 'created' } }),
    ).resolves.toEqual({
      success: true,
      message: 'Success',
      data: { id: 'event-1', data: { type: 'created' } },
    });
  });

  it('only passes through complete standard response envelopes', async () => {
    await expect(
      run({ success: true, message: 'File deleted' }),
    ).resolves.toEqual({
      success: true,
      message: 'Success',
      data: { success: true, message: 'File deleted' },
    });

    await expect(
      run({ success: true, message: 'Done', data: null }),
    ).resolves.toEqual({
      success: true,
      message: 'Done',
      data: null,
    });
  });
});
