import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import {
  AdminMonitoringController,
  AdminMonitoringWrite,
} from '../../common/decorators';
import { QueueService } from './queue.service';

@ApiTags('Admin / Queues')
@AdminMonitoringController()
@Controller('admin/queues')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  // ─── Queue Stats ───────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'Get stats for all registered queues' })
  async getAllStats() {
    const stats = await this.queueService.getAllStats();
    return { data: stats };
  }

  @Get(':name')
  @ApiOperation({ summary: 'Get stats for a specific queue' })
  async getQueueStats(@Param('name') name: string) {
    const stats = await this.queueService.getQueueStats(name);
    if (!stats) return { data: null, message: 'Queue not found' };
    return { data: stats };
  }

  // ─── Job Inspection ────────────────────────────────────

  @Get(':name/jobs/:jobId')
  @ApiOperation({
    summary: 'Get a specific job by ID (state, progress, result)',
  })
  async getJob(@Param('name') name: string, @Param('jobId') jobId: string) {
    const job = await this.queueService.getJob(name, jobId);
    if (!job) return { data: null, message: 'Job not found' };
    return { data: job };
  }

  @Get(':name/failed')
  @ApiOperation({ summary: 'Get failed jobs from a queue' })
  @ApiQuery({ name: 'start', required: false })
  @ApiQuery({ name: 'end', required: false })
  async getFailedJobs(
    @Param('name') name: string,
    @Query('start') start = '0',
    @Query('end') end?: string,
  ) {
    const s = Math.max(0, parseInt(start, 10) || 0);
    const parsedEnd = end === undefined ? s + 19 : parseInt(end, 10);
    const requestedEnd = Number.isFinite(parsedEnd) ? parsedEnd : s + 19;
    const e = Math.max(s, Math.min(s + 99, requestedEnd));

    const jobs = await this.queueService.getFailedJobs(name, s, e);
    return { data: jobs, meta: { start: s, end: e, count: jobs.length } };
  }

  // ─── Job Actions ───────────────────────────────────────

  @Post(':name/jobs/:jobId/retry')
  @HttpCode(HttpStatus.OK)
  @AdminMonitoringWrite()
  @ApiOperation({ summary: 'Retry a specific failed job' })
  async retryJob(@Param('name') name: string, @Param('jobId') jobId: string) {
    const success = await this.queueService.retryJob(name, jobId);
    if (!success) throw new NotFoundException('Job not found');
    return { data: null, message: `Job ${jobId} queued for retry` };
  }

  @Post(':name/retry-all')
  @HttpCode(HttpStatus.OK)
  @AdminMonitoringWrite()
  @ApiOperation({ summary: 'Retry all failed jobs in a queue' })
  async retryAllFailed(@Param('name') name: string) {
    const count = await this.queueService.retryAllFailed(name);
    return {
      data: { retried: count },
      message: `${count} jobs queued for retry`,
    };
  }

  @Delete(':name/jobs/:jobId')
  @AdminMonitoringWrite()
  @ApiOperation({ summary: 'Remove a specific job' })
  async removeJob(@Param('name') name: string, @Param('jobId') jobId: string) {
    const success = await this.queueService.removeJob(name, jobId);
    if (!success) throw new NotFoundException('Job not found');
    return { data: null, message: `Job ${jobId} removed` };
  }

  // ─── Queue Management ─────────────────────────────────

  @Post(':name/pause')
  @HttpCode(HttpStatus.OK)
  @AdminMonitoringWrite()
  @ApiOperation({
    summary: 'Pause a queue (stops processing, still accepts jobs)',
  })
  async pauseQueue(@Param('name') name: string) {
    const success = await this.queueService.pauseQueue(name);
    if (!success) throw new NotFoundException('Queue not found');
    return { data: null, message: `Queue ${name} paused` };
  }

  @Post(':name/resume')
  @HttpCode(HttpStatus.OK)
  @AdminMonitoringWrite()
  @ApiOperation({ summary: 'Resume a paused queue' })
  async resumeQueue(@Param('name') name: string) {
    const success = await this.queueService.resumeQueue(name);
    if (!success) throw new NotFoundException('Queue not found');
    return { data: null, message: `Queue ${name} resumed` };
  }

  @Post(':name/drain')
  @HttpCode(HttpStatus.OK)
  @AdminMonitoringWrite()
  @ApiOperation({ summary: 'Drain a queue (remove all waiting jobs)' })
  async drainQueue(@Param('name') name: string) {
    const success = await this.queueService.drainQueue(name);
    if (!success) throw new NotFoundException('Queue not found');
    return { data: null, message: `Queue ${name} drained` };
  }
}
