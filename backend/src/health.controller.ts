import { Controller, Get } from '@nestjs/common';

const startedAt = Date.now();

/**
 * Answers instantly without touching the database. Point a free uptime monitor at it so the host never falls asleep.
 * It also reports uptime and memory: an uptime that keeps resetting means the server is being restarted, and a
 * memory figure near the plan limit explains why.
 */
@Controller('health')
export class HealthController {
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
}
