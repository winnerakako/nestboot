import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import { AdminMonitoringController } from '../../common/decorators';
import { WebSocketService } from './websocket.service';

@ApiTags('Admin / WebSocket')
@AdminMonitoringController()
@Controller('admin/websocket')
export class WebSocketController {
  constructor(private readonly ws: WebSocketService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get WebSocket connection stats' })
  async getStats() {
    return {
      data: {
        onlineUsers: await this.ws.getOnlineUserCount(),
        totalConnections: await this.ws.getTotalConnectionCount(),
      },
    };
  }

  @Get('users')
  @ApiOperation({ summary: 'Get list of online user IDs' })
  @ApiQuery({ name: 'limit', required: false })
  async getOnlineUsers(@Query('limit') limit = '100') {
    const userIds = await this.ws.getOnlineUserIds();
    const safeLimit = Math.min(1000, Math.max(1, parseInt(limit, 10) || 100));

    return {
      data: userIds.slice(0, safeLimit),
      meta: { total: userIds.length, limit: safeLimit },
    };
  }

  @Get('users/:userId')
  @ApiOperation({
    summary: 'Check if a user is online and their connection count',
  })
  async getUserStatus(@Param('userId') userId: string) {
    return {
      data: {
        userId,
        isOnline: await this.ws.isUserOnline(userId),
        connections: await this.ws.getUserConnectionCount(userId),
      },
    };
  }
}
