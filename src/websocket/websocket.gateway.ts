import { Logger } from "@nestjs/common";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { env } from "../config/env";

@WebSocketGateway({
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow: boolean) => void) => {
      if (!origin) {
        callback(null, env.nodeEnv !== "production");
        return;
      }

      const allowed = [
        env.frontendAppUrl,
        "http://localhost:4173",
        "https://fractalholding.com",
        "https://www.fractalholding.com",
        "https://www.talestead.com",
      ].filter(Boolean);

      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      const isAllowed = allowed.includes(origin) || (env.nodeEnv !== "production" && isLocal);

      callback(null, isAllowed);
    },
    credentials: true,
  },
  transports: ["websocket", "polling"],
})
export class WebsocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketGateway.name);
  private readonly userSockets = new Map<string, Set<string>>();

  constructor(private readonly jwtService: JwtService) {}

  afterInit() {
    this.logger.log("WebSocket gateway initialized");
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace("Bearer ", "");

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = await this.jwtService.verifyAsync<{ sub: string }>(token, {
        secret: env.jwtAccessSecret,
      });

      const userId = payload.sub;

      if (!userId) {
        client.disconnect();
        return;
      }

      client.data.userId = userId;
      client.join(`user:${userId}`);

      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(client.id);

      this.logger.debug(`Client connected: ${client.id} (user: ${userId})`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data?.userId;

    if (userId) {
      const sockets = this.userSockets.get(userId);

      if (sockets) {
        sockets.delete(client.id);

        if (sockets.size === 0) {
          this.userSockets.delete(userId);
        }
      }
    }

    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  getServer(): Server {
    return this.server;
  }

  isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId) && this.userSockets.get(userId)!.size > 0;
  }
}
