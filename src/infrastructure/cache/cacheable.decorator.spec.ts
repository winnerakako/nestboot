import { Cacheable } from './cacheable.decorator';

class FailingCacheableProbe {
  calls = 0;

  constructor(
    public readonly cacheService: {
      get: jest.Mock;
      set: jest.Mock;
    },
  ) {}

  @Cacheable('probe', (id: string) => `probe:${id}`, 60)
  async load(_id: string) {
    this.calls += 1;
    throw new Error('load failed');
  }
}

class SuccessfulCacheableProbe {
  calls = 0;

  constructor(
    public readonly cacheService: {
      get: jest.Mock;
      set: jest.Mock;
    },
  ) {}

  @Cacheable('probe', (id: string) => `probe:${id}`, 60)
  async load(id: string) {
    this.calls += 1;
    return { id };
  }
}

describe('Cacheable', () => {
  it('does not run the original method twice when it throws', async () => {
    const cacheService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
    };
    const probe = new FailingCacheableProbe(cacheService);

    await expect(probe.load('user-1')).rejects.toThrow('load failed');

    expect(probe.calls).toBe(1);
    expect(cacheService.set).not.toHaveBeenCalled();
  });

  it('returns the original result when cache writes fail', async () => {
    const cacheService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const probe = new SuccessfulCacheableProbe(cacheService);

    await expect(probe.load('user-1')).resolves.toEqual({ id: 'user-1' });

    expect(probe.calls).toBe(1);
    expect(cacheService.set).toHaveBeenCalledWith(
      'probe:user-1',
      { id: 'user-1' },
      60,
    );
  });
});
