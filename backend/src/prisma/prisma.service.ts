import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private heartbeatInterval: NodeJS.Timeout | null = null;

  /**
   * Adds pool settings to the connection string when it has none. The default pool is tiny, and with the
   * database far from the server every query waits its turn, which made syncing and screens crawl.
   */
  static buildUrl(url: string | undefined): string | undefined {
    if (!url) return url;
    const add: string[] = [];
    if (!/[?&]maxPoolSize=/i.test(url)) add.push(`maxPoolSize=${process.env.DB_MAX_POOL_SIZE || '25'}`);
    if (!/[?&]minPoolSize=/i.test(url)) add.push('minPoolSize=2');
    if (!/[?&]connectTimeoutMS=/i.test(url)) add.push('connectTimeoutMS=15000');
    if (add.length === 0) return url;
    return url + (url.includes('?') ? '&' : '?') + add.join('&');
  }

  constructor() {
    super({
      datasources: {
        db: {
          url: PrismaService.buildUrl(process.env.DATABASE_URL),
        },
      },
      log: ['warn', 'error'],
    });
  }

  async onModuleInit() {
    let retries = 5;
    while (retries > 0) {
      try {
        const start = Date.now();
        await this.$connect();
        const duration = ((Date.now() - start) / 1000).toFixed(1);
        this.logger.log(`Prisma connected to MongoDB database successfully in ${duration}s`);
        
        // Start keep-alive heartbeat
        this.startHeartbeat();
        break;
      } catch (err: any) {
        retries -= 1;
        this.logger.warn(
          `Prisma connection attempt failed (${err.message?.split('\n')[0] || err.message}). Retrying in 2s (${retries} retries left)...`
        );
        if (retries === 0) {
          this.logger.error('Initial connection retries exhausted. Background reconnect active.');
          this.startHeartbeat();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    // Ping MongoDB every 15 seconds to keep connection active
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.user.findFirst({ select: { id: true } });
      } catch (e: any) {
        this.logger.warn(`Heartbeat ping detected disconnected state: ${e.message?.split('\n')[0]}. Reconnecting...`);
        try {
          await this.$connect();
          this.logger.log('Prisma reconnected successfully via heartbeat');
        } catch {}
      }
    }, 15000);
  }

  async onModuleDestroy() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    await this.$disconnect();
  }
}
