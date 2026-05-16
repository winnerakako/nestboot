import { Global, Module } from '@nestjs/common';
import { AdminWriteAuditInterceptor } from '../../common/interceptors';
import { LogConnectionService } from './services/log-connection.service';
import { LogBufferService } from './services/log-buffer.service';
import { AppLoggerService } from './services/app-logger.service';
import { RequestLoggerInterceptor } from './services/request-logger.interceptor';
import { QueryLoggerService } from './services/query-logger.service';
import { LogAggregationService } from './services/log-aggregation.service';
import { AdminLogController } from './controllers/admin-log.controller';

@Global()
@Module({
  controllers: [AdminLogController],
  providers: [
    LogConnectionService,
    LogBufferService,
    AppLoggerService,
    RequestLoggerInterceptor,
    QueryLoggerService,
    LogAggregationService,
    AdminWriteAuditInterceptor,
  ],
  exports: [
    AppLoggerService,
    RequestLoggerInterceptor,
    LogConnectionService,
    LogBufferService,
    AdminWriteAuditInterceptor,
  ],
})
export class LoggingModule {}
