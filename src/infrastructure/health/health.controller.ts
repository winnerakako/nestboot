import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../../common/decorators';
import { SkipThrottle } from '../../common/guards';
import { PrismaService } from '../../database';
import { RedisHealthIndicator } from './indicators/redis.health';
import { MongoHealthIndicator } from './indicators/mongo.health';
import { QueueHealthIndicator } from './indicators/queue.health';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  private readonly heapThreshold: number;
  private readonly rssThreshold: number;
  private readonly diskThreshold: number;

  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly redisHealth: RedisHealthIndicator,
    private readonly mongoHealth: MongoHealthIndicator,
    private readonly queueHealth: QueueHealthIndicator,
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.heapThreshold =
      configService.get<number>('HEALTH_HEAP_MB', 300) * 1024 * 1024;
    this.rssThreshold =
      configService.get<number>('HEALTH_RSS_MB', 500) * 1024 * 1024;
    this.diskThreshold =
      configService.get<number>('HEALTH_DISK_PERCENT', 90) / 100;
  }

  /**
   * Full health check — called by Docker, K8s, load balancers.
   * Public (no auth) so infrastructure can call it.
   */
  @Public()
  @SkipThrottle()
  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Full health check (DB, Redis, MongoDB, queues, memory, disk)',
  })
  check() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      () => this.redisHealth.isHealthy('redis'),
      () => this.mongoHealth.isHealthy('mongodb'),
      () => this.queueHealth.isHealthy('queues'),
      () => this.memory.checkHeap('memory_heap', this.heapThreshold),
      () => this.memory.checkRSS('memory_rss', this.rssThreshold),
      () =>
        this.disk.checkStorage('disk', {
          thresholdPercent: this.diskThreshold,
          path: '/',
        }),
    ]);
  }

  /**
   * Lightweight liveness probe — just checks if the process is running.
   * Use for K8s livenessProbe (fast, no external deps).
   */
  @Public()
  @SkipThrottle()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe (is the process alive?)' })
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness probe — checks if the app can serve traffic.
   * Use for K8s readinessProbe (checks DB + Redis).
   */
  @Public()
  @SkipThrottle()
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe (can the app serve traffic?)' })
  ready() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      () => this.redisHealth.isHealthy('redis'),
    ]);
  }
}
