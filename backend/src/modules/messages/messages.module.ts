import { Module } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { AIModule } from '../ai/ai.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [AIModule, WhatsAppModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
