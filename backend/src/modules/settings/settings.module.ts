import { Module, forwardRef } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { RetentionModule } from '../retention/retention.module';
import { AIModule } from '../ai/ai.module';

@Module({
  imports: [RetentionModule, forwardRef(() => AIModule)],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
