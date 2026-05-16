import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose, { Connection, Model } from 'mongoose';
import {
  createRequestLogSchema,
  createRequestStatsSchema,
  createQueryLogSchema,
  createQueryStatsSchema,
  createAppLogSchema,
  createCronLogSchema,
  createCronConfigSchema,
  IRequestLog,
  IRequestStats,
  IQueryLog,
  IQueryStats,
  IAppLog,
  ICronLog,
  ICronConfig,
} from '../schemas';

@Injectable()
export class LogConnectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LogConnectionService.name);
  private connection: Connection | null = null;
  private _connected = false;
  private readyResolver: (() => void) | null = null;
  private readonly ready = new Promise<void>((resolve) => {
    this.readyResolver = resolve;
  });

  requestLog!: Model<IRequestLog>;
  requestStats!: Model<IRequestStats>;
  queryLog!: Model<IQueryLog>;
  queryStats!: Model<IQueryStats>;
  appLog!: Model<IAppLog>;
  cronLog!: Model<ICronLog>;
  cronConfig!: Model<ICronConfig>;

  constructor(private readonly configService: ConfigService) {}

  get isConnected(): boolean {
    return this._connected;
  }

  get isConfigured(): boolean {
    return !!this.configService.get<string>('logging.mongoUri');
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  async onModuleInit() {
    const uri = this.configService.get<string>('logging.mongoUri');
    if (!uri) {
      this.logger.warn(
        'MONGO_LOG_URI not set — logging module disabled. Logs will only go to stdout.',
      );
      this.markReady();
      return;
    }

    try {
      const conn = await mongoose
        .createConnection(uri, {
          maxPoolSize: 5,
          minPoolSize: 1,
          serverSelectionTimeoutMS: 5000,
          socketTimeoutMS: 30000,
        })
        .asPromise();

      this.connection = conn;
      this._connected = true;

      const ttl = this.configService.get('logging.ttl')!;

      // Register schemas directly on dedicated connection — no default connection pollution
      this.requestLog = conn.model<IRequestLog>(
        'RequestLog',
        createRequestLogSchema(ttl.requestLogs),
      );
      this.requestStats = conn.model<IRequestStats>(
        'RequestStats',
        createRequestStatsSchema(ttl.requestStats),
      );
      this.queryLog = conn.model<IQueryLog>(
        'QueryLog',
        createQueryLogSchema(ttl.queryLogs),
      );
      this.queryStats = conn.model<IQueryStats>(
        'QueryStats',
        createQueryStatsSchema(ttl.queryStats),
      );
      this.appLog = conn.model<IAppLog>(
        'AppLog',
        createAppLogSchema(ttl.appLogs),
      );
      this.cronLog = conn.model<ICronLog>(
        'CronLog',
        createCronLogSchema(ttl.cronLogs),
      );
      this.cronConfig = conn.model<ICronConfig>(
        'CronConfig',
        createCronConfigSchema(),
      );

      conn.on('disconnected', () => {
        this._connected = false;
        this.logger.warn(
          'MongoDB log connection lost — falling back to stdout',
        );
      });

      conn.on('reconnected', () => {
        this._connected = true;
        this.logger.log('MongoDB log connection restored');
      });

      conn.on('error', (err) => {
        this.logger.error(`MongoDB log connection error: ${err.message}`);
      });

      this.logger.log('MongoDB log connection established');
    } catch (error) {
      this.logger.error(
        `Failed to connect to MongoDB for logging: ${(error as Error).message}. Logs will go to stdout only.`,
      );
    } finally {
      this.markReady();
    }
  }

  async onModuleDestroy() {
    if (this.connection) {
      await this.connection.close();
      this.logger.log('MongoDB log connection closed');
    }
  }

  private markReady(): void {
    this.readyResolver?.();
    this.readyResolver = null;
  }
}
