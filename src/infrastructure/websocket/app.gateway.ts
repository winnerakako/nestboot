import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { RedisService } from '../cache/redis.service';
import {
  getJwtOrgId,
  getJwtSubject,
  RawJwtPayload,
  resolveJwtRole,
} from '../auth/jwt-payload.util';

const MAX_CONNECTIONS_PER_USER = 5;
const RATE_LIMIT_WINDOW_MS = 10000; // 10 seconds
const RATE_LIMIT_MAX_MESSAGES = 50; // 50 messages per 10 seconds
const MAX_CUSTOM_ROOMS_PER_USER = 20;
const CONNECTION_LOCK_TTL_MS = 10000;
const CONNECTION_LOCK_RETRY_ATTEMPTS = 100;
const CONNECTION_LOCK_RETRY_DELAY_MS = 50;
const RELEASE_CONNECTION_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userRole?: string;
  userOrgId?: string;
}

interface AuthenticatedJwtPayload {
  sub: string;
  role: string;
  orgId?: string;
}

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3001',
    credentials: true,
  },
  namespace: '/',
})
export class AppGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnApplicationShutdown
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(AppGateway.name);

  /** userId → Set of socketIds */
  private readonly userSockets = new Map<string, Set<string>>();

  /** socketId → message timestamps for rate limiting */
  private readonly rateLimitMap = new Map<string, number[]>();
  private readonly connectionLocks = new Map<string, Promise<void>>();
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
  ) {}

  async afterInit(server: Server) {
    // Attach Redis adapter for multi-server support
    try {
      this.pubClient = this.redisService.getClient().duplicate();
      this.subClient = this.redisService.getClient().duplicate();
      server.adapter(createAdapter(this.pubClient, this.subClient));
      this.logger.log('WebSocket Redis adapter attached (multi-server ready)');
    } catch (error) {
      await this.closeRedisAdapterClients();
      this.logger.warn(
        `WebSocket Redis adapter failed: ${(error as Error).message}. Running in single-server mode.`,
      );
    }

    this.logger.log('WebSocket gateway initialized');
  }

  // ─── Connection Lifecycle ──────────────────────────────

  async handleConnection(client: AuthenticatedSocket) {
    // Authenticate via JWT in handshake
    const token = this.extractAuthToken(client);

    if (!token) {
      client.emit('error:auth', { message: 'Authentication required' });
      client.disconnect();
      return;
    }

    try {
      const secret = this.configService.get<string>(
        'auth.jwtSecret',
        'change-me-in-production',
      );
      const rawPayload = this.jwtService.verify<RawJwtPayload>(token, {
        secret,
      });
      const payload = this.normalizeJwtPayload(rawPayload);

      client.userId = payload.sub;
      client.userRole = payload.role;
      client.userOrgId = payload.orgId;
      client.data.userId = payload.sub;
      client.data.userRole = payload.role;
      client.data.userOrgId = payload.orgId;
    } catch {
      client.emit('error:auth', { message: 'Invalid or expired token' });
      client.disconnect();
      return;
    }

    // Enforce and register under a per-user lock so concurrent connects cannot
    // race past the connection cap.
    const userId = client.userId!;
    let registered: boolean;
    try {
      registered = await this.withUserConnectionLock(userId, async () => {
        const existingConnectionCount =
          await this.getUserConnectionCount(userId);

        if (existingConnectionCount >= MAX_CONNECTIONS_PER_USER) {
          client.emit('error:max-connections', {
            message: `Maximum ${MAX_CONNECTIONS_PER_USER} connections per user`,
            max: MAX_CONNECTIONS_PER_USER,
          });
          client.disconnect();
          return false;
        }

        // Auto-join rooms based on user identity before publishing local state.
        await client.join(`user:${userId}`);
        await client.join(`role:${client.userRole!}`);
        if (client.userOrgId) await client.join(`org:${client.userOrgId}`);

        // Register socket
        const existing = this.userSockets.get(userId) || new Set();
        existing.add(client.id);
        this.userSockets.set(userId, existing);

        this.logger.debug(
          `Connected: ${client.id} (user: ${userId}, connections: ${existingConnectionCount + 1})`,
        );
        return true;
      });
    } catch (error) {
      this.logger.warn(
        `Connection limit check failed for user ${userId}: ${(error as Error).message}`,
      );
      client.emit('error:max-connections', {
        message: 'Unable to verify connection limit. Please retry.',
        max: MAX_CONNECTIONS_PER_USER,
      });
      client.disconnect();
      return;
    }

    if (!registered) return;
  }

  handleDisconnect(client: AuthenticatedSocket) {
    const userId = client.userId;
    if (!userId) return;

    // Unregister socket
    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(client.id);
      if (sockets.size === 0) {
        this.userSockets.delete(userId);
      }
    }

    // Clean up rate limit tracking
    this.rateLimitMap.delete(client.id);

    this.logger.debug(
      `Disconnected: ${client.id} (user: ${userId}, remaining: ${sockets?.size || 0})`,
    );
  }

  private extractAuthToken(client: AuthenticatedSocket): string | undefined {
    const auth = client.handshake.auth as { token?: unknown } | undefined;
    if (typeof auth?.token === 'string' && auth.token.length > 0) {
      return auth.token;
    }

    const authorization = client.handshake.headers?.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      return undefined;
    }

    const token = authorization.slice('Bearer '.length);
    return token.length > 0 ? token : undefined;
  }

  // ─── Message Handlers ──────────────────────────────────

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    if (!this.checkRateLimit(client)) return;
    return { event: 'pong', data: { timestamp: Date.now() } };
  }

  @SubscribeMessage('room:join')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { room: string },
  ) {
    if (!this.checkRateLimit(client)) return;
    if (!data?.room) return;

    // Only allow joining rooms prefixed with 'custom:' to prevent hijacking system rooms
    const room = `custom:${data.room}`;

    // Limit custom rooms per user to prevent memory exhaustion
    const currentRooms = Array.from(client.rooms).filter((r) =>
      r.startsWith('custom:'),
    );
    if (
      currentRooms.length >= MAX_CUSTOM_ROOMS_PER_USER &&
      !currentRooms.includes(room)
    ) {
      client.emit('error:max-rooms', {
        message: `Maximum ${MAX_CUSTOM_ROOMS_PER_USER} custom rooms per connection`,
      });
      return;
    }

    await client.join(room);
    return { event: 'room:joined', data: { room } };
  }

  @SubscribeMessage('room:leave')
  async handleLeaveRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { room: string },
  ) {
    if (!this.checkRateLimit(client)) return;
    if (!data?.room) return;

    const room = `custom:${data.room}`;
    await client.leave(room);
    return { event: 'room:left', data: { room } };
  }

  // ─── Rate Limiting ─────────────────────────────────────

  private checkRateLimit(client: Socket): boolean {
    const now = Date.now();
    const timestamps = this.rateLimitMap.get(client.id) || [];

    // Remove timestamps outside the window
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    this.rateLimitMap.set(client.id, recent);

    if (recent.length > RATE_LIMIT_MAX_MESSAGES) {
      client.emit('error:rate-limited', {
        message: `Rate limited: max ${RATE_LIMIT_MAX_MESSAGES} messages per ${RATE_LIMIT_WINDOW_MS / 1000}s`,
      });
      return false;
    }

    return true;
  }

  // ─── Graceful Shutdown ─────────────────────────────────

  async onApplicationShutdown() {
    if (!this.server) return;

    // Notify all clients before disconnecting
    this.server.emit('server:shutdown', {
      message: 'Server is restarting. Please reconnect shortly.',
      reconnectAfterMs: 5000,
    });

    // Give clients a moment to receive the message
    await new Promise((resolve) => setTimeout(resolve, 1000));

    this.server.disconnectSockets(true);
    await this.closeRedisAdapterClients();
    this.logger.log('All WebSocket clients disconnected for shutdown');
  }

  // ─── Stats (used by WebSocketService) ──────────────────

  async getOnlineUserCount(): Promise<number> {
    const sockets = await this.tryFetchSockets();
    if (sockets) {
      return new Set(
        sockets
          .map((socket) => socket.data?.userId)
          .filter((userId): userId is string => typeof userId === 'string'),
      ).size;
    }

    return this.userSockets.size;
  }

  async getTotalConnectionCount(): Promise<number> {
    const sockets = await this.tryFetchSockets();
    if (sockets) return sockets.length;

    let total = 0;
    for (const sockets of this.userSockets.values()) {
      total += sockets.size;
    }
    return total;
  }

  async getOnlineUserIds(): Promise<string[]> {
    const sockets = await this.tryFetchSockets();
    if (sockets) {
      return Array.from(
        new Set(
          sockets
            .map((socket) => socket.data?.userId)
            .filter((userId): userId is string => typeof userId === 'string'),
        ),
      );
    }

    return Array.from(this.userSockets.keys());
  }

  async isUserOnline(userId: string): Promise<boolean> {
    return (await this.getUserConnectionCount(userId)) > 0;
  }

  async getUserConnectionCount(userId: string): Promise<number> {
    const sockets = await this.tryFetchSockets(`user:${userId}`);
    if (sockets) return sockets.length;

    return this.userSockets.get(userId)?.size || 0;
  }

  isRedisAdapterHealthy(): boolean {
    if (!this.server) return false;
    if (!this.pubClient && !this.subClient) return true;

    return (
      this.pubClient?.status === 'ready' && this.subClient?.status === 'ready'
    );
  }

  private normalizeJwtPayload(payload: RawJwtPayload): AuthenticatedJwtPayload {
    const subject = getJwtSubject(payload);
    const role = resolveJwtRole(payload);

    if (!subject || !role) {
      throw new Error('Invalid token payload');
    }

    return {
      sub: subject,
      role,
      orgId: getJwtOrgId(payload),
    };
  }

  private async withUserConnectionLock<T>(
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withLocalUserConnectionLock(userId, () =>
      this.withDistributedUserConnectionLock(userId, operation),
    );
  }

  private async withLocalUserConnectionLock<T>(
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.connectionLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => current);
    this.connectionLocks.set(userId, chained);

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.connectionLocks.get(userId) === chained) {
        this.connectionLocks.delete(userId);
      }
    }
  }

  private async withDistributedUserConnectionLock<T>(
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.pubClient && !this.subClient) {
      return operation();
    }

    const client = this.redisService.getClient();
    const lockKey = `ws:connection-lock:${userId}`;
    const lockToken = `${process.pid}:${client.options.connectionName ?? 'ws'}:${Date.now()}:${Math.random()}`;

    for (let attempt = 0; attempt < CONNECTION_LOCK_RETRY_ATTEMPTS; attempt++) {
      const acquired = await client.set(
        lockKey,
        lockToken,
        'PX',
        CONNECTION_LOCK_TTL_MS,
        'NX',
      );

      if (acquired === 'OK') {
        try {
          return await operation();
        } finally {
          try {
            await client.eval(
              RELEASE_CONNECTION_LOCK_SCRIPT,
              1,
              lockKey,
              lockToken,
            );
          } catch (error) {
            this.logger.warn(
              `Failed to release WebSocket connection lock: ${(error as Error).message}`,
            );
          }
        }
      }

      await this.sleep(CONNECTION_LOCK_RETRY_DELAY_MS);
    }

    throw new Error('Timed out waiting for distributed connection lock');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async tryFetchSockets(room?: string): Promise<any[] | null> {
    if (!this.server) return null;

    try {
      const target = room ? this.server.in(room) : this.server;
      return (await target.fetchSockets()) as any[];
    } catch (error) {
      this.logger.warn(
        `WebSocket socket fetch failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async closeRedisAdapterClients(): Promise<void> {
    const clients = [this.pubClient, this.subClient].filter(
      (client): client is Redis => !!client,
    );
    this.pubClient = undefined;
    this.subClient = undefined;

    await Promise.allSettled(clients.map((client) => client.quit()));
  }
}
