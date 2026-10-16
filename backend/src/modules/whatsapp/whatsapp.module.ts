import { Module } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { BaileysAdapter } from './adapters/baileys.adapter';
import { WhatsAppEventService } from './whatsapp-event.service';
import { AIModule } from '../ai/ai.module';
import { ContactsModule } from '../contacts/contacts.module';
import { ChatTitleService } from '../chats/chat-title.service';

@Module({
  imports: [AIModule, ContactsModule],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, BaileysAdapter, WhatsAppEventService, ChatTitleService],
  exports: [WhatsAppService, BaileysAdapter, WhatsAppEventService],
})
export class WhatsAppModule {}
