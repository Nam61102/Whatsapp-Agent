import { Controller, Get, Logger } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

const startedAt = Date.now();

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  ping() {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    return {
      ok: true,
      at: new Date().toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      memoryMB: { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external) },
    };
  }

  @Get('debug-db')
  async debugDb() {
    const rawUrl = process.env.DATABASE_URL || '';
    const safeUrl = rawUrl.replace(/:([^:@]+)@/, ':***@');
    try {
      const start = Date.now();
      await this.prisma.$connect();
      const userCount = await this.prisma.user.count();
      return {
        ok: true,
        databaseConnected: true,
        durationMs: Date.now() - start,
        userCount,
        databaseUrl: safeUrl,
      };
    } catch (err: any) {
      this.logger.error(`[debug-db] Connection error: ${err.message}`, err.stack);
      return {
        ok: false,
        databaseConnected: false,
        errorName: err.name,
        errorMessage: err.message,
        errorCode: err.code,
        databaseUrl: safeUrl,
      };
    }
  }
}
