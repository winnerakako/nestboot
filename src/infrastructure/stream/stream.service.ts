import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import Redis from 'ioredis';
import { CacheService } from '../cache/cache.service';
import { StreamMap, StreamName } from './stream-map';
import { BusinessException } from '../../common/filters';

export interface StreamMessage<T = any> {
  id: string;
  stream: string;
  data: T;
  timestamp: Date;
}

export interface PendingMessageDetail {
  id: string;
  consumer: string;
  idleMs: number;
  deliveryCount: number;
}

export interface StreamGroupStats {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
  /** Number of messages behind the stream head */
  lag: number;
}

export interface StreamStats {
  stream: string;
  length: number;
  firstEntry: string | null;
  lastEntry: string | null;
  groups: StreamGroupStats[];
}

export interface ConsumerGroupSummary {
  stream: string;
  group: string;
  consumers: number;
  pending: number;
  lag: number;
  lastDeliveredId: string;
}

@Injectable()
export class StreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);
  private client: Redis;
  private readonly streamPrefix: string;
  private readonly maxStreamLength: number;

  constructor(private readonly cacheService: CacheService) {
    this.client = this.cacheService.getClient();
    this.streamPrefix = 'stream:';
    this.maxStreamLength = 100000;
  }

  onModuleInit() {
    this.logger.log('Stream service initialized');
  }

  async onModuleDestroy() {
    this.logger.log('Stream service shutdown');
  }

  // ─── Typed Publishing ──────────────────────────────────

  /**
   * Publish a typed message to a stream.
   */
  async publish<K extends StreamName>(
    stream: K,
    data: StreamMap[K],
    maxLen?: number,
  ): Promise<string> {
    return this.publishRaw(
      stream as string,
      data as Record<string, any>,
      maxLen,
    );
  }

  /**
   * Publish an untyped/dynamic message to a stream.
   * Use for streams with runtime-generated names.
   */
  async publishDynamic(
    stream: string,
    data: Record<string, any>,
    maxLen?: number,
  ): Promise<string> {
    return this.publishRaw(stream, data, maxLen);
  }

  /**
   * Publish multiple typed messages to a stream in a pipeline.
   */
  async publishBatch<K extends StreamName>(
    stream: K,
    messages: StreamMap[K][],
  ): Promise<string[]> {
    return this.publishBatchRaw(
      stream as string,
      messages as Record<string, any>[],
    );
  }

  // ─── Raw Publishing ────────────────────────────────────

  private async publishRaw(
    stream: string,
    data: Record<string, any>,
    maxLen?: number,
  ): Promise<string> {
    const key = this.streamKey(stream);
    const fields = this.serializeData(data);
    const trim = maxLen ?? this.maxStreamLength;

    try {
      const id = await this.client.xadd(
        key,
        'MAXLEN',
        '~',
        trim.toString(),
        '*',
        ...fields,
      );

      this.logger.debug(`Published to ${stream}: ${id}`);
      return id!;
    } catch (error) {
      this.logger.error(
        `Failed to publish to ${stream}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  private async publishBatchRaw(
    stream: string,
    messages: Record<string, any>[],
  ): Promise<string[]> {
    const key = this.streamKey(stream);
    const pipeline = this.client.pipeline();

    for (const data of messages) {
      const fields = this.serializeData(data);
      pipeline.xadd(
        key,
        'MAXLEN',
        '~',
        this.maxStreamLength.toString(),
        '*',
        ...fields,
      );
    }

    const results = await pipeline.exec();
    const ids: string[] = [];

    if (results) {
      for (const [err, id] of results) {
        if (err) {
          this.logger.error(`Batch publish error: ${err.message}`);
        } else {
          ids.push(id as string);
        }
      }
    }

    this.logger.debug(`Batch published ${ids.length} messages to ${stream}`);
    return ids;
  }

  // ─── Consumer Groups ───────────────────────────────────

  /**
   * Create a consumer group for a stream.
   * Uses MKSTREAM to create the stream if it doesn't exist.
   * Safe to call multiple times — ignores "BUSYGROUP" if group exists.
   */
  async createConsumerGroup(
    stream: string,
    group: string,
    startId: '0' | '$' = '0',
  ): Promise<void> {
    const key = this.streamKey(stream);

    try {
      await this.client.xgroup('CREATE', key, group, startId, 'MKSTREAM');
      this.logger.log(`Consumer group created: ${group} on ${stream}`);
    } catch (error: any) {
      if (error.message?.includes('BUSYGROUP')) {
        return;
      }
      throw error;
    }
  }

  /**
   * Read new messages from a stream as part of a consumer group.
   */
  async readGroup(
    stream: string,
    group: string,
    consumer: string,
    count = 10,
    blockMs = 5000,
  ): Promise<StreamMessage[]> {
    const key = this.streamKey(stream);

    try {
      const results = await this.client.xreadgroup(
        'GROUP',
        group,
        consumer,
        'COUNT',
        count.toString(),
        'BLOCK',
        blockMs.toString(),
        'STREAMS',
        key,
        '>',
      );

      if (!results) return [];

      return this.parseStreamResults(results, stream);
    } catch (error: any) {
      if (error.message?.includes('NOGROUP')) {
        await this.createConsumerGroup(stream, group);
        return [];
      }
      throw error;
    }
  }

  /**
   * Acknowledge a message (mark as successfully processed).
   */
  async ack(stream: string, group: string, messageId: string): Promise<void> {
    await this.client.xack(this.streamKey(stream), group, messageId);
  }

  /**
   * Acknowledge multiple messages.
   */
  async ackMany(
    stream: string,
    group: string,
    messageIds: string[],
  ): Promise<void> {
    if (messageIds.length === 0) return;
    await this.client.xack(this.streamKey(stream), group, ...messageIds);
  }

  // ─── Pending / Dead Letter ─────────────────────────────

  /**
   * Get pending messages summary for a consumer group.
   */
  async getPending(
    stream: string,
    group: string,
  ): Promise<{
    count: number;
    minId: string | null;
    maxId: string | null;
    consumers: { name: string; count: number }[];
  }> {
    const key = this.streamKey(stream);

    try {
      const result = (await this.client.xpending(key, group)) as any;

      if (!result || result[0] === 0) {
        return { count: 0, minId: null, maxId: null, consumers: [] };
      }

      return {
        count: result[0],
        minId: result[1],
        maxId: result[2],
        consumers: (result[3] || []).map((c: any) => ({
          name: c[0],
          count: parseInt(c[1], 10),
        })),
      };
    } catch (error) {
      this.logger.error(
        `getPending failed for ${stream}/${group}: ${(error as Error).message}`,
      );
      return { count: 0, minId: null, maxId: null, consumers: [] };
    }
  }

  /**
   * Get detailed pending messages with per-message delivery count.
   * This is how you detect poison messages.
   */
  async getPendingDetails(
    stream: string,
    group: string,
    minIdleMs = 0,
    count = 10,
    consumer?: string,
  ): Promise<PendingMessageDetail[]> {
    const key = this.streamKey(stream);

    try {
      // XPENDING key group [IDLE min-idle-time] start end count
      const args: (string | number)[] = [key, group];
      if (minIdleMs > 0) {
        args.push('IDLE', minIdleMs);
      }
      args.push('-', '+', count);
      if (consumer) {
        args.push(consumer);
      }

      const results = (await (this.client as any).xpending(...args)) as any[];

      if (!results || !Array.isArray(results)) return [];

      return results.map((entry: any) => ({
        id: entry[0],
        consumer: entry[1],
        idleMs: parseInt(entry[2], 10),
        deliveryCount: parseInt(entry[3], 10),
      }));
    } catch (error) {
      this.logger.error(
        `getPendingDetails failed for ${stream}/${group}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Claim pending messages that have been idle for too long.
   */
  async claimStale(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs = 60000,
    count = 10,
  ): Promise<StreamMessage[]> {
    const key = this.streamKey(stream);

    try {
      const pending = await this.getPendingDetails(
        stream,
        group,
        minIdleMs,
        count,
      );

      if (pending.length === 0) return [];

      const ids = pending.map((p) => p.id);

      const results = await this.client.xclaim(
        key,
        group,
        consumer,
        minIdleMs.toString(),
        ...ids,
      );

      if (!results || !Array.isArray(results)) return [];

      return results.map((entry: any) => ({
        id: entry[0],
        stream,
        data: this.deserializeFields(entry[1]),
        timestamp: new Date(parseInt(entry[0].split('-')[0], 10)),
      }));
    } catch (error) {
      this.logger.error(
        `claimStale failed for ${stream}/${group}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Claim specific pending messages after their idle threshold has elapsed.
   */
  async claimStaleByIds(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs = 60000,
    ids: string[],
  ): Promise<StreamMessage[]> {
    if (ids.length === 0) return [];

    const key = this.streamKey(stream);

    try {
      const results = await this.client.xclaim(
        key,
        group,
        consumer,
        minIdleMs.toString(),
        ...ids,
      );

      if (!results || !Array.isArray(results)) return [];

      return results.map((entry: any) => ({
        id: entry[0],
        stream,
        data: this.deserializeFields(entry[1]),
        timestamp: new Date(parseInt(entry[0].split('-')[0], 10)),
      }));
    } catch (error) {
      this.logger.error(
        `claimStaleByIds failed for ${stream}/${group}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  // ─── Processing Locks ─────────────────────────────────

  async tryAcquireProcessingLock(
    stream: string,
    group: string,
    messageId: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    const result = await this.client.set(
      this.processingLockKey(stream, group, messageId),
      owner,
      'PX',
      ttlMs,
      'NX',
    );

    return result === 'OK';
  }

  async refreshProcessingLock(
    stream: string,
    group: string,
    messageId: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    const result = await this.client.eval(
      `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("PEXPIRE", KEYS[1], ARGV[2])
        end
        return 0
      `,
      1,
      this.processingLockKey(stream, group, messageId),
      owner,
      ttlMs.toString(),
    );

    return result === 1;
  }

  async releaseProcessingLock(
    stream: string,
    group: string,
    messageId: string,
    owner: string,
  ): Promise<boolean> {
    const result = await this.client.eval(
      `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("DEL", KEYS[1])
        end
        return 0
      `,
      1,
      this.processingLockKey(stream, group, messageId),
      owner,
    );

    return result === 1;
  }

  async isProcessingLocked(
    stream: string,
    group: string,
    messageId: string,
  ): Promise<boolean> {
    const exists = await this.client.exists(
      this.processingLockKey(stream, group, messageId),
    );
    return exists === 1;
  }

  // ─── Replay ────────────────────────────────────────────

  /**
   * Read messages from a stream starting from a specific ID or timestamp.
   */
  async replay(
    stream: string,
    fromId = '0',
    count = 100,
  ): Promise<StreamMessage[]> {
    const key = this.streamKey(stream);

    const results = await this.client.xrange(
      key,
      fromId,
      '+',
      'COUNT',
      count.toString(),
    );

    return results.map((entry) => ({
      id: entry[0],
      stream,
      data: this.deserializeFields(entry[1]),
      timestamp: new Date(parseInt(entry[0].split('-')[0], 10)),
    }));
  }

  /**
   * Replay messages from a specific timestamp.
   */
  async replayFromTimestamp(
    stream: string,
    from: Date,
    count = 100,
  ): Promise<StreamMessage[]> {
    const fromId = `${from.getTime()}-0`;
    return this.replay(stream, fromId, count);
  }

  // ─── Stream Management ─────────────────────────────────

  async getStreamStats(stream: string): Promise<StreamStats | null> {
    const key = this.streamKey(stream);

    try {
      const info = (await this.client.xinfo('STREAM', key)) as any[];
      if (!info) return null;

      const infoMap = this.arrayToMap(info);
      const length = infoMap.get('length') || 0;
      const firstEntry = infoMap.get('first-entry')?.[0] || null;
      const lastEntry = infoMap.get('last-entry')?.[0] || null;

      let groups: StreamGroupStats[] = [];
      try {
        const groupsInfo = (await this.client.xinfo('GROUPS', key)) as any[];
        groups = groupsInfo.map((g: any) => {
          const gMap = this.arrayToMap(g);
          const lastDeliveredId = gMap.get('last-delivered-id') || '0';

          // Calculate lag: messages in stream after lastDeliveredId
          let lag = 0;
          if (lastEntry && lastDeliveredId !== '0') {
            const lastEntryTs = parseInt(lastEntry.split('-')[0], 10);
            const lastDeliveredTs = parseInt(lastDeliveredId.split('-')[0], 10);
            lag =
              lastEntryTs > lastDeliveredTs
                ? gMap.get('lag') || length - (gMap.get('pending') || 0)
                : 0;
          } else if (lastDeliveredId === '0') {
            lag = length;
          }

          return {
            name: gMap.get('name'),
            consumers: gMap.get('consumers') || 0,
            pending: gMap.get('pending') || 0,
            lastDeliveredId,
            lag: Math.max(0, lag),
          };
        });
      } catch {
        // No groups
      }

      return { stream, length, firstEntry, lastEntry, groups };
    } catch {
      return null;
    }
  }

  async getAllStreamStats(): Promise<StreamStats[]> {
    const stats: StreamStats[] = [];
    let cursor = '0';

    // Use SCAN instead of KEYS to avoid blocking Redis
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        `${this.streamPrefix}*`,
        'COUNT',
        '100',
      );
      cursor = nextCursor;

      for (const key of keys) {
        const stream = key.replace(this.streamPrefix, '');
        // Skip dead letter streams — they're internal
        if (stream.startsWith('deadletter:')) continue;
        const stat = await this.getStreamStats(stream);
        if (stat) stats.push(stat);
      }
    } while (cursor !== '0');

    return stats;
  }

  /**
   * Get a summary of all consumer groups across all streams.
   * Shows which groups are behind and need attention.
   */
  async getConsumerGroupSummary(): Promise<ConsumerGroupSummary[]> {
    const allStats = await this.getAllStreamStats();
    const summary: ConsumerGroupSummary[] = [];

    for (const stat of allStats) {
      for (const group of stat.groups) {
        summary.push({
          stream: stat.stream,
          group: group.name,
          consumers: group.consumers,
          pending: group.pending,
          lag: group.lag,
          lastDeliveredId: group.lastDeliveredId,
        });
      }
    }

    // Sort by lag descending — most behind first
    summary.sort((a, b) => b.lag - a.lag);

    return summary;
  }

  /**
   * Reset a consumer group to reprocess messages from a specific point.
   * Use when a consumer had a bug and you need to reprocess.
   *
   * @param stream - Stream name
   * @param group - Consumer group to reset
   * @param fromId - '0' to reprocess everything, '$' for only new, or a specific ID
   */
  async resetConsumerGroup(
    stream: string,
    group: string,
    fromId: '0' | '$' | string = '0',
  ): Promise<void> {
    const key = this.streamKey(stream);
    this.validateResetId(fromId);

    try {
      await this.client.xgroup('SETID', key, group, fromId);
      await this.clearPending(stream, group);
      this.logger.log(
        `Consumer group reset: ${group} on ${stream} to ${fromId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to reset consumer group ${group} on ${stream}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Store a dead letter record in Redis for admin visibility.
   * Called by BaseStreamConsumer when a message exceeds maxRetries.
   */
  async storeDeadLetter(
    stream: string,
    group: string,
    message: StreamMessage,
    reason?: string,
  ): Promise<void> {
    const dlKey = `${this.streamPrefix}deadletter:${stream}:${group}`;

    try {
      await this.client.xadd(
        dlKey,
        'MAXLEN',
        '~',
        '1000', // Keep last 1000 dead letters per stream/group
        '*',
        'data',
        JSON.stringify(message.data),
        'originalId',
        message.id,
        'stream',
        stream,
        'group',
        group,
        'reason',
        reason || 'max retries exceeded',
        'deadAt',
        new Date().toISOString(),
      );
    } catch (error) {
      this.logger.error(
        `Failed to store dead letter: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Get dead letter messages for a stream/group.
   */
  async getDeadLetters(
    stream: string,
    group: string,
    count = 50,
  ): Promise<StreamMessage[]> {
    const dlKey = `${this.streamPrefix}deadletter:${stream}:${group}`;

    try {
      const results = await this.client.xrevrange(
        dlKey,
        '+',
        '-',
        'COUNT',
        count.toString(),
      );

      return results.map((entry) => ({
        id: entry[0],
        stream,
        data: this.deserializeFields(entry[1]),
        timestamp: new Date(parseInt(entry[0].split('-')[0], 10)),
      }));
    } catch {
      return [];
    }
  }

  async trim(stream: string, maxLen: number): Promise<number> {
    if (!Number.isInteger(maxLen) || maxLen < 1) {
      throw new BusinessException('maxLen must be a positive integer');
    }

    return this.client.xtrim(this.streamKey(stream), 'MAXLEN', maxLen);
  }

  async deleteStream(stream: string): Promise<void> {
    await this.client.del(this.streamKey(stream));
    this.logger.log(`Stream deleted: ${stream}`);
  }

  async deleteConsumer(
    stream: string,
    group: string,
    consumer: string,
  ): Promise<number> {
    const pending = await this.getPendingDetails(stream, group, 0, 1, consumer);
    if (pending.length > 0) {
      throw new BusinessException(
        `Cannot delete consumer "${consumer}" while it has pending messages. Claim or acknowledge pending messages first.`,
      );
    }

    return this.client.xgroup(
      'DELCONSUMER',
      this.streamKey(stream),
      group,
      consumer,
    ) as Promise<number>;
  }

  // ─── Helpers ───────────────────────────────────────────

  private streamKey(stream: string): string {
    return `${this.streamPrefix}${stream}`;
  }

  private processingLockKey(
    stream: string,
    group: string,
    messageId: string,
  ): string {
    return `${this.streamPrefix}processing:${stream}:${group}:${messageId}`;
  }

  private validateResetId(fromId: string): void {
    if (fromId === '$' || /^\d+(?:-\d+)?$/.test(fromId)) {
      return;
    }

    throw new BusinessException(
      'fromId must be "$", "0", or a valid Redis stream ID',
    );
  }

  private async clearPending(stream: string, group: string): Promise<void> {
    while (true) {
      const pending = await this.getPendingDetails(stream, group, 0, 100);
      if (pending.length === 0) return;

      await this.ackMany(
        stream,
        group,
        pending.map((message) => message.id),
      );
    }
  }

  private serializeData(data: Record<string, any>): string[] {
    return ['data', JSON.stringify(data), 'ts', Date.now().toString()];
  }

  private deserializeFields(fields: string[]): any {
    const map = new Map<string, string>();
    for (let i = 0; i < fields.length; i += 2) {
      map.set(fields[i], fields[i + 1]);
    }

    const dataStr = map.get('data');
    if (dataStr) {
      try {
        return JSON.parse(dataStr);
      } catch {
        return { raw: dataStr };
      }
    }

    const obj: Record<string, string> = {};
    map.forEach((v, k) => {
      obj[k] = v;
    });
    return obj;
  }

  private parseStreamResults(
    results: any,
    streamName: string,
  ): StreamMessage[] {
    const messages: StreamMessage[] = [];

    for (const [, entries] of results) {
      for (const [id, fields] of entries) {
        messages.push({
          id,
          stream: streamName,
          data: this.deserializeFields(fields),
          timestamp: new Date(parseInt(id.split('-')[0], 10)),
        });
      }
    }

    return messages;
  }

  private arrayToMap(arr: any[]): Map<string, any> {
    const map = new Map();
    for (let i = 0; i < arr.length; i += 2) {
      map.set(arr[i], arr[i + 1]);
    }
    return map;
  }
}
