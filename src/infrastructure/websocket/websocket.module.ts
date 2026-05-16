import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppGateway } from './app.gateway';
import { WebSocketService } from './websocket.service';
import { WebSocketController } from './websocket.controller';

@Module({
  imports: [JwtModule.register({})],
  controllers: [WebSocketController],
  providers: [AppGateway, WebSocketService],
  exports: [WebSocketService],
})
export class WebsocketModule {}
