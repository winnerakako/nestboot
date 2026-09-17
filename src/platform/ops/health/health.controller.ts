import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { ConfigService } from '../../config/index.js';
import { PostgresErrorSink } from '../../errors/error-sink.postgres.js';
import { HealthService } from '../../health/health.service.js';
import { RawResponse } from '../../http/envelope.interceptor.js';
import { OpsLogStream } from '../../logging/ops-log-stream.js';
import { OPS_LOG_STREAM } from '../../logging/ops-log-stream.module.js';
import { RequestRecorder } from '../../requests/request-recorder.js';
import { SecurityEvents } from '../../security/events/security-events.js';
import { OpsGuard } from '../ops.guard.js';
import { OpsView } from '../view/ops-view.service.js';

/**
 * Health: the live checks, the resolved configuration, and — the part no other
 * monitoring tool can show — whether telemetry itself is keeping up.
 *
 * The writer statistics are the console reporting on its own instruments. A
 * non-zero `dropped` means the logs an operator is reading have gaps, and a
 * page that renders those logs without saying so is lying by omission.
 */
@UseGuards(OpsGuard)
@Controller('health')
export class OpsHealthController {
  constructor(
    private readonly health: HealthService,
    private readonly config: ConfigService,
    private readonly errorSink: PostgresErrorSink,
    private readonly requests: RequestRecorder,
    private readonly security: SecurityEvents,
    @Inject(OPS_LOG_STREAM) private readonly logStream: OpsLogStream | null,
    private readonly view: OpsView,
  ) {}

  @Get()
  @RawResponse()
  @Header('content-type', 'text/html; charset=utf-8')
  async index(): Promise<string> {
    const report = await this.health.report();

    const writers = [
      { name: 'ops.logs', stats: this.logStream?.stats() ?? null },
      { name: 'ops.requests', stats: this.requests.stats() },
      { name: 'ops.errors', stats: this.errorSink.stats() },
      { name: 'ops.security_events', stats: this.security.stats() },
    ].map((writer) => ({
      ...writer,
      // Disabled and broken are different states and must not render alike.
      disabled: writer.stats === null,
      lossy: (writer.stats?.dropped ?? 0) > 0 || (writer.stats?.failed ?? 0) > 0,
    }));

    const lossy = writers.filter((writer) => writer.lossy);

    return this.view.render(
      'health/index',
      {
        title: 'Health',
        degraded:
          lossy.length > 0
            ? `Telemetry is dropping rows (${lossy
                .map((w) => w.name)
                .join(', ')}). What the Logs, Requests and Errors tabs show is incomplete.`
            : undefined,
        report,
        writers,
        // Secrets are fingerprinted, never shown: enough to tell two
        // deployments apart and confirm a value changed, never enough to use.
        config: Object.entries(this.config.masked())
          .map(([key, value]) => ({ key, value: formatValue(value) }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      },
      'health',
    );
  }
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '(empty)';
  if (value === '' || value === undefined || value === null) return '(unset)';
  return String(value);
}
