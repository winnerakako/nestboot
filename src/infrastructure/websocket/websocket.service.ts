import { Injectable, Logger } from '@nestjs/common';
import { AppGateway } from './app.gateway';

@Injectable()
export class WebSocketService {
  private readonly logger = new Logger(WebSocketService.name);

  constructor(private readonly gateway: AppGateway) {}

  // ─── Emit Helpers ──────────────────────────────────────

  emitToUser(userId: string, event: string, payload: any): void {
    if (!this.isServerReady()) return;
    this.gateway.server.to(`user:${userId}`).emit(event, payload);
  }

  emitToRole(role: string, event: string, payload: any): void {
    if (!this.isServerReady()) return;
    this.gateway.server.to(`role:${role}`).emit(event, payload);
  }

  emitToOrg(orgId: string, event: string, payload: any): void {
    if (!this.isServerReady()) return;
    this.gateway.server.to(`org:${orgId}`).emit(event, payload);
  }

  emitToRoom(room: string, event: string, payload: any): void {
    if (!this.isServerReady()) return;
    this.gateway.server.to(`custom:${room}`).emit(event, payload);
  }

  broadcast(event: string, payload: any): void {
    if (!this.isServerReady()) return;
    this.gateway.server.emit(event, payload);
  }

  // ─── Connection Stats ──────────────────────────────────

  getOnlineUserCount(): Promise<number> {
    return this.gateway.getOnlineUserCount();
  }

  getTotalConnectionCount(): Promise<number> {
    return this.gateway.getTotalConnectionCount();
  }

  getOnlineUserIds(): Promise<string[]> {
    return this.gateway.getOnlineUserIds();
  }

  isUserOnline(userId: string): Promise<boolean> {
    return this.gateway.isUserOnline(userId);
  }

  getUserConnectionCount(userId: string): Promise<number> {
    return this.gateway.getUserConnectionCount(userId);
  }

  // ─── Internal ──────────────────────────────────────────

  private isServerReady(): boolean {
    if (!this.gateway.server) {
      this.logger.warn('WebSocket server not yet initialized — event dropped');
      return false;
    }
    return true;
  }

  /**
   * Check if the WebSocket Redis adapter is functioning.
   * Returns true in single-server mode (no adapter needed) or if adapter is connected.
   */
  isAdapterHealthy = (): boolean => {
    if (!this.gateway.server) return false;

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const adapter = this.gateway.server.adapter as any;
    // If using Redis adapter, check pub/sub client status
    if (adapter?.pubClient && adapter?.subClient) {
      return (
        adapter.pubClient.status === 'ready' &&
        adapter.subClient.status === 'ready'
      );
    }

    // In-memory adapter (single server) — always healthy
    return true;
  };
}
