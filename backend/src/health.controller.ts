import { Controller, Get } from '@nestjs/common';

/** Answers instantly without touching the database. Point a free uptime monitor at it so the host never falls asleep. */
@Controller('health')
export class HealthController {
  @Get()
  ping() {
    return { ok: true, at: new Date().toISOString() };
  }
}
