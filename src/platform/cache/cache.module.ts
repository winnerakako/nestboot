import { Global, Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { CACHE_STORE } from '../stores/stores.js';
import { PostgresCacheStore } from './cache.postgres.js';

@Global()
@Module({
  imports: [DbModule],
  providers: [PostgresCacheStore, { provide: CACHE_STORE, useExisting: PostgresCacheStore }],
  exports: [CACHE_STORE, PostgresCacheStore],
})
export class CacheModule {}
