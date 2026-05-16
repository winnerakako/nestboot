# NestBoot

A production-grade NestJS scaffold with batteries included. NestBoot provides a complete backend foundation featuring authentication, caching, job queues, real-time WebSockets, email, file uploads, cron scheduling, event streaming, structured logging, health checks, and more — all pre-wired and ready to extend.

## Table of Contents

- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Infrastructure Services](#infrastructure-services)
  - [Database (Prisma + PostgreSQL)](#database-prisma--postgresql)
  - [Authentication (JWT)](#authentication-jwt)
  - [Cache (Redis)](#cache-redis)
  - [Job Queues (BullMQ)](#job-queues-bullmq)
  - [Event System](#event-system)
  - [Redis Streams](#redis-streams)
  - [Cron Jobs](#cron-jobs)
  - [Email](#email)
  - [File Upload (Local + S3)](#file-upload-local--s3)
  - [WebSockets (Socket.IO)](#websockets-socketio)
  - [Webhooks](#webhooks)
  - [Health Checks](#health-checks)
  - [Logging (MongoDB)](#logging-mongodb)
- [Common Utilities](#common-utilities)
  - [Decorators](#decorators)
  - [Guards](#guards)
  - [Interceptors](#interceptors)
  - [Pipes](#pipes)
  - [Services](#services)
  - [Utilities](#utilities)
- [API Standards](#api-standards)
- [Security](#security)
- [Docker](#docker)
- [Scripts](#scripts)
- [Adding Your Own Modules](#adding-your-own-modules)

---

## Quick Start

### Prerequisites

- Node.js >= 22
- Docker & Docker Compose (for infrastructure services)

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment variables
cp .env.example .env

# 3. Start infrastructure (PostgreSQL, Redis, MongoDB)
npm run docker:up

# 4. Generate Prisma client
npm run prisma:generate

# 5. Run database migrations
npm run prisma:migrate

# 6. Start in development mode
npm run start:dev
```

The API will be available at `http://localhost:3000/api` and Swagger docs at `http://localhost:3000/docs`.

---

## Project Structure

```
nestboot/
├── prisma/
│   └── schema.prisma              # Database schema
├── templates/
│   └── email/                     # Handlebars email templates
│       ├── layout.hbs             # Base email layout
│       ├── welcome.hbs            # Welcome email
│       └── password-reset.hbs     # Password reset email
├── src/
│   ├── main.ts                    # Bootstrap (Swagger, CORS, Helmet, Pipes)
│   ├── app.module.ts              # Root module wiring
│   ├── config/                    # Environment-based configuration
│   │   ├── app.config.ts
│   │   ├── auth.config.ts
│   │   ├── database.config.ts
│   │   ├── email.config.ts
│   │   ├── logging.config.ts
│   │   ├── redis.config.ts
│   │   ├── upload.config.ts
│   │   └── env.validation.ts      # Joi schema validation
│   ├── common/                    # Shared building blocks
│   │   ├── decorators/
│   │   ├── dto/
│   │   ├── filters/
│   │   ├── guards/
│   │   ├── interceptors/
│   │   ├── interfaces/
│   │   ├── middlewares/
│   │   ├── pipes/
│   │   ├── services/
│   │   └── utils/
│   ├── database/                  # Prisma service, transactions, bulk ops
│   ├── infrastructure/            # Pre-built infrastructure modules
│   │   ├── auth/
│   │   ├── cache/
│   │   ├── cron/
│   │   ├── email/
│   │   ├── events/
│   │   ├── health/
│   │   ├── logging/
│   │   ├── queue/
│   │   ├── stream/
│   │   ├── upload/
│   │   ├── webhook/
│   │   └── websocket/
│   └── modules/                   # Your domain modules go here
├── docker-compose.yml
├── Dockerfile
└── package.json
```

---

## Configuration

All configuration is loaded from environment variables using `@nestjs/config` with Joi validation. Copy `.env.example` to `.env` and customize.

### App

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Environment (`development`, `production`, `test`) |
| `PORT` | `3000` | Server port |
| `APP_NAME` | `NestBoot` | Application name (used in Swagger, emails) |
| `API_PREFIX` | `api` | Global route prefix |
| `API_VERSION` | `v1` | Default API version |
| `FRONTEND_URL` | `http://localhost:3001` | CORS allowed origin |

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/nestboot?schema=public` | PostgreSQL connection string |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | — | Access token signing secret (required) |
| `JWT_EXPIRES_IN` | `15m` | Access token TTL |
| `JWT_REFRESH_SECRET` | — | Refresh token signing secret |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh token TTL |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |

### Redis

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis password (optional) |
| `REDIS_DB` | `0` | Redis database number |

### Email

| Variable | Default | Description |
|----------|---------|-------------|
| `EMAIL_TRANSPORT` | `smtp` | Email transport type |
| `EMAIL_HOST` | `smtp.gmail.com` | SMTP host |
| `EMAIL_PORT` | `587` | SMTP port |
| `EMAIL_SECURE` | `false` | Use TLS |
| `EMAIL_USER` | — | SMTP username |
| `EMAIL_PASSWORD` | — | SMTP password |
| `EMAIL_FROM` | `noreply@example.com` | Default sender address |
| `EMAIL_FROM_NAME` | `NestBoot` | Default sender name |

### Upload

| Variable | Default | Description |
|----------|---------|-------------|
| `UPLOAD_DRIVER` | `local` | Storage driver (`local` or `s3`) |
| `MAX_FILE_SIZE` | `10485760` | Max upload size in bytes (10MB) |
| `ALLOWED_MIME_TYPES` | `image/jpeg,image/png,...` | Comma-separated allowed types |
| `UPLOAD_LOCAL_DEST` | `./uploads` | Local storage directory |
| `AWS_REGION` | `us-east-1` | S3 region |
| `AWS_S3_BUCKET` | — | S3 bucket name |
| `AWS_ACCESS_KEY_ID` | — | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | — | AWS secret key |
| `PRESIGNED_URL_EXPIRY` | `3600` | Presigned URL validity (seconds) |

### Webhooks

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_PROVIDERS` | — | JSON array of provider configs |
| `PAYSTACK_WEBHOOK_SECRET` | — | Paystack webhook secret (auto-registers) |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_LOG_URI` | — | MongoDB URI for logs (module disabled if empty) |
| `LOG_TTL_REQUEST` | `48` | Request log retention (hours) |
| `LOG_TTL_APP` | `720` | App log retention (hours) |
| `LOG_TTL_CRON` | `168` | Cron log retention (hours) |
| `LOG_SAMPLE_RATE` | `1.0` | Request log sampling (0.0 - 1.0) |
| `LOG_SLOW_THRESHOLD` | `1000` | Slow request threshold (ms) |
| `LOG_QUERY_SLOW_THRESHOLD` | `100` | Slow query threshold (ms) |
| `LOG_FLUSH_INTERVAL` | `5000` | Buffer flush interval (ms) |

### Error Tracking

| Variable | Default | Description |
|----------|---------|-------------|
| `SENTRY_DSN` | — | Sentry DSN (install `@sentry/node` to enable) |

---

## Infrastructure Services

### Database (Prisma + PostgreSQL)

The database layer uses **Prisma ORM** with a PostgreSQL datasource. The `DatabaseModule` is global and provides:

**PrismaService** — Extended Prisma client with lifecycle management and helpers:
- `registerSoftDeleteModels()` — Enables soft delete filtering on specified models
- `notDeleted()` — Where clause helper for soft delete queries
- `softDelete()` — Sets `deletedAt` timestamp instead of deleting
- `registerAuditModels()` / `auditCreate(userId)` / `auditUpdate(userId)` — Automatic `createdBy`/`updatedBy` field population

**TransactionHelper** — Safe transaction wrapper:
```typescript
await this.transactionHelper.run(async (tx) => {
  await tx.user.create({ ... });
  await tx.account.create({ ... });
});
```

**BulkHelper** — Efficient batch operations:
```typescript
await this.bulkHelper.createMany('user', users, { batchSize: 500 });
await this.bulkHelper.processInBatches('user', { where: {} }, async (batch) => { ... });
```

**Prisma commands:**
```bash
npm run prisma:generate   # Generate client after schema changes
npm run prisma:migrate    # Create and apply migrations
npm run prisma:studio     # Open visual database browser
```

---

### Authentication (JWT)

The `AuthModule` provides JWT-based authentication globally:

- **Passport JWT Strategy** — Extracts Bearer token, validates structure
- **JwtAuthGuard** — Applied globally; respects `@Public()` decorator
- **RolesGuard** — Role-based access control with `@Roles('admin', 'user')`

**JWT Payload shape:**
```typescript
interface JwtPayload {
  sub: string;    // User ID
  email: string;
  role: string;
}
```

**Usage in controllers:**
```typescript
@Get('profile')
getProfile(@CurrentUser() user: JwtPayload) {
  return user;
}

@Public()
@Post('login')
login() { ... }

@Roles('admin')
@Delete(':id')
remove() { ... }
```

---

### Cache (Redis)

Two services for different use cases:

**CacheService** — Application-level caching with safety guarantees:
```typescript
// Cache-aside pattern with stampede protection
const users = await this.cacheService.getOrSet(
  'users',
  'active-list',
  () => this.db.user.findMany(),
  300, // TTL in seconds
);

// Invalidate
await this.cacheService.del('users', 'active-list');
await this.cacheService.delByPattern('users:*');
```

**RedisService** — Low-level Redis access for infrastructure (rate limiting, locks, streams):
```typescript
const client = this.redisService.getClient();
await client.set('key', 'value', 'EX', 60);
```

**@Cacheable decorator** — Method-level caching:
```typescript
@Cacheable('users', (id: string) => `user:${id}`, 300)
async findUser(id: string) { ... }

@CacheInvalidate((id: string) => [`cache:users:user:${id}`])
async updateUser(id: string, data: any) { ... }
```

---

### Job Queues (BullMQ)

Redis-backed job queues with retry, rate limiting, and worker management.

**QueueService** — Register and manage queues:
```typescript
// Register a queue
this.queueService.registerQueue('notifications', {
  limiter: { max: 100, duration: 60000 }, // 100 jobs/min
});

// Add jobs
await this.queueService.addJob('notifications', 'send-push', { userId, message });
await this.queueService.addBulk('notifications', jobs);

// Administration
await this.queueService.retryAllFailed('notifications');
const stats = await this.queueService.getAllStats();
```

**BaseWorker** — Create workers by extending the base class:
```typescript
@Injectable()
export class NotificationWorker extends BaseWorker {
  protected queueName = 'notifications';
  protected concurrency = 5;

  protected handlers = {
    'send-push': this.handleSendPush.bind(this),
    'send-sms': this.handleSendSms.bind(this),
  };

  private async handleSendPush(job: Job) {
    // Process job
  }
}
```

---

### Event System

Type-safe in-process event bus built on EventEmitter2:

**Define events** in `src/infrastructure/events/event-map.ts`:
```typescript
export interface EventMap {
  'user.created': { userId: string; email: string };
  'order.placed': { orderId: string; total: number };
}
```

**Emit events:**
```typescript
this.eventService.emit('user.created', { userId: '123', email: 'a@b.com' });
await this.eventService.emitAsync('order.placed', { orderId: '456', total: 99 });
```

**Listen to events:**
```typescript
@OnEvent('user.created')
handleUserCreated(payload: EventMap['user.created']) { ... }
```

Features: wildcard support (`user.*`), async listeners, error isolation, strict mode.

---

### Redis Streams

Durable, replayable event streaming with consumer groups and dead letter handling.

**Define streams** in `src/infrastructure/stream/stream-map.ts`:
```typescript
export interface StreamMap {
  'payment.confirmed': { paymentId: string; amount: number };
  'loan.approved': { loanId: string };
}
```

**Publish:**
```typescript
await this.streamService.publish('payment.confirmed', { paymentId: '123', amount: 500 });
await this.streamService.publishBatch('payment.confirmed', events);
```

**Consume** by extending `BaseStreamConsumer`:
```typescript
@Injectable()
export class PaymentConsumer extends BaseStreamConsumer {
  protected streamName = 'payment.confirmed';
  protected groupName = 'billing-service';
  protected consumerName = 'billing-1';
  protected concurrency = 3;

  async handleMessage(id: string, data: StreamMap['payment.confirmed']) {
    // Process message — auto-acknowledged on success
  }

  async handleDeadLetter(id: string, data: any) {
    // Handle poison messages after max retries
  }
}
```

Features: consumer groups, auto-acknowledgement, stale message claiming (crashed consumer recovery), dead letter streams, replay from timestamp, processing locks.

---

### Cron Jobs

Distributed cron with Redis locking, timeout enforcement, and monitoring.

**Register a cron job:**
```typescript
@Injectable()
export class CleanupService implements OnModuleInit {
  constructor(private cronService: CronService) {}

  onModuleInit() {
    this.cronService.register(
      {
        name: 'cleanup-expired-tokens',
        expression: CronExpression.EVERY_DAY_AT_MIDNIGHT,
        timeoutMs: 30000,
        runOnInit: false,
      },
      async () => {
        await this.db.token.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      },
    );
  }
}
```

**Pre-defined expressions** (`CronExpression` enum):
- `EVERY_SECOND`, `EVERY_5_SECONDS`, `EVERY_10_SECONDS`, `EVERY_30_SECONDS`
- `EVERY_MINUTE`, `EVERY_5_MINUTES`, `EVERY_15_MINUTES`, `EVERY_30_MINUTES`
- `EVERY_HOUR`, `EVERY_DAY_AT_MIDNIGHT`, `EVERY_DAY_AT_NOON`
- `EVERY_MONDAY`, `EVERY_WEEKDAY`, `EVERY_WEEKEND`
- `FIRST_DAY_OF_MONTH`, `QUARTERLY`, `EVERY_YEAR`

Features: distributed lock (only one instance runs per cluster), timeout abort, MongoDB logging, consecutive failure alerting via events.

---

### Email

Queue-based email sending with Handlebars templates.

**Send templated email:**
```typescript
await this.emailService.send({
  to: 'user@example.com',
  subject: 'Welcome!',
  template: 'welcome',
  context: { firstName: 'John' },
});
```

**Send bulk:**
```typescript
await this.emailService.sendBulk({
  recipients: [
    { to: 'a@b.com', context: { firstName: 'Alice' } },
    { to: 'c@d.com', context: { firstName: 'Bob' } },
  ],
  subject: 'Newsletter',
  template: 'newsletter',
});
```

**Templates** live in `templates/email/`:
- `layout.hbs` — Base HTML layout (auto-wraps all templates)
- `welcome.hbs` — Example welcome email
- `password-reset.hbs` — Example password reset with button

Create new templates as `.hbs` files. Available layout variables: `{{appName}}`, `{{year}}`, `{{{body}}}`.

**Email preview** (development): `GET /api/admin/email/preview/welcome?firstName=John`

Features: async queue processing, rate limiting (10/sec), 3 retries with backoff, attachment support, SMTP provider.

---

### File Upload (Local + S3)

Configurable file upload with local filesystem or AWS S3 storage.

**Endpoints:**
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/upload` | Upload single file |
| `POST` | `/api/upload/multiple` | Upload up to 10 files |
| `POST` | `/api/upload/presigned` | Get presigned upload URL (S3) |
| `GET` | `/api/upload/signed-url/:key` | Get presigned download URL (S3) |
| `DELETE` | `/api/upload/:key` | Delete a file |

**Programmatic usage:**
```typescript
const result = await this.uploadService.uploadFile(file, 'avatars', userId);
// { url, key, originalName, mimeType, size }

const presignedUrl = await this.uploadService.getPresignedUploadUrl('report.pdf', 'application/pdf');
```

Features: MIME type validation, file size limits, path traversal prevention, filename sanitization, presigned URLs (up to 7 days), folder organization.

---

### WebSockets (Socket.IO)

Real-time communication with Redis adapter for multi-server deployments.

**Server-side emission:**
```typescript
this.wsService.emitToUser(userId, 'notification.new', { message: 'Hello' });
this.wsService.emitToRole('admin', 'admin.alert', { ... });
this.wsService.emitToRoom('custom:chat-room-1', 'message', { ... });
this.wsService.broadcast('announcement', { ... });
```

**Connection tracking:**
```typescript
const count = await this.wsService.getOnlineUserCount();
const isOnline = await this.wsService.isUserOnline(userId);
```

**Client connection:** Clients connect with JWT token as auth:
```javascript
const socket = io('http://localhost:3000', {
  auth: { token: 'your-jwt-token' },
});
```

Features: JWT authentication on connect, max 5 connections per user, rate limiting (50 msgs/10s), auto-join user/role/org rooms, Redis adapter (multi-server), graceful shutdown notification.

---

### Webhooks

Secure webhook ingestion with signature verification and idempotency.

**Endpoint:** `POST /api/webhooks/:provider`

**Configuration via environment:**
```bash
# Auto-registered Paystack provider
PAYSTACK_WEBHOOK_SECRET=your-secret

# Custom providers (JSON array)
WEBHOOK_PROVIDERS='[{"name":"stripe","secret":"whsec_xxx","signatureHeader":"stripe-signature","algorithm":"sha256"}]'
```

**Listen to webhook events:**
```typescript
@OnEvent('webhook.paystack.charge.success')
handlePayment(payload: { provider, eventType, data, receivedAt }) {
  // Process payment notification
}
```

Features: HMAC signature verification (timing-safe), idempotency (24h dedup via Redis), event type extraction, fires typed events.

---

### Health Checks

Kubernetes-ready health check endpoints (public, no auth required):

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `GET /api/health` | Full health | DB, Redis, MongoDB, Queues, Memory, Disk |
| `GET /api/health/live` | Liveness probe | Process alive |
| `GET /api/health/ready` | Readiness probe | DB + Redis connectivity |

---

### Logging (MongoDB)

Structured observability logging with buffered writes to MongoDB. **Automatically disabled if `MONGO_LOG_URI` is not set.**

**What's logged:**
- **Request logs** — Method, URL, status, duration, user, request ID, response size
- **Query logs** — SQL, parameters (redacted), duration, operation type
- **App logs** — Structured service-level logs with context
- **Cron logs** — Job execution history, duration, success/failure
- **Aggregated stats** — Per-endpoint and per-query performance summaries

**AppLoggerService** for service-level logging:
```typescript
this.logger.info('User registered', 'AuthService', { userId: '123' });
this.logger.error('Payment failed', 'PaymentService', { orderId }, error);
```

Features: buffered writes (5s flush), TTL-based auto-expiry, sensitive field redaction, sampling rates for high-traffic endpoints, admin write auditing.

---

## Common Utilities

### Decorators

| Decorator | Description |
|-----------|-------------|
| `@Public()` | Bypass JWT authentication |
| `@CurrentUser()` | Extract user from JWT (`@CurrentUser('sub')` for specific field) |
| `@Roles('admin', 'user')` | Require specific roles |
| `@Idempotent(ttlSeconds?)` | Require `x-idempotency-key` header, cache response |
| `@VersionedController('v1', 'users')` | Version-prefixed controller |
| `@ApiPaginatedResponse(dto)` | Swagger pagination docs |
| `@AdminMonitoringController()` | Admin-only class with rate limiting |
| `@AdminMonitoringWrite()` | Admin write with audit logging |

### Guards

| Guard | Description |
|-------|-------------|
| `JwtAuthGuard` | Global JWT authentication (respects `@Public()`) |
| `RolesGuard` | Role-based access control |
| `DistributedThrottleGuard` | Redis-backed rate limiting with presets |
| `IdempotencyGuard` | Redis-backed duplicate request prevention |

**Rate limit presets:**
```typescript
@Throttle(60, 60)          // Custom: 60 requests per 60 seconds
@ThrottleStrict()          // 10 req/min
@ThrottleVeryStrict()      // 5 req/min
@ThrottleRelaxed()         // 200 req/min
@ThrottleBurst()           // 5 req/sec
```

### Interceptors

| Interceptor | Description |
|-------------|-------------|
| `ResponseInterceptor` | Wraps responses in `{ success, message, data, meta }` |
| `AuditContextInterceptor` | Attaches `auditUserId` to request |
| `RequestLoggerInterceptor` | Logs request/response to MongoDB |
| `TimeoutInterceptor` | 30-second request timeout |
| `AdminWriteAuditInterceptor` | Logs admin write actions |

### Pipes

| Pipe | Description |
|------|-------------|
| `SanitizePipe` | Strips HTML tags, null bytes, event handlers from strings |
| `ParseIntOrDefaultPipe` | Parse integer with fallback default |

### Services

**BaseCrudService** — Generic CRUD for any Prisma model:
```typescript
@Injectable()
export class UserService extends BaseCrudService {
  constructor(prisma: PrismaService) {
    super(prisma, 'user', {
      softDelete: true,
      searchFields: ['name', 'email'],
      defaultSelect: { id: true, name: true, email: true },
      allowedSortFields: ['name', 'createdAt'],
    });
  }
}
```

**GracefulShutdownService** — Register cleanup hooks:
```typescript
this.shutdownService.register('redis', () => this.redis.quit());
```

**ErrorReporterService** — Sentry integration (auto-configured if `SENTRY_DSN` set).

### Utilities

| Utility | Description |
|---------|-------------|
| `retry(fn, options)` | Retry with exponential backoff |
| `CircuitBreaker` | Circuit breaker for external service calls |
| `hashPassword(password)` | bcrypt hash |
| `comparePassword(plain, hash)` | bcrypt compare |
| `generateId()` | UUID generation |
| `generateCode(length)` | Alphanumeric code |
| `generateOtp(length)` | Numeric OTP |
| `paginate(total, page, limit)` | Pagination metadata |

**CircuitBreaker example:**
```typescript
const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 60000 });
const result = await breaker.exec(() => this.httpService.get(url));
```

---

## API Standards

All API responses follow a consistent format:

**Success:**
```json
{
  "success": true,
  "message": "Operation successful",
  "data": { ... }
}
```

**Paginated:**
```json
{
  "success": true,
  "data": [...],
  "meta": {
    "total": 100,
    "page": 1,
    "limit": 20,
    "totalPages": 5,
    "hasNextPage": true,
    "hasPreviousPage": false
  }
}
```

**Error:**
```json
{
  "success": false,
  "statusCode": 400,
  "message": "Validation failed",
  "errors": ["email must be an email"],
  "requestId": "abc-123",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Pagination query params:** `?page=1&limit=20&sortBy=createdAt&sortOrder=desc`

---

## Security

NestBoot includes multiple security layers out of the box:

- **Helmet** — HTTP security headers
- **CORS** — Configurable origin whitelist
- **Rate Limiting** — Redis-backed distributed throttling (fails open)
- **Input Sanitization** — HTML stripping, null byte removal, XSS prevention
- **Validation** — Whitelist-only DTO validation (unknown fields rejected)
- **JWT Authentication** — Short-lived access tokens + refresh tokens
- **Idempotency** — Prevents duplicate operations via `x-idempotency-key`
- **Webhook Verification** — HMAC signature validation (timing-safe)
- **Upload Security** — MIME validation, path traversal prevention, size limits
- **Sensitive Data Redaction** — Passwords, tokens, SSNs auto-redacted in logs
- **Non-root Docker** — Production container runs as unprivileged user

---

## Docker

### Development (infrastructure only)

```bash
npm run docker:up    # Start PostgreSQL, Redis, MongoDB
npm run docker:down  # Stop all containers
```

### Production (full stack)

```bash
docker compose up -d
```

The `docker-compose.yml` includes:
- **app** — NestBoot application (Node 22 Alpine, 512MB limit)
- **postgres** — PostgreSQL 16 Alpine with health checks
- **redis** — Redis 7 Alpine (128MB, LRU eviction)
- **mongo** — MongoDB 7 for logging

The `Dockerfile` uses multi-stage builds:
1. **Builder** — Installs deps, generates Prisma, compiles TypeScript, prunes devDeps
2. **Runner** — Minimal Alpine image, non-root user, health check included

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run start:dev` | Development with hot reload |
| `npm run start:debug` | Development with debugger |
| `npm run start:prod` | Production (compiled JS) |
| `npm run build` | Compile TypeScript |
| `npm run lint` | ESLint with auto-fix |
| `npm run format` | Prettier formatting |
| `npm run test` | Unit tests |
| `npm run test:watch` | Tests in watch mode |
| `npm run test:cov` | Tests with coverage report |
| `npm run test:e2e` | End-to-end tests |
| `npm run prisma:generate` | Generate Prisma client |
| `npm run prisma:migrate` | Run database migrations |
| `npm run prisma:studio` | Visual database browser |
| `npm run docker:up` | Start Docker infrastructure |
| `npm run docker:down` | Stop Docker infrastructure |

---

## Adding Your Own Modules

Place domain modules in `src/modules/`. Use the NestJS CLI to scaffold:

```bash
nest generate module modules/users
nest generate service modules/users
nest generate controller modules/users
```

Then import the module in `app.module.ts`:

```typescript
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    // ... existing imports
    UsersModule,
  ],
})
export class AppModule {}
```

**Leveraging the scaffold in your module:**

```typescript
import { Injectable } from '@nestjs/common';
import { BaseCrudService } from '../common/services';
import { PrismaService } from '../database';
import { CacheService } from '../infrastructure/cache';
import { EventService } from '../infrastructure/events';
import { QueueService } from '../infrastructure/queue';
import { AppLoggerService } from '../infrastructure/logging/services';

@Injectable()
export class UsersService extends BaseCrudService {
  constructor(
    prisma: PrismaService,
    private cache: CacheService,
    private events: EventService,
    private queue: QueueService,
    private logger: AppLoggerService,
  ) {
    super(prisma, 'user', {
      softDelete: true,
      searchFields: ['name', 'email'],
    });
  }

  async createUser(data: CreateUserDto) {
    const user = await this.create(data);

    // Cache the new user
    await this.cache.set('users', `user:${user.id}`, user, 3600);

    // Emit event for other services
    this.events.emit('user.created', { userId: user.id, email: user.email });

    // Queue welcome email
    await this.queue.addJob('email', 'send-template', {
      to: user.email,
      template: 'welcome',
      context: { firstName: user.name },
    });

    this.logger.info('User created', 'UsersService', { userId: user.id });
    return user;
  }
}
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | NestJS 11 |
| Language | TypeScript 5 (strict mode) |
| Database | PostgreSQL 16 + Prisma 7 |
| Cache / Queues / Streams | Redis 7 + ioredis + BullMQ |
| Logging Store | MongoDB 7 + Mongoose |
| Real-time | Socket.IO + Redis Adapter |
| Email | Nodemailer + Handlebars |
| Auth | Passport JWT |
| Uploads | Multer + AWS SDK v3 |
| Docs | Swagger / OpenAPI |
| Testing | Jest 30 + Supertest |
| Runtime | Node.js >= 22 |
