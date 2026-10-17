import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: (origin: string, callback: (err: Error | null, allow?: boolean) => void) => {
      callback(null, true);
    },
    credentials: true,
  },
  transports: ['polling', 'websocket'],
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        (client.handshake.query?.token as string) ||
        client.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn(`Client connected without token: ${client.id}`);
        return;
      }

      const secret = process.env.JWT_SECRET as string;
      const decoded = jwt.verify(token, secret) as { sub: string; email: string };
      client.data.userId = decoded.sub;

      client.join(`user:${decoded.sub}`);
      this.logger.log(`Client authenticated: ${client.id} for user: ${decoded.sub}`);
    } catch (err) {
      this.logger.error(`WebSocket authentication failed: ${err.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join_account')
  handleJoinAccount(client: Socket, payload: { whatsappAccountId?: string; accountId?: string }) {
    const targetAccountId = payload?.whatsappAccountId || payload?.accountId;
    if (targetAccountId) {
      client.join(`account:${targetAccountId}`);
      this.logger.log(`Client ${client.id} joined account room: ${targetAccountId}`);
    }
  }

  sendToUser(userId: string, event: string, data: any) {
    if (this.server) {
      this.server.to(`user:${userId}`).emit(event, data);
    }
  }

  sendToAccount(whatsappAccountId: string, event: string, data: any) {
    if (this.server) {
      this.server.to(`account:${whatsappAccountId}`).emit(event, data);
    }
  }

  broadcast(event: string, data: any) {
    if (this.server) {
      this.server.emit(event, data);
    }
  }
}
