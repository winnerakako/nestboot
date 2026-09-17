import { Global, Module } from '@nestjs/common';
import { AppDb } from './app-db.service.js';
import { OpsDb } from './ops-db.service.js';

@Global()
@Module({
  providers: [AppDb, OpsDb],
  exports: [AppDb, OpsDb],
})
export class DbModule {}
