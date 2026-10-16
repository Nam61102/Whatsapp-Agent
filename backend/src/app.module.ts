import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { AuthModule } from './modules/auth/auth.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { ChatsModule } from './modules/chats/chats.module';
import { MessagesModule } from './modules/messages/messages.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { AIModule } from './modules/ai/ai.module';
import { ExtractionsModule } from './modules/extractions/extractions.module';
import { SettingsModule } from './modules/settings/settings.module';
import { RetentionModule } from './modules/retention/retention.module';

@Module({
  imports: [
    PrismaModule,
    GatewayModule,
    AuthModule,
    WhatsAppModule,
    ChatsModule,
    MessagesModule,
    ContactsModule,
    AIModule,
    ExtractionsModule,
    SettingsModule,
    RetentionModule,
  ],
})
export class AppModule {}
