import { Module } from '@nestjs/common';
import { AIService } from './ai.service';
import { AIController } from './ai.controller';
import { AIQueueService } from './ai-queue.service';
import { AIChangeStreamService } from './ai-change-stream.service';
import { MorningBriefingService } from './morning-briefing.service';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [GatewayModule],
  controllers: [AIController],
  providers: [AIService, AIQueueService, AIChangeStreamService, MorningBriefingService],
  exports: [AIService, AIQueueService, AIChangeStreamService, MorningBriefingService],
})
export class AIModule {}
