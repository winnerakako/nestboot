import {
  Controller,
  Get,
  Post,
  Delete,
  BadRequestException,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import {
  AdminMonitoringController,
  AdminMonitoringWrite,
} from '../../common/decorators';
import { StreamService } from './stream.service';

@ApiTags('Admin / Streams')
@AdminMonitoringController()
@Controller('admin/streams')
export class StreamController {
  constructor(private readonly streamService: StreamService) {}

  // ─── Stream Stats ──────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'Get stats for all streams (length, groups, lag)' })
  async getAllStats() {
    const stats = await this.streamService.getAllStreamStats();
    return { data: stats };
  }

  @Get('groups')
  @ApiOperation({
    summary: 'Get all consumer groups across all streams sorted by lag',
  })
  async getConsumerGroupSummary() {
    const summary = await this.streamService.getConsumerGroupSummary();
    return { data: summary };
  }

  @Get(':stream')
  @ApiOperation({
    summary: 'Get stats for a specific stream (length, groups, pending, lag)',
  })
  async getStreamStats(@Param('stream') stream: string) {
    const stats = await this.streamService.getStreamStats(stream);
    if (!stats) return { data: null, message: 'Stream not found' };
    return { data: stats };
  }

  // ─── Pending / Dead Letter ─────────────────────────────

  @Get(':stream/groups/:group/pending')
  @ApiOperation({
    summary: 'Get pending (unacknowledged) messages for a consumer group',
  })
  async getPending(
    @Param('stream') stream: string,
    @Param('group') group: string,
  ) {
    const pending = await this.streamService.getPending(stream, group);
    return { data: pending };
  }

  @Get(':stream/groups/:group/pending/details')
  @ApiOperation({
    summary: 'Get detailed pending messages with delivery count',
  })
  @ApiQuery({ name: 'count', required: false })
  async getPendingDetails(
    @Param('stream') stream: string,
    @Param('group') group: string,
    @Query('count') count = '20',
  ) {
    const safeCount = Math.min(100, Math.max(1, parseInt(count, 10) || 20));
    const details = await this.streamService.getPendingDetails(
      stream,
      group,
      0,
      safeCount,
    );
    return { data: details };
  }

  @Get(':stream/groups/:group/dead-letters')
  @ApiOperation({ summary: 'Get dead lettered messages for a consumer group' })
  @ApiQuery({ name: 'count', required: false })
  async getDeadLetters(
    @Param('stream') stream: string,
    @Param('group') group: string,
    @Query('count') count = '50',
  ) {
    const safeCount = Math.min(200, Math.max(1, parseInt(count, 10) || 50));
    const deadLetters = await this.streamService.getDeadLetters(
      stream,
      group,
      safeCount,
    );
    return { data: deadLetters, meta: { count: deadLetters.length } };
  }

  // ─── Consumer Group Management ─────────────────────────

  @Post(':stream/groups/:group/reset')
  @HttpCode(HttpStatus.OK)
  @AdminMonitoringWrite()
  @ApiOperation({
    summary: 'Reset a consumer group to reprocess from a specific point',
  })
  async resetConsumerGroup(
    @Param('stream') stream: string,
    @Param('group') group: string,
    @Body() body: { fromId?: string },
  ) {
    await this.streamService.resetConsumerGroup(
      stream,
      group,
      body.fromId || '0',
    );
    return {
      success: true,
      message: `Consumer group ${group} on ${stream} reset to ${body.fromId || '0'}`,
    };
  }

  // ─── Replay ────────────────────────────────────────────

  @Get(':stream/replay')
  @ApiOperation({ summary: 'Replay messages from a stream' })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'Start ID or 0 for beginning',
  })
  @ApiQuery({
    name: 'fromTimestamp',
    required: false,
    description: 'ISO date to replay from',
  })
  @ApiQuery({ name: 'count', required: false })
  async replay(
    @Param('stream') stream: string,
    @Query('from') from?: string,
    @Query('fromTimestamp') fromTimestamp?: string,
    @Query('count') count = '100',
  ) {
    const safeCount = Math.min(1000, Math.max(1, parseInt(count, 10) || 100));

    if (fromTimestamp) {
      const date = new Date(fromTimestamp);
      if (Number.isNaN(date.getTime())) {
        throw new BadRequestException('fromTimestamp must be a valid date');
      }

      const messages = await this.streamService.replayFromTimestamp(
        stream,
        date,
        safeCount,
      );
      return { data: messages, meta: { count: messages.length } };
    }

    const messages = await this.streamService.replay(
      stream,
      from || '0',
      safeCount,
    );
    return { data: messages, meta: { count: messages.length } };
  }

  // ─── Stream Management ─────────────────────────────────

  @Post(':stream/trim')
  @HttpCode(HttpStatus.OK)
  @AdminMonitoringWrite()
  @ApiOperation({ summary: 'Trim a stream to a maximum length' })
  async trim(
    @Param('stream') stream: string,
    @Body() body: { maxLen: number },
  ) {
    const maxLen = Number(body.maxLen);
    if (!Number.isInteger(maxLen) || maxLen < 1) {
      throw new BadRequestException('maxLen must be a positive integer');
    }

    const trimmed = await this.streamService.trim(stream, maxLen);
    return {
      success: true,
      message: `Trimmed ${trimmed} entries from ${stream}`,
    };
  }

  @Delete(':stream')
  @AdminMonitoringWrite()
  @ApiOperation({ summary: 'Delete a stream entirely' })
  async deleteStream(@Param('stream') stream: string) {
    await this.streamService.deleteStream(stream);
    return { success: true, message: `Stream ${stream} deleted` };
  }

  @Delete(':stream/groups/:group/consumers/:consumer')
  @AdminMonitoringWrite()
  @ApiOperation({ summary: 'Remove a consumer from a group' })
  async deleteConsumer(
    @Param('stream') stream: string,
    @Param('group') group: string,
    @Param('consumer') consumer: string,
  ) {
    const pending = await this.streamService.deleteConsumer(
      stream,
      group,
      consumer,
    );
    return {
      success: true,
      message: `Consumer ${consumer} removed from ${group} (${pending} pending messages released)`,
    };
  }
}
