/**
 * Buffered, best-effort writes for telemetry.
 *
 * Every rule about telemetry follows from one invariant: **it may never take
 * down what it observes.** So this writer
 *
 *   - never throws to its caller — `add()` returns void and cannot reject;
 *   - never blocks the request — flushing happens on a timer, off the hot path;
 *   - never grows without bound — past `maxBuffered` it drops, deliberately;
 *   - never hides that it dropped — the counters are rendered in /ops, because
 *     a gap in the logs that nothing accounts for is worse than no logs at all.
 *
 * One writer class, used by logs, requests and errors alike: three copies of
 * this logic would be three chances to get the failure handling subtly wrong.
 */
export interface BatchWriterOptions<T> {
  /** Shown in /ops and in the fallback log line when a flush fails. */
  name: string;
  /** Flush once this many rows are buffered. */
  maxRows?: number;
  /** Flush at least this often, even when quiet. */
  maxWaitMs?: number;
  /** Hard ceiling. Beyond it rows are dropped rather than consuming the heap. */
  maxBuffered?: number;
  flush: (rows: T[]) => Promise<void>;
}

export interface BatchWriterStats {
  buffered: number;
  written: number;
  /** Rows thrown away because the buffer was full. Non-zero means data loss. */
  dropped: number;
  /** Rows thrown away because a flush failed after its retry. Also data loss. */
  failed: number;
  lastErrorAt?: Date;
  lastError?: string;
}

export class BatchWriter<T> {
  private buffer: T[] = [];
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopped = false;

  private written = 0;
  private dropped = 0;
  private failed = 0;
  private lastErrorAt?: Date;
  private lastError?: string;

  private readonly maxRows: number;
  private readonly maxWaitMs: number;
  private readonly maxBuffered: number;

  constructor(private readonly options: BatchWriterOptions<T>) {
    this.maxRows = options.maxRows ?? 100;
    this.maxWaitMs = options.maxWaitMs ?? 500;
    this.maxBuffered = options.maxBuffered ?? 10_000;
  }

  add(row: T): void {
    if (this.stopped) return;

    if (this.buffer.length >= this.maxBuffered) {
      // Intentional: drop the OLDEST. When telemetry is backed up, the newest
      // rows describe the incident in progress; the oldest describe a database
      // that was still healthy. Keep the ones an operator is about to need.
      this.buffer.shift();
      this.dropped++;
    }

    this.buffer.push(row);

    if (this.buffer.length >= this.maxRows) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.maxWaitMs);
    // Never hold the process open for a pending telemetry flush.
    this.timer.unref?.();
  }

  /** Write what is buffered. Resolves even when the write failed. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Serialise flushes: two concurrent ones would each hold a connection, and
    // under load that is how telemetry starves the pool it shares.
    if (this.inFlight) {
      await this.inFlight;
      if (this.buffer.length === 0) return;
    }
    if (this.buffer.length === 0) return;

    const rows = this.buffer;
    this.buffer = [];

    this.inFlight = this.write(rows).finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  private async write(rows: T[]): Promise<void> {
    try {
      await this.options.flush(rows);
      this.written += rows.length;
    } catch {
      // One retry: the common failure is a momentary connection blip, and the
      // rows are still in hand. Beyond that we drop rather than retry forever
      // into a database that is clearly unwell.
      try {
        await this.options.flush(rows);
        this.written += rows.length;
      } catch (retryError) {
        this.failed += rows.length;
        this.lastErrorAt = new Date();
        this.lastError = retryError instanceof Error ? retryError.message : String(retryError);

        // The only place in the app that writes telemetry failures to stderr:
        // writing them through the logger would recurse into this same writer.
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'telemetry flush failed; rows dropped',
            writer: this.options.name,
            rows: rows.length,
            err: this.lastError,
          }),
        );
      }
    }
  }

  /** Flush what is left and stop accepting rows. Called on shutdown. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.flush();
  }

  stats(): BatchWriterStats {
    return {
      buffered: this.buffer.length,
      written: this.written,
      dropped: this.dropped,
      failed: this.failed,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
    };
  }
}
