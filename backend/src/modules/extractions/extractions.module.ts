import { Module } from '@nestjs/common';
import { ExtractionsService } from './extractions.service';
import { ExtractionsController } from './extractions.controller';
import { AIModule } from '../ai/ai.module';

@Module({
  imports: [AIModule],
  controllers: [ExtractionsController],
  providers: [ExtractionsService],
  exports: [ExtractionsService],
})
export class ExtractionsModule {}
