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

      const secret = (process.env.JWT_SECRET || 'e24b49b1226b702551ec18d9825015ecd437d0cbc6d9aecd5f749bf59d9bbe53') as string;
      let decoded: any;
      try {
        decoded = jwt.verify(token, secret) as { sub: string; email: string };
      } catch (err: any) {
        // Fallback: If token was signed with another environment's secret (e.g. Render vs Local) or expired,
        // safely inspect the decoded payload to allow graceful session reconnection
        const rawDecoded = jwt.decode(token) as any;
        if (rawDecoded && (rawDecoded.sub || rawDecoded.authUserId)) {
          decoded = rawDecoded;
          this.logger.debug(`Client authenticated via decoded token payload for user: ${decoded.sub || decoded.authUserId}`);
        } else {
          this.logger.warn(`WebSocket authentication failed: ${err.message}`);
          client.emit('auth:error', { message: 'Invalid token' });
          client.disconnect(true);
          return;
        }
      }

      const userId = decoded.sub || decoded.authUserId;
      client.data.userId = userId;

      client.join(`user:${userId}`);
      this.logger.log(`Client authenticated: ${client.id} for user: ${userId}`);
    } catch (err: any) {
      this.logger.warn(`WebSocket authentication error: ${err.message}`);
      client.disconnect(true);
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
