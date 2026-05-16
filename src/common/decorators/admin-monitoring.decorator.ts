import { applyDecorators, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import {
  JwtAuthGuard,
  RolesGuard,
  Throttle,
  ThrottleVeryStrict,
} from '../guards';
import { AdminWriteAuditInterceptor } from '../interceptors';
import { Roles } from './roles.decorator';

export const ADMIN_MONITORING_READ_ROLES = [
  'admin',
  'ops',
  'ops_admin',
  'support_admin',
  'super_admin',
];

export const ADMIN_MONITORING_WRITE_ROLES = [
  'admin',
  'ops_admin',
  'super_admin',
];

export function AdminMonitoringController(): ClassDecorator {
  return applyDecorators(
    ApiBearerAuth(),
    ApiExcludeController(process.env.NODE_ENV === 'production'),
    UseGuards(JwtAuthGuard, RolesGuard),
    Roles(...ADMIN_MONITORING_READ_ROLES),
    Throttle(30, 60),
  );
}

export function AdminMonitoringWrite(): MethodDecorator {
  return applyDecorators(
    Roles(...ADMIN_MONITORING_WRITE_ROLES),
    ThrottleVeryStrict(),
    UseInterceptors(AdminWriteAuditInterceptor),
  );
}
