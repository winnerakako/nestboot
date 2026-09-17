import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '../config/index.js';
import { DbModule } from '../db/db.module.js';
import { RATE_LIMIT_STORE } from '../stores/stores.js';
import { CsrfProtection } from './csrf.js';
import { SecurityEvents } from './events/security-events.js';
import { OpsSessions } from './ops-auth/ops-sessions.service.js';
import { OpsUsers } from './ops-auth/ops-users.service.js';
import { RateLimitPolicies } from './rate-limit/policy.js';
import { RateLimitGuard } from './rate-limit/rate-limit.guard.js';
import { PostgresRateLimitStore } from './rate-limit/rate-limit.store.postgres.js';
import { IpSubjectResolver, RATE_LIMIT_RESOLVER } from './rate-limit/subject.js';

@Global()
@Module({
  imports: [ConfigModule, DbModule],
  providers: [
    SecurityEvents,
    CsrfProtection,
    OpsUsers,
    OpsSessions,
    RateLimitPolicies,
    PostgresRateLimitStore,
    { provide: RATE_LIMIT_STORE, useExisting: PostgresRateLimitStore },
    // The seam an app replaces to get per-user or per-org limits. Swapping this
    // one provider is the entire change; no page or guard is touched.
    { provide: RATE_LIMIT_RESOLVER, useClass: IpSubjectResolver },
    // Intentional: APP_GUARD here IS correct, unlike in the console module.
    // Rate limiting is genuinely global — an endpoint that opts out of it is a
    // denial-of-service hole, so it is applied to everything by default and
    // narrowed by policy rows rather than by decorators.
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [
    SecurityEvents,
    CsrfProtection,
    OpsUsers,
    OpsSessions,
    RateLimitPolicies,
    RATE_LIMIT_STORE,
    RATE_LIMIT_RESOLVER,
  ],
})
export class SecurityModule {}
