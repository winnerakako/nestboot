import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  BeforeApplicationShutdown,
} from '@nestjs/common';

type ShutdownHook = () => Promise<void>;

/**
 * Manages graceful shutdown for the application.
 * Register cleanup hooks from any module — they'll all run
 * in order when the process receives SIGTERM/SIGINT.
 *
 * Usage from any service:
 *   constructor(private shutdown: GracefulShutdownService) {
 *     this.shutdown.addHook('Redis', () => this.redis.quit());
 *   }
 */
@Injectable()
export class GracefulShutdownService
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(GracefulShutdownService.name);
  private readonly hooks: { name: string; fn: ShutdownHook }[] = [];
  private isShuttingDown = false;

  addHook(name: string, fn: ShutdownHook) {
    this.hooks.push({ name, fn });
  }

  async beforeApplicationShutdown(signal?: string) {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.warn(`Shutdown signal received: ${signal || 'unknown'}`);
    this.logger.log(`Running ${this.hooks.length} shutdown hooks...`);

    for (const hook of this.hooks) {
      try {
        this.logger.log(`Shutting down: ${hook.name}`);
        await hook.fn();
        this.logger.log(`${hook.name} shutdown complete`);
      } catch (error) {
        this.logger.error(
          `Error shutting down ${hook.name}: ${(error as Error).message}`,
        );
      }
    }
  }

  async onApplicationShutdown() {
    this.logger.log('Application shutdown complete');
  }

  getIsShuttingDown(): boolean {
    return this.isShuttingDown;
  }
}
