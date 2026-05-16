import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import {
  ADMIN_MONITORING_READ_ROLES,
  ADMIN_MONITORING_WRITE_ROLES,
  AdminMonitoringController,
  AdminMonitoringWrite,
} from './admin-monitoring.decorator';
import { ROLES_KEY } from './roles.decorator';
import { THROTTLE_KEY } from '../guards';
import { AdminWriteAuditInterceptor } from '../interceptors';

@AdminMonitoringController()
class TestAdminController {
  @AdminMonitoringWrite()
  writeAction() {
    return undefined;
  }
}

describe('admin monitoring decorators', () => {
  it('protects admin monitoring controllers with read roles and a strict read limit', () => {
    expect(Reflect.getMetadata(ROLES_KEY, TestAdminController)).toEqual(
      ADMIN_MONITORING_READ_ROLES,
    );
    expect(Reflect.getMetadata(THROTTLE_KEY, TestAdminController)).toEqual({
      limit: 30,
      windowSeconds: 60,
    });
  });

  it('restricts write actions further and attaches write audit logging', () => {
    const handler = Object.getOwnPropertyDescriptor(
      TestAdminController.prototype,
      'writeAction',
    )?.value as () => undefined;

    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(
      ADMIN_MONITORING_WRITE_ROLES,
    );
    expect(Reflect.getMetadata(THROTTLE_KEY, handler)).toEqual({
      limit: 5,
      windowSeconds: 60,
    });
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handler)).toContain(
      AdminWriteAuditInterceptor,
    );
  });
});
