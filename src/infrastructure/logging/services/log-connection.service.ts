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

      const ttl = this.configService.get('logging.ttl') as {
        requestLogs: number;
        requestStats: number;
        queryLogs: number;
        queryStats: number;
        appLogs: number;
        cronLogs: number;
      };

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
        `Failed to connect to MongoDB for logging: ${(error as Error).message}. Will retry in 30s.`,
      );
      this.scheduleReconnect(uri);
    } finally {
      this.markReady();
    }
  }

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;

  private scheduleReconnect(uri: string) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(
        `MongoDB logging: giving up after ${this.maxReconnectAttempts} reconnect attempts. Logs will go to stdout only.`,
      );
      return;
    }

    const delay = Math.min(30000 * Math.pow(2, this.reconnectAttempts), 300000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      this.logger.log(
        `MongoDB logging: reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`,
      );

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
        this.reconnectAttempts = 0;

        const ttl = this.configService.get('logging.ttl') as {
          requestLogs: number;
          requestStats: number;
          queryLogs: number;
          queryStats: number;
          appLogs: number;
          cronLogs: number;
        };
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

        this.logger.log('MongoDB log connection established (reconnected)');
      } catch (error) {
        this.logger.error(
          `MongoDB logging reconnect failed: ${(error as Error).message}`,
        );
        this.scheduleReconnect(uri);
      }
    }, delay);
  }

  async onModuleDestroy() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
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
