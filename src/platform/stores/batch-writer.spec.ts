import { describe, expect, it, vi } from 'vitest';
import { BatchWriter } from './batch-writer.js';

/**
 * The writer behind logs, requests, errors and security events.
 *
 * Its whole contract is about failure: it must never throw at its caller, never
 * grow without bound, and never hide that it dropped something. Those are
 * exactly the paths that do not happen in development, so they are tested here
 * rather than discovered during the incident they were built for.
 */
describe('BatchWriter', () => {
  const flushed = () => {
    const batches: unknown[][] = [];
    return { batches, flush: async (rows: unknown[]) => void batches.push([...rows]) };
  };

  it('flushes once the row threshold is reached, without being asked', async () => {
    const sink = flushed();
    const writer = new BatchWriter({ name: 'test', maxRows: 3, flush: sink.flush });

    writer.add(1);
    writer.add(2);
    expect(sink.batches).toHaveLength(0);

    writer.add(3);
    await writer.flush();

    expect(sink.batches).toEqual([[1, 2, 3]]);
  });

  it('flushes on the timer when traffic is too quiet to fill a batch', async () => {
    vi.useFakeTimers();
    try {
      const sink = flushed();
      const writer = new BatchWriter({
        name: 'test',
        maxRows: 100,
        maxWaitMs: 500,
        flush: sink.flush,
      });

      writer.add('lonely');
      expect(sink.batches).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(600);

      // Without this a low-traffic app's last log line sits in memory
      // indefinitely, and /ops shows nothing while the app is plainly running.
      expect(sink.batches).toEqual([['lonely']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws at the caller when the write fails', async () => {
    const writer = new BatchWriter({
      name: 'test',
      maxRows: 1,
      flush: async () => {
        throw new Error('postgres is down');
      },
    });

    // `add` returns void and cannot reject: telemetry must not be able to fail
    // the request it is describing.
    expect(() => writer.add('x')).not.toThrow();
    await expect(writer.flush()).resolves.toBeUndefined();
  });

  it('retries a failed batch once before giving up', async () => {
    let attempts = 0;
    const writer = new BatchWriter({
      name: 'test',
      maxRows: 10,
      flush: async () => {
        attempts++;
        if (attempts === 1) throw new Error('a blip');
      },
    });

    writer.add('x');
    await writer.flush();

    // The common failure is a momentary connection blip and the rows are still
    // in hand; beyond one retry we drop rather than hammer an unwell database.
    expect(attempts).toBe(2);
    expect(writer.stats().written).toBe(1);
    expect(writer.stats().failed).toBe(0);
  });

  it('counts rows it lost, so a gap in the logs is never unexplained', async () => {
    const writer = new BatchWriter({
      name: 'test',
      maxRows: 10,
      flush: async () => {
        throw new Error('still down');
      },
    });

    writer.add('x');
    writer.add('y');
    await writer.flush();

    const stats = writer.stats();
    expect(stats.failed).toBe(2);
    expect(stats.lastError).toContain('still down');
    // /ops -> Health renders this; a non-zero count is how an operator learns
    // that what they are reading is incomplete.
    expect(stats.lastErrorAt).toBeInstanceOf(Date);
  });

  it('drops rather than growing without bound, and keeps the newest', async () => {
    const sink = flushed();
    const writer = new BatchWriter({
      name: 'test',
      maxRows: 1_000_000,
      maxBuffered: 3,
      flush: sink.flush,
    });

    for (const row of [1, 2, 3, 4, 5]) writer.add(row);
    await writer.flush();

    // The newest rows describe the incident in progress; the oldest describe a
    // system that was still healthy.
    expect(sink.batches).toEqual([[3, 4, 5]]);
    expect(writer.stats().dropped).toBe(2);
  });

  it('serialises flushes so two never hold a connection at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const writer = new BatchWriter({
      name: 'test',
      maxRows: 1,
      flush: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
      },
    });

    writer.add('a');
    writer.add('b');
    writer.add('c');
    await writer.flush();

    // Concurrent flushes would each check out a pool client, which is how
    // telemetry starves the application it shares a database with.
    expect(maxInFlight).toBe(1);
  });

  it('flushes what is buffered on shutdown, then accepts nothing more', async () => {
    const sink = flushed();
    const writer = new BatchWriter({ name: 'test', maxRows: 100, flush: sink.flush });

    writer.add('last words');
    await writer.stop();

    // The rows buffered at shutdown are frequently the reason for it.
    expect(sink.batches).toEqual([['last words']]);

    writer.add('too late');
    await writer.flush();
    expect(sink.batches).toHaveLength(1);
  });

  it('does nothing when there is nothing to write', async () => {
    const sink = flushed();
    const writer = new BatchWriter({ name: 'test', flush: sink.flush });

    await writer.flush();

    // An empty flush that still issued a query would mean a round trip every
    // interval on an idle app, forever.
    expect(sink.batches).toHaveLength(0);
  });
});
