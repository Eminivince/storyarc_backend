import { Injectable, Logger } from "@nestjs/common";
import { WebsocketGateway } from "./websocket.gateway";

@Injectable()
export class WebsocketService {
  private readonly logger = new Logger(WebsocketService.name);

  constructor(private readonly gateway: WebsocketGateway) {}

  emitToUser(userId: string, event: string, data: unknown) {
    const room = `user:${userId}`;
    this.gateway.getServer().to(room).emit(event, data);
    this.logger.debug(`Emitted ${event} to ${room}`);
  }

  emitToRoom(room: string, event: string, data: unknown) {
    this.gateway.getServer().to(room).emit(event, data);
  }

  broadcast(event: string, data: unknown) {
    this.gateway.getServer().emit(event, data);
  }

  isUserOnline(userId: string): boolean {
    return this.gateway.isUserOnline(userId);
  }
}
