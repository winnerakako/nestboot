import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TransactionHelper } from './transaction.helper';
import { BulkHelper } from './bulk.helper';

@Global()
@Module({
  providers: [PrismaService, TransactionHelper, BulkHelper],
  exports: [PrismaService, TransactionHelper, BulkHelper],
})
export class DatabaseModule {}
