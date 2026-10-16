import { Module } from '@nestjs/common';
import { AIService } from './ai.service';
import { AIController } from './ai.controller';
import { AIQueueService } from './ai-queue.service';
import { AIChangeStreamService } from './ai-change-stream.service';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [GatewayModule],
  controllers: [AIController],
  providers: [AIService, AIQueueService, AIChangeStreamService],
  exports: [AIService, AIQueueService, AIChangeStreamService],
})
export class AIModule {}
