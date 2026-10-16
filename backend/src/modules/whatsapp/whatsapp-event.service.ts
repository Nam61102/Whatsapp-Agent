import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsGateway } from '../gateway/events.gateway';
import { AIService } from '../ai/ai.service';
import { AIQueueService } from '../ai/ai-queue.service';
import { ConnectionState } from './adapters/whatsapp-adapter.interface';
import { BaileysAdapter, unwrapMessage } from './adapters/baileys.adapter';
import { createHash } from 'crypto';
import { resolveDisplayName, isRawIdentifier, formatPhoneNumber } from '../../shared/name-resolver';
import { autoLinkAllLidConversations } from '../../shared/contact-resolver';
import { nextContactName } from '../../shared/contact-name-policy';
import { ChatTitleService } from '../chats/chat-title.service';

export interface SyncProgressState {
  userId: string;
  whatsappAccountId: string;
  status: 'IDLE' | 'CONNECTING' | 'SYNCING' | 'COMPLETED';
  currentStage:
    | 'IDLE'
    | 'CONNECTING'
    | 'CONTACTS'
    | 'GROUPS'
    | 'CONVERSATIONS'
    | 'MESSAGES'
    | 'AI_EXTRACTION'
    | 'AI_ANALYSIS'
    | 'COMPLETED';
  progress: number;
  message: string;
  contactsCount: number;
  groupsCount: number;
  chatsCount: number;
  messagesCount: number;
  aiExtractionCount: number;
  aiAnalysisCount: number;
  contacts: { total: number; processed: number; percentage: number };
  groups: { total: number; processed: number; percentage: number };
  conversations: { total: number; processed: number; percentage: number };
  messages: { total: number; processed: number; percentage: number };
  aiExtraction: { total: number; processed: number; percentage: number };
  aiAnalysis: { total: number; processed: number; percentage: number };
  canContinueToApp: boolean;
  startedAt?: Date;
  updatedAt?: Date;
  completedAt?: Date;
}

@Injectable()
export class WhatsAppEventService {
  private readonly logger = new Logger(WhatsAppEventService.name);
  private syncProgressMap = new Map<string, SyncProgressState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
    private readonly aiService: AIService,
    private readonly aiQueueService: AIQueueService,
    private readonly baileysAdapter: BaileysAdapter,
    private readonly chatTitles: ChatTitleService
  ) {}

  refreshChatTitles(userId: string, whatsappAccountId: string) {
    return this.storeChatTitles(userId, whatsappAccountId);
  }

  /** Stores titles for every chat already in the database (runs once at startup). */
  async backfillChatTitles() {
    const accounts = await this.prisma.whatsAppAccount.findMany({ select: { id: true, userId: true } });
    for (const acc of accounts) {
      await this.storeChatTitles(acc.userId, acc.id);
    }
  }

  private async storeChatTitles(userId: string, whatsappAccountId: string, externalChatIds?: string[]) {
    try {
      const updated = await this.chatTitles.refreshAccount(userId, whatsappAccountId, externalChatIds);
      if (updated > 0) this.eventsGateway.sendToUser(userId, 'chats:updated', { count: updated });
    } catch (err: any) {
      this.logger.warn(`Could not store chat titles: ${err.message}`);
    }
  }

  private isSelfJid(remoteJid: string, accountPhone: string | null): boolean {
    if (!remoteJid || !accountPhone) return false;
    const remoteDigits = remoteJid.split('@')[0].split(':')[0].replace(/\D/g, '');
    const accountDigits = accountPhone.replace(/\D/g, '');
    return Boolean(remoteDigits && accountDigits && remoteDigits === accountDigits);
  }

  private getSelfDisplayName(accountPhone: string | null): string {
    if (!accountPhone) return 'You';
    const digits = accountPhone.replace(/\D/g, '');
    const formatted = formatPhoneNumber(digits);
    return formatted ? `${formatted} (You)` : 'You';
  }

  async enrichChannelMetadata(
    userId: string,
    whatsappAccountId: string,
    conversationId: string,
    externalChatId: string
  ) {
    try {
      const meta = await this.baileysAdapter.getNewsletterMetadata(userId, externalChatId);
      if (meta?.title) {
        await this.prisma.conversation.update({
          where: { id: conversationId },
          data: {
            title: meta.title,
            ...(meta.avatarUrl ? { avatarUrl: meta.avatarUrl } : {}),
          },
        });
        await this.prisma.contact.updateMany({
          where: { whatsappAccountId, externalContactId: externalChatId },
          data: {
            displayName: meta.title,
            ...(meta.avatarUrl ? { profilePhotoUrl: meta.avatarUrl } : {}),
          },
        });
        this.eventsGateway.sendToUser(userId, 'conversation:updated', {
          id: conversationId,
          externalChatId,
          title: meta.title,
        });
      }
    } catch (err: any) {
      this.logger.debug(`Enrichment failed for channel ${externalChatId}: ${err.message}`);
    }
  }

  async runSessionBackfill(userId: string, whatsappAccountId: string) {
    this.logger.log(
      `[BACKFILL] Starting lightweight session backfill for user ${userId}, account ${whatsappAccountId}...`
    );

    const account = await this.prisma.whatsAppAccount.findUnique({
      where: { id: whatsappAccountId },
    });
    const accountPhone = account?.phoneNumber || null;
    const accountDigits = accountPhone ? accountPhone.replace(/\D/g, '') : null;

    // 1. Self Chat Backfill / Migration
    if (accountDigits) {
      const selfDisplayName = this.getSelfDisplayName(accountPhone);
      const existingConvs = await this.prisma.conversation.findMany({
        where: { whatsappAccountId },
      });

      const selfConv = existingConvs.find((c) => {
        const rawDigits = c.externalChatId.split('@')[0].split(':')[0].replace(/\D/g, '');
        return rawDigits === accountDigits;
      });

      if (selfConv) {
        await this.prisma.conversation.update({
          where: { id: selfConv.id },
          data: {
            chatType: 'SELF',
            isSelfChat: true,
            title: selfDisplayName,
          },
        });
        await this.prisma.contact.updateMany({
          where: { id: selfConv.contactId },
          data: { displayName: selfDisplayName },
        });
        this.logger.log(`[BACKFILL] Migrated self conversation ${selfConv.id} to chatType: SELF`);
      }
    }

    // 2. Channel Title Enrichment (FIX 2)
    const channelConvs = await this.prisma.conversation.findMany({
      where: {
        whatsappAccountId,
        chatType: 'CHANNEL',
        OR: [{ title: null }, { title: 'Unnamed Channel' }],
      },
    });

    if (channelConvs.length > 0) {
      this.logger.log(`[BACKFILL] Enriching ${channelConvs.length} channel titles asynchronously...`);
      for (let i = 0; i < channelConvs.length; i += 3) {
        const batch = channelConvs.slice(i, i + 3);
        await Promise.all(
          batch.map((conv) =>
            this.enrichChannelMetadata(userId, whatsappAccountId, conv.id, conv.externalChatId)
          )
        );
      }
    }

    // 3A. LID Backfill (FIX 3A)
    const contactsWithLid = await this.prisma.contact.findMany({
      where: {
        whatsappAccountId,
        lid: { not: null },
        phoneNumber: { not: null },
      },
    });

    let lidCount = 0;
    for (const c of contactsWithLid) {
      if (c.lid && c.phoneNumber) {
        const phoneJid = `${c.phoneNumber.replace(/\D/g, '')}@s.whatsapp.net`;
        await this.prisma.lIDMapping.upsert({
          where: {
            whatsappAccountId_lid: {
              whatsappAccountId,
              lid: c.lid,
            },
          },
          update: { phoneJid },
          create: {
            userId,
            whatsappAccountId,
            lid: c.lid,
            phoneJid,
          },
        });
        lidCount++;
      }
    }

    if (lidCount === 0) {
      this.logger.log('LID backfill: no historical mappings available from current session');
    } else {
      this.logger.log(`[BACKFILL] Populated ${lidCount} LID mappings from stored session contacts.`);
    }

    // Automatic contact & LID conversation linkage across all saved contacts
    const autoLinked = await autoLinkAllLidConversations(this.prisma, userId, whatsappAccountId);
    if (autoLinked > 0) {
      this.logger.log(`[BACKFILL] Auto-linked ${autoLinked} LID conversations to saved contacts for user ${userId}`);
    }

    // 3B. Group Participant Backfill - DISABLED to prevent 15,000+ unsaved contact/participant database bloat.
    // Group members are resolved on-demand when active group messages arrive.
    this.logger.log(`[BACKFILL] Skipping bulk group participant backfill to preserve contact cleanliness.`);
  }

  getSyncProgress(userId: string): SyncProgressState {
    const existing = this.syncProgressMap.get(userId);
    if (existing) return existing;
    return {
      userId,
      whatsappAccountId: '',
      status: 'IDLE',
      currentStage: 'IDLE',
      progress: 0,
      message: 'Ready to synchronize WhatsApp data',
      contactsCount: 0,
      groupsCount: 0,
      chatsCount: 0,
      messagesCount: 0,
      aiExtractionCount: 0,
      aiAnalysisCount: 0,
      contacts: { total: 0, processed: 0, percentage: 0 },
      groups: { total: 0, processed: 0, percentage: 0 },
      conversations: { total: 0, processed: 0, percentage: 0 },
      messages: { total: 0, processed: 0, percentage: 0 },
      aiExtraction: { total: 0, processed: 0, percentage: 0 },
      aiAnalysis: { total: 0, processed: 0, percentage: 0 },
      canContinueToApp: true,
    };
  }

  /**
   * Progress of the sync that is running now. After a finished sync the next one starts from zero,
   * otherwise its counters would keep adding to the old ones (for example "26 of 1").
   */
  getWorkingProgress(userId: string): SyncProgressState {
    const existing = this.syncProgressMap.get(userId);
    if (existing && existing.status === 'COMPLETED') {
      this.syncProgressMap.delete(userId);
    }
    return this.getSyncProgress(userId);
  }

  /** Adds one batch to a stage. The total counts what was handed over, so processed never exceeds it. */
  private stageCounters(
    prev: { total: number; processed: number },
    batchTotal: number,
    batchProcessed: number
  ): { total: number; processed: number; percentage: number } {
    const processed = prev.processed + batchProcessed;
    const total = Math.max(prev.total + batchTotal, processed);
    return { total, processed, percentage: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100 };
  }

  resetSyncProgress(userId: string) {
    this.syncProgressMap.delete(userId);
    this.eventsGateway.sendToUser(userId, 'sync:progress', null);
    this.eventsGateway.sendToUser(userId, 'whatsapp.sync', {
      stage: 'idle',
      progress: 0,
      message: 'Synced data has been reset.',
      syncState: null,
    });
  }

  updateSyncProgress(userId: string, partial: Partial<SyncProgressState>) {
    const finishing = partial.status === 'COMPLETED' || partial.currentStage === 'COMPLETED';
    // A finished sync is not extended: a new cycle starts from a clean slate.
    const current = finishing ? this.getSyncProgress(userId) : this.getWorkingProgress(userId);
    let overallProgress: number;
    if (typeof partial.progress === 'number') {
      overallProgress = partial.progress;
    } else if (finishing) {
      overallProgress = 100;
    } else {
      // Weighted average over the stages that have work. A stage with nothing to do (no groups, no
      // history messages) is left out instead of holding the bar at 75%.
      // Stages we have already moved past with nothing to do are skipped; stages not reached yet count as 0%.
      const order: Record<string, number> = { CONTACTS: 1, GROUPS: 2, CONVERSATIONS: 3, MESSAGES: 4 };
      const at = order[String(partial.currentStage || current.currentStage)] ?? 0;
      const stages = [
        { o: 1, w: 20, total: partial.contacts?.total ?? current.contacts.total, pct: partial.contacts?.percentage ?? current.contacts.percentage },
        { o: 2, w: 10, total: partial.groups?.total ?? current.groups.total, pct: partial.groups?.percentage ?? current.groups.percentage },
        { o: 3, w: 30, total: partial.conversations?.total ?? current.conversations.total, pct: partial.conversations?.percentage ?? current.conversations.percentage },
        { o: 4, w: 40, total: partial.messages?.total ?? current.messages.total, pct: partial.messages?.percentage ?? current.messages.percentage },
      ].filter((x) => x.total > 0 || x.o > at);
      const weight = stages.reduce((a, x) => a + x.w, 0);
      const raw = weight > 0 ? Math.round(stages.reduce((a, x) => a + x.w * x.pct, 0) / weight) : 0;
      // Never goes backwards while syncing, and only a finished sync shows 100%.
      overallProgress = Math.min(99, Math.max(current.progress, raw));
    }

    const updated: SyncProgressState = {
      ...current,
      ...partial,
      progress: overallProgress,
      message: partial.message || `Processing ${(partial.currentStage || current.currentStage).toLowerCase()}...`,
      contactsCount: partial.contacts?.processed ?? current.contactsCount,
      groupsCount: partial.groups?.processed ?? current.groupsCount,
      chatsCount: partial.conversations?.processed ?? current.chatsCount,
      messagesCount: partial.messages?.processed ?? current.messagesCount,
      aiExtractionCount: partial.aiExtraction?.processed ?? current.aiExtractionCount,
      aiAnalysisCount: partial.aiAnalysis?.processed ?? current.aiAnalysisCount,
      updatedAt: new Date(),
    };

    this.syncProgressMap.set(userId, updated);
    this.eventsGateway.sendToUser(userId, 'sync:progress', updated);
    this.eventsGateway.sendToUser(userId, 'whatsapp.sync', {
      stage: updated.currentStage.toLowerCase(),
      progress: updated.progress,
      message: updated.message,
      syncState: updated,
    });
  }

  async handleConnectionUpdate(
    userId: string,
    whatsappAccountId: string,
    update: {
      status: ConnectionState;
      qrCode?: string;
      pairingCode?: string;
      phoneNumber?: string;
      displayName?: string;
      lastError?: string;
    }
  ) {
    const isConnected = update.status === 'CONNECTED' || update.status === 'READY';
    const isConnecting = update.status === 'QR_PENDING' || update.status === 'PAIRING_CODE_PENDING' || update.status === 'AUTHENTICATING';

    await this.prisma.whatsAppAccount.update({
      where: { id: whatsappAccountId },
      data: {
        status: update.status,
        ...(update.phoneNumber ? { phoneNumber: update.phoneNumber } : {}),
        ...(update.displayName ? { displayName: update.displayName } : {}),
        ...(isConnected ? { lastConnectedAt: new Date(), lastSyncAt: new Date() } : {}),
        ...(update.status === 'DISCONNECTED' ? { lastDisconnectedAt: new Date() } : {}),
      },
    });

    if (isConnected || isConnecting) {
      const targetConn = await this.prisma.whatsAppConnection.findFirst({
        where: { whatsappAccountId, isActive: true },
        orderBy: { createdAt: 'desc' },
      }) || await this.prisma.whatsAppConnection.findFirst({
        where: { whatsappAccountId },
        orderBy: { createdAt: 'desc' },
      });

      if (targetConn) {
        // Ensure no other connections for this account are active
        await this.prisma.whatsAppConnection.updateMany({
          where: { whatsappAccountId, id: { not: targetConn.id }, isActive: true },
          data: { isActive: false },
        });

        let meta: any = {};
        try {
          if (targetConn.encryptedSessionData) {
            meta = JSON.parse(targetConn.encryptedSessionData);
          }
        } catch {}
        if (update.phoneNumber) meta.phoneNumber = update.phoneNumber;
        if (isConnected) meta.connectedAt = new Date().toISOString();

        await this.prisma.whatsAppConnection.update({
          where: { id: targetConn.id },
          data: {
            connectionStatus: update.status,
            isActive: true,
            encryptedSessionData: JSON.stringify(meta),
            ...(isConnected ? { connectedAt: new Date(), lastHeartbeatAt: new Date() } : {}),
            ...(update.lastError ? { lastError: update.lastError } : {}),
          },
        });
      }
    } else if (update.status === 'DISCONNECTED') {
      this.syncProgressMap.delete(userId);
      await this.prisma.whatsAppConnection.updateMany({
        where: { whatsappAccountId },
        data: {
          connectionStatus: 'DISCONNECTED',
          isActive: false,
          disconnectedAt: new Date(),
          ...(update.lastError ? { lastError: update.lastError } : {}),
        },
      });
      this.eventsGateway.sendToUser(userId, 'sync:progress', null);
    }

    // Broadcast normalized connection event over Socket.IO to user room
    this.eventsGateway.sendToUser(userId, 'whatsapp.status', {
      status: update.status,
      qrCode: update.qrCode,
      pairingCode: update.pairingCode,
      phoneNumber: update.phoneNumber,
      displayName: update.displayName,
      lastError: update.lastError,
    });

    if (isConnected) {
      setTimeout(() => {
        this.runSessionBackfill(userId, whatsappAccountId).catch((err) =>
          this.logger.warn(`Session backfill error for ${userId}: ${err.message}`)
        );
      }, 500);
    }
  }

  async handleIncomingMessage(
    userId: string,
    whatsappAccountId: string,
    payload: {
      externalMessageId: string;
      remoteJid: string;
      senderJid?: string;
      pushName?: string;
      textContent?: string;
      isFromMe: boolean;
      timestamp: Date;
      rawMessage: any;
    }
  ) {
    const { externalMessageId, remoteJid, pushName, textContent, isFromMe, timestamp } = payload;

    // Check user retention cutoff
    const settings = await this.prisma.userSettings.findUnique({
      where: { userId },
    });
    const retentionDays = settings?.retentionDays || 3;
    const retentionCutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    if (timestamp < retentionCutoff) {
      this.logger.debug(
        `Incoming message ${externalMessageId} timestamp ${timestamp.toISOString()} older than ${retentionDays}-day retention cutoff. Skipping.`
      );
      return;
    }

    const payloadHash = createHash('sha256')
      .update(`${whatsappAccountId}:${externalMessageId}:${timestamp.getTime()}`)
      .digest('hex');

    // 1. Rigorous Deduplication Check on Message table
    const existingMessage = await this.prisma.message.findUnique({
      where: {
        whatsappAccountId_externalMessageId: {
          whatsappAccountId,
          externalMessageId,
        },
      },
    });

    if (existingMessage) {
      this.logger.debug(`Deduplication: Message ${externalMessageId} already processed. Skipping.`);
      return;
    }

    // 2. Database Transaction Order: All entities written before Socket emission
    let savedMessage: any = null;
    let savedConversation: any = null;
    let savedContact: any = null;

    const isGroup = remoteJid.endsWith('@g.us');
    const isNewsletter = remoteJid.endsWith('@newsletter');
    const isLid = remoteJid.endsWith('@lid');
    const isUser = remoteJid.endsWith('@s.whatsapp.net');

    const account = await this.prisma.whatsAppAccount.findUnique({
      where: { id: whatsappAccountId },
      select: { phoneNumber: true },
    });
    const accountPhone = account?.phoneNumber || null;
    const isSelf = this.isSelfJid(remoteJid, accountPhone);

    try {
      // Record provider event as IN_PROGRESS
      await this.prisma.providerEvent.upsert({
        where: {
          whatsappAccountId_externalEventId: {
            whatsappAccountId,
            externalEventId: externalMessageId,
          },
        },
        update: {
          payloadHash,
          receivedAt: new Date(),
        },
        create: {
          userId,
          whatsappAccountId,
          externalEventId: externalMessageId,
          eventType: 'message.received',
          payloadHash,
          processed: false,
        },
      });

      const rawSenderDigits = payload.senderJid ? payload.senderJid.split('@')[0].split(':')[0] : null;
      const senderPhone = rawSenderDigits ? formatPhoneNumber(rawSenderDigits) : null;
      const senderName = isFromMe
        ? 'You'
        : (pushName && !isRawIdentifier(pushName) ? pushName.trim() : (senderPhone || (isGroup ? 'Member' : 'Contact')));

      // Look up existing contact and conversation to preserve real human-readable names
      const existingContact = await this.prisma.contact.findUnique({
        where: {
          whatsappAccountId_externalContactId: {
            whatsappAccountId,
            externalContactId: remoteJid,
          },
        },
      });

      const existingConversation = await this.prisma.conversation.findUnique({
        where: {
          whatsappAccountId_externalChatId: {
            whatsappAccountId,
            externalChatId: remoteJid,
          },
        },
      });

      let resolvedName: string;
      let contactPhoneNumber: string | null = null;
      let chatType: string = 'INDIVIDUAL';

      if (isSelf) {
        chatType = 'SELF';
        contactPhoneNumber = accountPhone ? formatPhoneNumber(accountPhone.replace(/\D/g, '')) : null;
        resolvedName = this.getSelfDisplayName(accountPhone);
      } else if (isNewsletter) {
        chatType = 'CHANNEL';
        if (existingConversation?.title && !isRawIdentifier(existingConversation.title)) {
          resolvedName = existingConversation.title;
        } else if (existingContact?.displayName && !isRawIdentifier(existingContact.displayName)) {
          resolvedName = existingContact.displayName;
        } else if (pushName && !isRawIdentifier(pushName)) {
          resolvedName = pushName.trim();
        } else {
          resolvedName = 'Unnamed Channel';
        }
        contactPhoneNumber = null;
      } else if (isGroup) {
        chatType = 'GROUP';
        if (existingConversation?.title && !isRawIdentifier(existingConversation.title)) {
          resolvedName = existingConversation.title;
        } else if (existingContact?.displayName && !isRawIdentifier(existingContact.displayName)) {
          resolvedName = existingContact.displayName;
        } else {
          resolvedName = 'Unnamed Group';
        }
        contactPhoneNumber = null;
      } else if (isLid) {
        chatType = 'INDIVIDUAL';
        if (existingContact?.displayName && !isRawIdentifier(existingContact.displayName)) {
          resolvedName = existingContact.displayName;
        } else if (!isFromMe && pushName && !isRawIdentifier(pushName)) {
          resolvedName = pushName.trim();
        } else {
          resolvedName = 'Contact';
        }
        contactPhoneNumber = existingContact?.phoneNumber || null;
      } else {
        // Normal user (@s.whatsapp.net)
        chatType = 'INDIVIDUAL';
        const rawDigits = remoteJid.split('@')[0].split(':')[0];
        contactPhoneNumber = formatPhoneNumber(rawDigits) || null;
        if (existingContact?.displayName && !isRawIdentifier(existingContact.displayName)) {
          resolvedName = existingContact.displayName;
        } else if (!isFromMe && pushName && !isRawIdentifier(pushName)) {
          resolvedName = pushName.trim();
        } else if (contactPhoneNumber) {
          resolvedName = contactPhoneNumber;
        } else {
          resolvedName = 'Contact';
        }
      }

      // Upsert Contact
      const validPushName = (!isFromMe && pushName && !isRawIdentifier(pushName)) ? pushName.trim() : undefined;
      savedContact = await this.prisma.contact.upsert({
        where: {
          whatsappAccountId_externalContactId: {
            whatsappAccountId,
            externalContactId: remoteJid,
          },
        },
        update: {
          ...(validPushName ? { pushName: validPushName } : {}),
          ...(resolvedName !== 'Unnamed Group' && resolvedName !== 'Unnamed Channel' && resolvedName !== 'Contact'
            ? { displayName: nextContactName(existingContact, { name: resolvedName }).displayName ?? resolvedName }
            : {}),
          ...(contactPhoneNumber ? { phoneNumber: contactPhoneNumber } : {}),
          isGroup: isGroup || isNewsletter,
        },
        create: {
          userId,
          whatsappAccountId,
          externalContactId: remoteJid,
          displayName: resolvedName,
          pushName: validPushName || null,
          phoneNumber: contactPhoneNumber,
          isBusiness: false,
          isGroup: isGroup || isNewsletter,
        },
      });

      const groupTitle = (isGroup || isNewsletter)
        ? (existingConversation?.title && !isRawIdentifier(existingConversation.title)
            ? existingConversation.title
            : resolvedName)
        : null;

      const previewText = isGroup && !isFromMe
        ? `${senderName}: ${textContent || '[Message]'}`
        : (textContent || '[Message]');

      // Upsert Conversation
      savedConversation = await this.prisma.conversation.upsert({
        where: {
          whatsappAccountId_externalChatId: {
            whatsappAccountId,
            externalChatId: remoteJid,
          },
        },
        update: {
          contactId: savedContact.id,
          chatType,
          isSelfChat: isSelf,
          ...(groupTitle && groupTitle !== 'Unnamed Group' && groupTitle !== 'Unnamed Channel'
            ? { title: groupTitle }
            : (isSelf ? { title: resolvedName } : {})),
          lastMessageText: previewText,
          lastMessageAt: timestamp,
          unreadCount: isFromMe ? 0 : { increment: 1 },
        },
        create: {
          userId,
          whatsappAccountId,
          contactId: savedContact.id,
          externalChatId: remoteJid,
          chatType,
          isSelfChat: isSelf,
          title: isSelf ? resolvedName : groupTitle,
          lastMessageText: previewText,
          lastMessageAt: timestamp,
          unreadCount: isFromMe ? 0 : 1,
        },
        include: {
          contact: true,
        },
      });

      if (isNewsletter && (resolvedName === 'Unnamed Channel' || !existingConversation?.title)) {
        this.enrichChannelMetadata(userId, whatsappAccountId, savedConversation.id, remoteJid).catch(() => {});
      }

      if (!isGroup && !isNewsletter) {
        await this.storeChatTitles(userId, whatsappAccountId, [remoteJid]);
      }

      // Upsert Message with P2002 concurrency safety
      try {
        savedMessage = await this.prisma.message.upsert({
          where: {
            whatsappAccountId_externalMessageId: {
              whatsappAccountId,
              externalMessageId,
            },
          },
          update: {
            textContent,
            isFromMe,
            senderType: isFromMe ? 'ME' : 'CONTACT',
            currentStatus: isFromMe ? 'READ' : 'DELIVERED',
            messageTimestamp: timestamp,
            metadata: {
              senderName,
              senderJid: payload.senderJid,
              isGroup,
            },
          },
          create: {
            userId,
            whatsappAccountId,
            conversationId: savedConversation.id,
            externalMessageId,
            externalSenderId: payload.senderJid || (isFromMe ? 'me' : remoteJid),
            senderContactId: isFromMe ? null : savedContact.id,
            senderType: isFromMe ? 'ME' : 'CONTACT',
            messageType: 'TEXT',
            textContent,
            isFromMe,
            currentStatus: isFromMe ? 'READ' : 'DELIVERED',
            messageTimestamp: timestamp,
            metadata: {
              senderName,
              senderJid: payload.senderJid,
              isGroup,
            },
            statuses: {
              create: {
                userId,
                whatsappAccountId,
                status: isFromMe ? 'READ' : 'DELIVERED',
              },
            },
          },
        });
      } catch (err: any) {
        if (err.code === 'P2002') {
          savedMessage = await this.prisma.message.findUnique({
            where: {
              whatsappAccountId_externalMessageId: {
                whatsappAccountId,
                externalMessageId,
              },
            },
          });
        } else {
          throw err;
        }
      }

      // Mark Provider Event PROCESSED
      await this.prisma.providerEvent.update({
        where: {
          whatsappAccountId_externalEventId: {
            whatsappAccountId,
            externalEventId: externalMessageId,
          },
        },
        data: {
          processed: true,
          processedAt: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.error(`Failed database operation for incoming message ${externalMessageId}: ${err.message}`);
      return;
    }

    // 3. Broadcast Socket.IO events immediately & queue async AI
    if (savedMessage && savedConversation) {
      const messagePayload = {
        chatId: savedConversation.id,
        message: savedMessage,
      };

      this.eventsGateway.sendToUser(userId, 'message:new', messagePayload);
      this.eventsGateway.sendToUser(userId, 'message.new', messagePayload);
      this.eventsGateway.sendToUser(userId, 'chat.message.new', messagePayload);
      this.eventsGateway.sendToUser(userId, 'conversation:updated', {
        conversation: savedConversation,
      });
      this.eventsGateway.sendToAccount(whatsappAccountId, 'message:new', messagePayload);
      this.eventsGateway.sendToAccount(whatsappAccountId, 'message.new', messagePayload);
      this.eventsGateway.sendToAccount(whatsappAccountId, 'chat.message.new', messagePayload);
      this.eventsGateway.sendToAccount(whatsappAccountId, 'conversation:updated', {
        conversation: savedConversation,
      });

      // Emit real-time stats update
      this.prisma.message.count({ where: { userId, whatsappAccountId } }).then((msgCount) => {
        this.eventsGateway.sendToUser(userId, 'whatsapp:stats', { messages: msgCount });
      }).catch(() => {});

      if (!isFromMe && textContent && textContent.trim().length > 0 && !isNewsletter) {
        const isNoise = /^(ok|okay|k|h[ie]y*|hello|thanks|thank you|thx|gm|gn|good morning|good night|👍|🙏|❤️|😊|haha|lol)$/i.test(
          textContent.trim()
        );
        if (!isNoise) {
          const cleanSenderName = resolveDisplayName(savedContact, savedConversation?.title, isGroup);
          this.processMessageAI(
            userId,
            whatsappAccountId,
            savedConversation.id,
            savedContact.id,
            savedMessage.id,
            textContent,
            cleanSenderName
          ).catch((err: any) => this.logger.warn(`AI extraction queued error: ${err.message}`));
        }
      }
    }
  }

  async handleMessageStatus(
    userId: string,
    whatsappAccountId: string,
    payload: {
      externalMessageId: string;
      remoteJid: string;
      status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
      timestamp: Date;
    }
  ) {
    try {
      const msg = await this.prisma.message.findUnique({
        where: {
          whatsappAccountId_externalMessageId: {
            whatsappAccountId,
            externalMessageId: payload.externalMessageId,
          },
        },
      });

      if (!msg) return;

      await this.prisma.message.update({
        where: { id: msg.id },
        data: { currentStatus: payload.status },
      });

      await this.prisma.messageStatus.upsert({
        where: {
          messageId_status: {
            messageId: msg.id,
            status: payload.status,
          },
        },
        update: { timestamp: payload.timestamp },
        create: {
          userId,
          whatsappAccountId,
          messageId: msg.id,
          status: payload.status,
          timestamp: payload.timestamp,
        },
      });

      this.eventsGateway.sendToAccount(whatsappAccountId, 'message.status', {
        messageId: msg.id,
        chatId: msg.conversationId,
        status: payload.status,
      });
    } catch (err: any) {
      this.logger.warn(`Error handling message status update: ${err.message}`);
    }
  }

  async handleContactsUpsert(
    userId: string,
    whatsappAccountId: string,
    contacts: Array<{ id: string; lid?: string; jid?: string; name?: string; notify?: string; verifiedName?: string }>
  ) {
    const account = await this.prisma.whatsAppAccount.findUnique({
      where: { id: whatsappAccountId },
      select: { phoneNumber: true },
    });
    const accountPhone = account?.phoneNumber || null;

    // WhatsApp gives the LID and phone JID together for saved contacts. Store that pair
    // so chats addressed by LID resolve to the same saved contact as the Contacts tab.
    for (const c of contacts) {
      const phoneJid = [c.jid, c.id].find((j) => j && j.endsWith('@s.whatsapp.net'));
      const lidJid = [c.lid, c.id].find((j) => j && j.endsWith('@lid'));
      if (phoneJid && lidJid) {
        await this.prisma.lIDMapping
          .upsert({
            where: { whatsappAccountId_lid: { whatsappAccountId, lid: lidJid } },
            update: { phoneJid },
            create: { userId, whatsappAccountId, lid: lidJid, phoneJid },
          })
          .catch((err: any) => this.logger.warn(`LID mapping upsert failed: ${err.message}`));
      }
    }

    const normalised = contacts
      .filter((c) => c.id && c.id !== 'status@broadcast')
      .map((contact) => {
        const remoteJid = contact.id;
        const phoneJid = [contact.jid, contact.id].find((j) => j && j.endsWith('@s.whatsapp.net'));
        const isGroup = remoteJid.endsWith('@g.us');
        const isNewsletter = remoteJid.endsWith('@newsletter');
        const isUser = remoteJid.endsWith('@s.whatsapp.net');
        const isSelf = this.isSelfJid(remoteJid, accountPhone);
        const rawNumber = remoteJid.split('@')[0].split(':')[0];
        const phoneNumber = phoneJid
          ? formatPhoneNumber(phoneJid.split('@')[0]) || null
          : isUser || isSelf
          ? formatPhoneNumber(rawNumber) || null
          : null;
        const isSavedInAddressBook = Boolean(
          contact.name && contact.name.trim().length > 0 && !isRawIdentifier(contact.name)
        );
        const candidateName = contact.name || contact.notify || contact.verifiedName;
        const displayName = isSelf
          ? this.getSelfDisplayName(accountPhone)
          : isSavedInAddressBook
          ? contact.name!.trim()
          : candidateName && !isRawIdentifier(candidateName)
          ? candidateName.trim()
          : isGroup
          ? 'Unnamed Group'
          : isNewsletter
          ? 'Unnamed Channel'
          : phoneNumber || formatPhoneNumber(rawNumber) || rawNumber || 'Contact';
        return {
          remoteJid,
          phoneNumber,
          displayName,
          isSavedInAddressBook,
          isGroup,
          isNewsletter,
          verifiedName: contact.verifiedName,
        };
      });

    if (normalised.length === 0) return;

    const jids = normalised.map((n) => n.remoteJid);
    const existing = await this.prisma.contact.findMany({
      where: { whatsappAccountId, externalContactId: { in: jids } },
      select: { id: true, externalContactId: true, displayName: true, isSavedContact: true },
    });
    const existingMap = new Map(existing.map((c) => [c.externalContactId, c]));

    const toCreate: any[] = [];
    const updatePromises: Promise<any>[] = [];

    for (const n of normalised) {
      const row = existingMap.get(n.remoteJid);
      if (!row) {
        toCreate.push({
          userId,
          whatsappAccountId,
          externalContactId: n.remoteJid,
          displayName: n.displayName,
          phoneNumber: n.phoneNumber,
          isBusiness: Boolean(n.verifiedName),
          isGroup: n.isGroup || n.isNewsletter,
          isSavedContact: n.isSavedInAddressBook,
        });
      } else {
        const name = nextContactName(row, { name: n.displayName, isSaved: n.isSavedInAddressBook });
        updatePromises.push(
          this.prisma.contact
            .update({
              where: { id: row.id },
              data: {
                displayName: name.displayName ?? n.displayName,
                ...(n.phoneNumber ? { phoneNumber: n.phoneNumber } : {}),
                isGroup: n.isGroup || n.isNewsletter,
                isBusiness: Boolean(n.verifiedName),
                isSavedContact: name.isSavedContact,
              },
            })
            .catch(() => {})
        );
      }
    }

    if (toCreate.length) {
      try {
        await this.prisma.contact.createMany({ data: toCreate });
      } catch {
        for (const row of toCreate) {
          try {
            await this.prisma.contact.create({ data: row });
          } catch {}
        }
      }
    }
    if (updatePromises.length) await Promise.all(updatePromises);

    this.eventsGateway.sendToUser(userId, 'contacts:updated', { count: normalised.length });
    await this.storeChatTitles(userId, whatsappAccountId);

    const processed = normalised.length;
    const current = this.getWorkingProgress(userId);
    this.updateSyncProgress(userId, {
      currentStage: 'CONTACTS',
      contacts: this.stageCounters(current.contacts, processed, processed),
    });
  }

  async handleGroupsUpsert(
    userId: string,
    whatsappAccountId: string,
    groups: Array<{
      id: string;
      subject: string;
      owner?: string;
      creation?: number;
      desc?: string;
      participantsCount?: number;
    }>
  ) {
    let processed = 0;
    for (const group of groups) {
      if (!group.id) continue;
      const groupJid = group.id;
      const groupName =
        group.subject && !isRawIdentifier(group.subject) ? group.subject.trim() : 'Unnamed Group';

      try {
        const contact = await this.prisma.contact.upsert({
          where: {
            whatsappAccountId_externalContactId: {
              whatsappAccountId,
              externalContactId: groupJid,
            },
          },
          update: {
            displayName: groupName,
            isGroup: true,
          },
          create: {
            userId,
            whatsappAccountId,
            externalContactId: groupJid,
            displayName: groupName,
            phoneNumber: null,
            isBusiness: false,
            isGroup: true,
          },
        });

        const existingConv = await this.prisma.conversation.findUnique({
          where: {
            whatsappAccountId_externalChatId: {
              whatsappAccountId,
              externalChatId: groupJid,
            },
          },
        });

        if (existingConv) {
          await this.prisma.conversation.update({
            where: { id: existingConv.id },
            data: {
              contactId: contact.id,
              chatType: 'GROUP',
              title: groupName,
            },
          });
        }
        processed++;
      } catch (err: any) {
        this.logger.warn(`Failed to upsert group ${group.id}: ${err.message}`);
      }
    }

    const current = this.getWorkingProgress(userId);
    this.updateSyncProgress(userId, {
      currentStage: 'GROUPS',
      groups: this.stageCounters(current.groups, groups.length, processed),
      canContinueToApp: true,
    });
  }

  async handleGroupUpdate(
    userId: string,
    whatsappAccountId: string,
    update: { groupId: string; subject?: string; desc?: string }
  ) {
    if (!update.groupId || !update.subject) return;
    const groupName = !isRawIdentifier(update.subject) ? update.subject.trim() : 'Unnamed Group';

    try {
      await this.prisma.contact.updateMany({
        where: { whatsappAccountId, externalContactId: update.groupId },
        data: { displayName: groupName },
      });

      await this.prisma.conversation.updateMany({
        where: { whatsappAccountId, externalChatId: update.groupId },
        data: { title: groupName },
      });

      this.eventsGateway.sendToUser(userId, 'conversation:updated', {
        externalChatId: update.groupId,
        title: groupName,
      });
    } catch (err: any) {
      this.logger.warn(`Failed to update group ${update.groupId}: ${err.message}`);
    }
  }

  async handleChatsUpsert(
    userId: string,
    whatsappAccountId: string,
    chats: Array<{ id: string; name?: string; unreadCount?: number; conversationTimestamp?: number }>
  ) {
    const account = await this.prisma.whatsAppAccount.findUnique({
      where: { id: whatsappAccountId },
      select: { phoneNumber: true },
    });
    const accountPhone = account?.phoneNumber || null;

    // Like WhatsApp: the chat list comes from chat metadata (last activity time), not from
    // messages. Newest chats first, limited to the user's retention window.
    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });
    const retentionCutoffMs = Date.now() - (settings?.retentionDays || 3) * 24 * 60 * 60 * 1000;
    const activityDate = (ts: any): Date | null => {
      const n = typeof ts === 'number' ? ts : Number(ts);
      if (!n || Number.isNaN(n)) return null;
      return new Date(n > 1e11 ? n : n * 1000);
    };
    const orderedChats = chats
      .filter((c) => {
        const at = activityDate(c.conversationTimestamp);
        return !at || at.getTime() >= retentionCutoffMs;
      })
      .sort((a, b) => (activityDate(b.conversationTimestamp)?.getTime() || 0) - (activityDate(a.conversationTimestamp)?.getTime() || 0));

    // Build normalised chat descriptors first so we can bulk-process below.
    const normalisedChats = orderedChats
      .filter((c) => c.id && c.id !== 'status@broadcast')
      .map((chat) => {
        const remoteJid = chat.id;
        const isGroup = remoteJid.endsWith('@g.us');
        const isNewsletter = remoteJid.endsWith('@newsletter');
        const isUser = remoteJid.endsWith('@s.whatsapp.net');
        const isSelf = this.isSelfJid(remoteJid, accountPhone);
        const rawNumber = remoteJid.split('@')[0].split(':')[0];
        const phoneNumber = isUser || isSelf ? formatPhoneNumber(rawNumber) || null : null;
        const candidateName = chat.name;
        const chatType = isSelf ? 'SELF' : isNewsletter ? 'CHANNEL' : isGroup ? 'GROUP' : 'INDIVIDUAL';
        const displayName = isSelf
          ? this.getSelfDisplayName(accountPhone)
          : candidateName && !isRawIdentifier(candidateName)
          ? candidateName.trim()
          : isGroup
          ? 'Unnamed Group'
          : isNewsletter
          ? 'Unnamed Channel'
          : phoneNumber || 'Contact';
        const chatTitle = isSelf
          ? displayName
          : isGroup || isNewsletter
          ? candidateName && !isRawIdentifier(candidateName)
            ? candidateName.trim()
            : displayName
          : null;
        return {
          chat,
          remoteJid,
          isGroup,
          isNewsletter,
          isSelf,
          phoneNumber,
          candidateName,
          chatType,
          displayName,
          chatTitle,
        };
      });

    if (normalisedChats.length === 0) {
      return;
    }

    const jids = normalisedChats.map((n) => n.remoteJid);
    const [existingContacts, existingConvs] = await Promise.all([
      this.prisma.contact.findMany({
        where: { whatsappAccountId, externalContactId: { in: jids } },
      }),
      this.prisma.conversation.findMany({
        where: { whatsappAccountId, externalChatId: { in: jids } },
      }),
    ]);
    const contactMap = new Map(existingContacts.map((c) => [c.externalContactId, c]));
    const convMap = new Map(existingConvs.map((c) => [c.externalChatId, c]));

    // Bulk-create missing contacts.
    const newContacts = normalisedChats
      .filter((n) => !contactMap.has(n.remoteJid))
      .map((n) => ({
        userId,
        whatsappAccountId,
        externalContactId: n.remoteJid,
        displayName: n.displayName,
        phoneNumber: n.phoneNumber,
        isBusiness: false,
        isGroup: n.isGroup || n.isNewsletter,
      }));
    if (newContacts.length > 0) {
      try {
        await this.prisma.contact.createMany({ data: newContacts });
      } catch {
        for (const row of newContacts) {
          try {
            await this.prisma.contact.create({ data: row });
          } catch {}
        }
      }
      const refetched = await this.prisma.contact.findMany({
        where: {
          whatsappAccountId,
          externalContactId: { in: newContacts.map((c) => c.externalContactId) },
        },
      });
      for (const c of refetched) contactMap.set(c.externalContactId, c);
    }

    // Bulk-create missing conversations. We seed lastMessageAt from the chat's
    // conversationTimestamp and lastMessageText with a placeholder so the chat
    // shows up in the list right away (WhatsApp-Web style: names first). The
    // real last-message preview is filled in when messages are ingested.
    const newConvs = normalisedChats
      .filter((n) => !convMap.has(n.remoteJid) && contactMap.has(n.remoteJid))
      .map((n) => ({
        userId,
        whatsappAccountId,
        contactId: contactMap.get(n.remoteJid)!.id,
        externalChatId: n.remoteJid,
        chatType: n.chatType,
        isSelfChat: n.isSelf,
        title: n.chatTitle,
        lastMessageText: null,
        lastMessageAt: activityDate(n.chat.conversationTimestamp),
        unreadCount: n.chat.unreadCount || 0,
      }))
      .filter((c) => c.contactId);
    if (newConvs.length > 0) {
      try {
        await this.prisma.conversation.createMany({ data: newConvs });
      } catch {
        for (const row of newConvs) {
          try {
            await this.prisma.conversation.create({ data: row });
          } catch {}
        }
      }
      const refetched = await this.prisma.conversation.findMany({
        where: {
          whatsappAccountId,
          externalChatId: { in: newConvs.map((c) => c.externalChatId) },
        },
      });
      for (const c of refetched) convMap.set(c.externalChatId, c);
    }

    // Update conversations that already existed when the name/unreadCount changes.
    const updatePromises: Promise<any>[] = [];
    for (const n of normalisedChats) {
      const conv = convMap.get(n.remoteJid);
      const contact = contactMap.get(n.remoteJid);
      if (!conv || !contact) continue;
      const titleWorth =
        n.chatTitle && n.chatTitle !== 'Unnamed Group' && n.chatTitle !== 'Unnamed Channel'
          ? n.chatTitle
          : null;
      const data: any = { contactId: contact.id, chatType: n.chatType, isSelfChat: n.isSelf };
      const at = activityDate(n.chat.conversationTimestamp);
      if (at && (!conv.lastMessageAt || at > conv.lastMessageAt)) data.lastMessageAt = at;
      if (titleWorth) data.title = titleWorth;
      else if (n.isSelf) data.title = n.displayName;
      if (n.chat.unreadCount !== undefined) data.unreadCount = n.chat.unreadCount;
      updatePromises.push(
        this.prisma.conversation.update({ where: { id: conv.id }, data }).catch(() => {})
      );
      if (n.isNewsletter && (!titleWorth || titleWorth === 'Unnamed Channel')) {
        this.enrichChannelMetadata(userId, whatsappAccountId, conv.id, n.remoteJid).catch(() => {});
      }
    }
    if (updatePromises.length) await Promise.all(updatePromises);

    await this.storeChatTitles(userId, whatsappAccountId, normalisedChats.map((n) => n.remoteJid));

    // Tell the app to refetch the chat list NOW so chat names appear immediately.
    this.eventsGateway.sendToUser(userId, 'chats:updated', { count: normalisedChats.length });

    const processed = normalisedChats.length;
    const current = this.getWorkingProgress(userId);
    this.updateSyncProgress(userId, {
      currentStage: 'CONVERSATIONS',
      conversations: this.stageCounters(current.conversations, processed, processed),
      canContinueToApp: true,
    });
  }

  async handleMessagingHistorySet(
    userId: string,
    whatsappAccountId: string,
    payload: {
      chats?: any[];
      contacts?: any[];
      messages?: any[];
      isLatest?: boolean;
      progress?: number;
      syncType?: any;
    }
  ) {
    const chats = payload.chats || [];
    const contacts = payload.contacts || [];
    const rawMessages = payload.messages || [];

    this.logger.log(
      `[HISTORY_SYNC] Received messaging-history.set for user ${userId} [Chats: ${chats.length}, Contacts: ${contacts.length}, Messages: ${rawMessages.length}, SyncType: ${payload.syncType}]`
    );

    const account = await this.prisma.whatsAppAccount.findUnique({
      where: { id: whatsappAccountId },
      select: { phoneNumber: true },
    });
    const accountPhone = account?.phoneNumber || null;

    // 1. Fetch user retention settings (default 30 days)
    const settings = await this.prisma.userSettings.findUnique({
      where: { userId },
    });
    const retentionDays = settings?.retentionDays || 3;
    const retentionCutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // 1. Process Chats / Conversations FIRST
    if (chats.length > 0) {
      this.updateSyncProgress(userId, {
        currentStage: 'CONVERSATIONS',
        message: `Synchronizing ${chats.length} conversations...`,
        status: 'SYNCING',
        canContinueToApp: true,
      });
      await this.handleChatsUpsert(userId, whatsappAccountId, chats);
    }

    // 2. Process Contacts (Phonebook saved contacts)
    if (contacts.length > 0) {
      this.updateSyncProgress(userId, {
        currentStage: 'CONTACTS',
        message: `Synchronizing ${contacts.length} WhatsApp contacts...`,
        status: 'SYNCING',
      });
      await this.handleContactsUpsert(userId, whatsappAccountId, contacts);
      autoLinkAllLidConversations(this.prisma, userId, whatsappAccountId).catch(() => {});
    }

    // 4. Filter Messages by retention window
    const validMessages: Array<{ m: any; msgTimestamp: Date }> = [];
    for (const m of rawMessages) {
      if (!m.message) continue;
      const remoteJid = m.key?.remoteJid;
      if (!remoteJid || remoteJid === 'status@broadcast') continue;

      const rawTs = Number(m.messageTimestamp || 0);
      const msgTimestamp = new Date(rawTs > 0 ? (rawTs > 1e11 ? rawTs : rawTs * 1000) : Date.now());

      if (msgTimestamp >= retentionCutoff) {
        validMessages.push({ m, msgTimestamp });
      }
    }

    this.logger.log(
      `[HISTORY_SYNC] ${validMessages.length} of ${rawMessages.length} history messages fall within ${retentionDays}-day retention.`
    );

    // Sort valid messages NEWEST-first so the chat list fills with the latest
    // conversations immediately after WhatsApp connects.
    validMessages.sort((a, b) => b.msgTimestamp.getTime() - a.msgTimestamp.getTime());

    let messagesProcessed = 0;

    this.updateSyncProgress(userId, {
      currentStage: 'MESSAGES',
      message: `Synchronizing ${validMessages.length} messages within ${retentionDays}-day retention window...`,
      status: 'SYNCING',
      messages: {
        total: validMessages.length,
        processed: 0,
        percentage: validMessages.length === 0 ? 100 : 0,
      },
      canContinueToApp: true,
    });

    // Newest messages are saved first, in slices, so chats fill in from latest to oldest.
    const SLICE = 500;
    for (let i = 0; i < validMessages.length; i += SLICE) {
      try {
        messagesProcessed += await this.bulkIngestHistoryMessages(
          userId,
          whatsappAccountId,
          accountPhone,
          validMessages.slice(i, i + SLICE)
        );
      } catch (err: any) {
        this.logger.error(`[HISTORY_SYNC] Bulk ingest error: ${err.message}`);
      }
    }
    if (validMessages.length > 0) {
      this.updateSyncProgress(userId, {
        currentStage: 'MESSAGES',
        message: `Synchronizing messages (${messagesProcessed}/${validMessages.length})...`,
        messages: {
          total: validMessages.length,
          processed: messagesProcessed,
          percentage: Math.round((messagesProcessed / validMessages.length) * 100),
        },
        canContinueToApp: true,
      });
    }

    // 5. Complete Sync (AI Extraction Gated)
    const isFinished = payload.isLatest !== false;
    const msgPct = validMessages.length > 0 ? Math.round((messagesProcessed / validMessages.length) * 100) : 100;
    if (isFinished || msgPct === 100) {
      this.updateSyncProgress(userId, {
        status: 'COMPLETED',
        currentStage: 'COMPLETED',
        progress: 100,
        message: `WhatsApp fully synchronized! ${messagesProcessed} messages within retention window.`,
        messages: {
          total: validMessages.length,
          processed: messagesProcessed,
          percentage: 100,
        },
        canContinueToApp: true,
        completedAt: new Date(),
      });
    } else {
      this.updateSyncProgress(userId, {
        status: 'SYNCING',
        currentStage: 'MESSAGES',
        message: `Synchronizing messages batch (${messagesProcessed}/${validMessages.length} processed)...`,
        messages: {
          total: validMessages.length,
          processed: messagesProcessed,
          percentage: msgPct,
        },
        canContinueToApp: true,
      });
    }

    await this.storeChatTitles(userId, whatsappAccountId);

    // Broadcast updated stats to user
    const finalContacts = await this.prisma.contact.count({
      where: { userId, whatsappAccountId, isGroup: false, isSavedContact: true },
    });
    const finalGroups = await this.prisma.conversation.count({
      where: { userId, whatsappAccountId, chatType: 'GROUP' },
    });
    const finalChats = await this.prisma.conversation.count({
      where: { userId, whatsappAccountId },
    });
    const finalMessages = await this.prisma.message.count({
      where: { userId, whatsappAccountId },
    });

    const statsPayload = {
      contacts: finalContacts,
      groups: finalGroups,
      chats: finalChats,
      messages: finalMessages,
    };

    // Automatic contact & LID conversation linkage across all saved contacts
    const autoLinkedSync = await autoLinkAllLidConversations(this.prisma, userId, whatsappAccountId);
    if (autoLinkedSync > 0) {
      this.logger.log(`[HISTORY_SYNC] Auto-linked ${autoLinkedSync} LID conversations to saved contacts for user ${userId}`);
    }

    this.eventsGateway.sendToUser(userId, 'whatsapp:stats', statsPayload);
    this.eventsGateway.sendToUser(userId, 'dashboard:updated', { type: 'SYNC_COMPLETE', stats: statsPayload });
    this.logger.log(`[HISTORY_SYNC] Completed sync for ${userId}: ${JSON.stringify(statsPayload)}`);
  }

  async handleLidMappingUpdate(userId: string, whatsappAccountId: string, payload: { lid: string; phoneJid: string }) {
    try {
      await this.prisma.lIDMapping.upsert({
        where: {
          whatsappAccountId_lid: {
            whatsappAccountId,
            lid: payload.lid,
          },
        },
        update: { phoneJid: payload.phoneJid },
        create: {
          userId,
          whatsappAccountId,
          lid: payload.lid,
          phoneJid: payload.phoneJid,
        },
      });

      const phone = formatPhoneNumber(payload.phoneJid.split('@')[0]) || null;
      await this.prisma.contact.updateMany({
        where: { whatsappAccountId, externalContactId: payload.lid },
        data: { lid: payload.lid, ...(phone ? { phoneNumber: phone } : {}) },
      });
      this.logger.log(`[LID_MAPPING] Linked ${payload.lid} -> ${payload.phoneJid} for account ${whatsappAccountId}`);
      await this.storeChatTitles(userId, whatsappAccountId);
    } catch (err: any) {
      this.logger.warn(`Failed to process LID mapping update: ${err.message}`);
    }
  }

  async handleGroupParticipantsUpdate(
    userId: string,
    whatsappAccountId: string,
    payload: { groupId: string; participants: string[]; action: 'add' | 'remove' | 'promote' | 'demote' }
  ) {
    try {
      const conversation = await this.prisma.conversation.findUnique({
        where: {
          whatsappAccountId_externalChatId: {
            whatsappAccountId,
            externalChatId: payload.groupId,
          },
        },
      });
      if (!conversation) return;

      for (const pJid of payload.participants) {
        if (!pJid) continue;
        const rawDigits = pJid.split('@')[0].split(':')[0];
        const phone = formatPhoneNumber(rawDigits) || null;

        const memberContact = await this.prisma.contact.upsert({
          where: {
            whatsappAccountId_externalContactId: {
              whatsappAccountId,
              externalContactId: pJid,
            },
          },
          update: { ...(phone ? { phoneNumber: phone } : {}) },
          create: {
            userId,
            whatsappAccountId,
            externalContactId: pJid,
            displayName: phone || 'Group Member',
            phoneNumber: phone,
            isGroup: false,
          },
        });

        if (payload.action === 'add') {
          await this.prisma.groupParticipant.upsert({
            where: {
              conversationId_contactId: {
                conversationId: conversation.id,
                contactId: memberContact.id,
              },
            },
            update: { role: 'MEMBER' },
            create: {
              userId,
              whatsappAccountId,
              conversationId: conversation.id,
              contactId: memberContact.id,
              role: 'MEMBER',
            },
          });
        } else if (payload.action === 'remove') {
          await this.prisma.groupParticipant.deleteMany({
            where: { conversationId: conversation.id, contactId: memberContact.id },
          });
        } else if (payload.action === 'promote') {
          await this.prisma.groupParticipant.updateMany({
            where: { conversationId: conversation.id, contactId: memberContact.id },
            data: { role: 'ADMIN' },
          });
        } else if (payload.action === 'demote') {
          await this.prisma.groupParticipant.updateMany({
            where: { conversationId: conversation.id, contactId: memberContact.id },
            data: { role: 'MEMBER' },
          });
        }
      }

      this.eventsGateway.sendToUser(userId, 'conversation:updated', {
        externalChatId: payload.groupId,
        action: payload.action,
      });
      this.logger.log(`[GROUP_PARTICIPANTS] Updated ${payload.action} for ${payload.groupId}`);
    } catch (err: any) {
      this.logger.warn(`Failed to process group participants update for ${payload.groupId}: ${err.message}`);
    }
  }

  async handleMessageReceiptUpdate(
    userId: string,
    whatsappAccountId: string,
    receipts: Array<{ externalMessageId: string; remoteJid: string; receiptType: string; timestamp: Date }>
  ) {
    for (const r of receipts) {
      if (!r.externalMessageId) continue;
      let statusStr: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' = 'DELIVERED';
      if (r.receiptType === 'read' || r.receiptType === 'read-self' || r.receiptType === 'played') {
        statusStr = 'READ';
      }

      try {
        const msg = await this.prisma.message.findUnique({
          where: {
            whatsappAccountId_externalMessageId: {
              whatsappAccountId,
              externalMessageId: r.externalMessageId,
            },
          },
        });
        if (!msg) continue;

        await this.prisma.message.update({
          where: { id: msg.id },
          data: { currentStatus: statusStr },
        });

        await this.prisma.messageStatus.upsert({
          where: {
            messageId_status: {
              messageId: msg.id,
              status: statusStr,
            },
          },
          update: { timestamp: r.timestamp },
          create: {
            userId,
            whatsappAccountId,
            messageId: msg.id,
            status: statusStr,
            timestamp: r.timestamp,
          },
        });

        const socketPayload = {
          messageId: msg.id,
          chatId: msg.conversationId,
          status: statusStr,
        };

        this.eventsGateway.sendToUser(userId, 'message.status', socketPayload);
        this.eventsGateway.sendToUser(userId, 'message:status', socketPayload);
        this.eventsGateway.sendToUser(userId, 'message.delivered', socketPayload);
        if (statusStr === 'READ') {
          this.eventsGateway.sendToUser(userId, 'message.read', socketPayload);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to process message receipt ${r.externalMessageId}: ${err.message}`);
      }
    }
  }

  async handleMessagesDelete(userId: string, whatsappAccountId: string, payload: { messageIds: string[]; remoteJid?: string }) {
    try {
      for (const externalMsgId of payload.messageIds) {
        const msg = await this.prisma.message.findUnique({
          where: { whatsappAccountId_externalMessageId: { whatsappAccountId, externalMessageId: externalMsgId } },
        });
        if (msg) {
          await this.prisma.message.delete({ where: { id: msg.id } });
          this.eventsGateway.sendToUser(userId, 'message:deleted', { messageId: msg.id, chatId: msg.conversationId });
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to handle messages delete: ${err.message}`);
    }
  }

  async handleChatsDelete(userId: string, whatsappAccountId: string, chatIds: string[]) {
    try {
      for (const externalChatId of chatIds) {
        const conv = await this.prisma.conversation.findUnique({
          where: { whatsappAccountId_externalChatId: { whatsappAccountId, externalChatId } },
        });
        if (conv) {
          this.eventsGateway.sendToUser(userId, 'conversation:deleted', { chatId: conv.id, externalChatId });
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to handle chats delete: ${err.message}`);
    }
  }

  async handlePresenceUpdate(
    userId: string,
    whatsappAccountId: string,
    payload: { remoteJid: string; presence: string; isTyping: boolean }
  ) {
    try {
      const conv = await this.prisma.conversation.findUnique({
        where: {
          whatsappAccountId_externalChatId: {
            whatsappAccountId,
            externalChatId: payload.remoteJid,
          },
        },
        select: { id: true },
      });

      const socketPayload = {
        chatId: conv?.id,
        remoteJid: payload.remoteJid,
        presence: payload.presence,
        isTyping: payload.isTyping,
      };

      this.eventsGateway.sendToUser(userId, 'presence:update', socketPayload);
      this.eventsGateway.sendToAccount(whatsappAccountId, 'presence:update', socketPayload);
    } catch (err: any) {
      this.logger.debug(`Failed to process presence update: ${err.message}`);
    }
  }

  /**
   * Bulk-ingest a batch of history messages using the minimum possible number of DB
   * round-trips. Replaces the old per-message upsert loop (which did 3–5 serial queries
   * per message). For 10k messages this cuts sync time from several minutes to seconds.
   */
  private async bulkIngestHistoryMessages(
    userId: string,
    whatsappAccountId: string,
    accountPhone: string | null,
    validMessages: Array<{ m: any; msgTimestamp: Date }>
  ): Promise<number> {
    // 1. Collect every unique chat JID in this batch.
    const jidSet = new Set<string>();
    for (const vm of validMessages) {
      const jid = vm.m.key?.remoteJid;
      if (jid && jid !== 'status@broadcast') jidSet.add(jid);
    }
    const jids = Array.from(jidSet);
    if (jids.length === 0) return 0;

    // 2. Bulk-fetch existing contacts & conversations for those JIDs — one query each.
    const [existingContacts, existingConvs] = await Promise.all([
      this.prisma.contact.findMany({
        where: { whatsappAccountId, externalContactId: { in: jids } },
      }),
      this.prisma.conversation.findMany({
        where: { whatsappAccountId, externalChatId: { in: jids } },
      }),
    ]);
    const contactMap = new Map(existingContacts.map((c) => [c.externalContactId, c]));
    const convMap = new Map(existingConvs.map((c) => [c.externalChatId, c]));

    // 3. Collect the latest message per JID so we can set lastMessage* in one shot.
    const latestPerJid = new Map<
      string,
      { timestamp: Date; text: string; isFromMe: boolean; senderName: string; isGroup: boolean; isNewsletter: boolean; isSelf: boolean }
    >();
    for (const vm of validMessages) {
      const jid = vm.m.key?.remoteJid;
      if (!jid) continue;
      const isGroup = jid.endsWith('@g.us');
      const isNewsletter = jid.endsWith('@newsletter');
      const isSelf = this.isSelfJid(jid, accountPhone);
      const isFromMe = Boolean(vm.m.key.fromMe);
      const { textContent } = unwrapMessage(vm.m.message);
      const senderJid = vm.m.key.participant || (isFromMe ? 'me' : jid);
      const senderDigits = senderJid ? senderJid.split('@')[0].split(':')[0] : null;
      const senderPhone = senderDigits ? formatPhoneNumber(senderDigits) : null;
      const senderName = isFromMe
        ? 'You'
        : vm.m.pushName && !isRawIdentifier(vm.m.pushName)
        ? vm.m.pushName.trim()
        : senderPhone || (isGroup ? 'Member' : 'Contact');
      const prev = latestPerJid.get(jid);
      if (!prev || vm.msgTimestamp > prev.timestamp) {
        latestPerJid.set(jid, {
          timestamp: vm.msgTimestamp,
          text: textContent || '[Message]',
          isFromMe,
          senderName,
          isGroup,
          isNewsletter,
          isSelf,
        });
      }
    }

    // 4. Bulk-create any missing contacts & conversations.
    const missingContacts: any[] = [];
    for (const jid of jids) {
      if (contactMap.has(jid)) continue;
      const latest = latestPerJid.get(jid);
      const isGroup = jid.endsWith('@g.us');
      const isNewsletter = jid.endsWith('@newsletter');
      const isLid = jid.endsWith('@lid');
      const isUser = jid.endsWith('@s.whatsapp.net');
      const isSelf = latest?.isSelf || this.isSelfJid(jid, accountPhone);
      const rawDigits = jid.split('@')[0].split(':')[0];
      const phone = (isUser || isSelf) && !isLid ? formatPhoneNumber(rawDigits) || null : null;
      let displayName = isSelf
        ? this.getSelfDisplayName(accountPhone)
        : isGroup
        ? 'Unnamed Group'
        : isNewsletter
        ? 'Unnamed Channel'
        : phone || 'Contact';
      const pushName = latest && !latest.isFromMe && !latest.isSelf ? latest.senderName : null;
      if (pushName && !isRawIdentifier(pushName) && !isGroup && !isNewsletter) {
        displayName = pushName;
      }
      missingContacts.push({
        userId,
        whatsappAccountId,
        externalContactId: jid,
        displayName,
        phoneNumber: phone,
        lid: isLid ? jid : null,
        isBusiness: false,
        isGroup: isGroup || isNewsletter,
      });
    }

    if (missingContacts.length > 0) {
      try {
        await this.prisma.contact.createMany({ data: missingContacts });
      } catch (err: any) {
        // Fall back to per-row create if the bulk hits a race condition
        for (const row of missingContacts) {
          try {
            await this.prisma.contact.create({ data: row });
          } catch {}
        }
      }
      const refetched = await this.prisma.contact.findMany({
        where: {
          whatsappAccountId,
          externalContactId: { in: missingContacts.map((c) => c.externalContactId) },
        },
      });
      for (const c of refetched) contactMap.set(c.externalContactId, c);
    }

    const missingConvs: any[] = [];
    for (const jid of jids) {
      if (convMap.has(jid)) continue;
      const contact = contactMap.get(jid);
      if (!contact) continue;
      const latest = latestPerJid.get(jid);
      const isGroup = jid.endsWith('@g.us');
      const isNewsletter = jid.endsWith('@newsletter');
      const isSelf = latest?.isSelf || this.isSelfJid(jid, accountPhone);
      const chatType = isSelf ? 'SELF' : isNewsletter ? 'CHANNEL' : isGroup ? 'GROUP' : 'INDIVIDUAL';
      const previewText =
        latest && isGroup && !latest.isFromMe
          ? `${latest.senderName}: ${latest.text}`
          : latest?.text || '[Message]';
      missingConvs.push({
        userId,
        whatsappAccountId,
        contactId: contact.id,
        externalChatId: jid,
        chatType,
        isSelfChat: isSelf,
        title: isSelf || isGroup || isNewsletter ? contact.displayName : null,
        lastMessageText: previewText,
        lastMessageAt: latest?.timestamp || new Date(),
        unreadCount: 0,
      });
    }

    if (missingConvs.length > 0) {
      try {
        await this.prisma.conversation.createMany({ data: missingConvs });
      } catch (err: any) {
        for (const row of missingConvs) {
          try {
            await this.prisma.conversation.create({ data: row });
          } catch {}
        }
      }
      const refetched = await this.prisma.conversation.findMany({
        where: {
          whatsappAccountId,
          externalChatId: { in: missingConvs.map((c) => c.externalChatId) },
        },
      });
      for (const c of refetched) convMap.set(c.externalChatId, c);
    }

    // 5. Update existing conversations' lastMessage* only if the batch has a newer one.
    const convUpdatePromises: Promise<any>[] = [];
    for (const [jid, latest] of latestPerJid) {
      const conv = convMap.get(jid);
      if (!conv) continue;
      if (!conv.lastMessageAt || latest.timestamp > conv.lastMessageAt) {
        const previewText =
          latest.isGroup && !latest.isFromMe
            ? `${latest.senderName}: ${latest.text}`
            : latest.text;
        convUpdatePromises.push(
          this.prisma.conversation
            .update({
              where: { id: conv.id },
              data: {
                lastMessageText: previewText,
                lastMessageAt: latest.timestamp,
              },
            })
            .catch(() => {})
        );
      }
    }
    if (convUpdatePromises.length) await Promise.all(convUpdatePromises);

    // 6. Bulk-fetch which externalMessageIds already exist → only create the new ones.
    const extMsgIds = validMessages
      .map((vm) => vm.m.key?.id)
      .filter((id): id is string => Boolean(id));
    const existingMsgs = await this.prisma.message.findMany({
      where: { whatsappAccountId, externalMessageId: { in: extMsgIds } },
      select: { externalMessageId: true },
    });
    const existingIdSet = new Set(existingMsgs.map((m) => m.externalMessageId));

    // 7. Build the create-rows for messages that are actually new.
    const messageRows: any[] = [];
    const seenInBatch = new Set<string>();
    for (const vm of validMessages) {
      const jid = vm.m.key?.remoteJid;
      if (!jid) continue;
      const extId =
        vm.m.key.id || `msg_hist_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      if (existingIdSet.has(extId) || seenInBatch.has(extId)) continue;
      seenInBatch.add(extId);
      const conv = convMap.get(jid);
      const contact = contactMap.get(jid);
      if (!conv || !contact) continue;
      const isFromMe = Boolean(vm.m.key.fromMe);
      const isGroup = jid.endsWith('@g.us');
      const { textContent } = unwrapMessage(vm.m.message);
      const senderJid = vm.m.key.participant || (isFromMe ? 'me' : jid);
      const senderDigits = senderJid ? senderJid.split('@')[0].split(':')[0] : null;
      const senderPhone = senderDigits ? formatPhoneNumber(senderDigits) : null;
      const senderName = isFromMe
        ? 'You'
        : vm.m.pushName && !isRawIdentifier(vm.m.pushName)
        ? vm.m.pushName.trim()
        : senderPhone || (isGroup ? 'Member' : 'Contact');

      messageRows.push({
        userId,
        whatsappAccountId,
        conversationId: conv.id,
        externalMessageId: extId,
        externalSenderId: senderJid,
        senderContactId: isFromMe ? null : contact.id,
        senderType: isFromMe ? 'ME' : 'CONTACT',
        messageType: 'TEXT',
        textContent,
        isFromMe,
        currentStatus: isFromMe ? 'READ' : 'DELIVERED',
        messageTimestamp: vm.msgTimestamp,
        metadata: { senderName, senderJid, isGroup },
      });
    }

    // 8. Bulk-insert new messages in chunks (MongoDB bulk-write limit is ~1000).
    let inserted = 0;
    const chunkSize = 500;
    for (let i = 0; i < messageRows.length; i += chunkSize) {
      const chunk = messageRows.slice(i, i + chunkSize);
      try {
        const res = await this.prisma.message.createMany({ data: chunk });
        inserted += res.count;
      } catch (err: any) {
        // Fallback: try one by one on failure
        for (const row of chunk) {
          try {
            await this.prisma.message.create({ data: row });
            inserted++;
          } catch {}
        }
      }

      // Refresh chat previews as each chunk lands (newest chunks first).
      this.eventsGateway.sendToUser(userId, 'chats:updated', { count: chunk.length });

      // Progress tick after each chunk — keeps the UI alive during long batches.
      this.updateSyncProgress(userId, {
        currentStage: 'MESSAGES',
        message: `Synchronizing messages (${inserted}/${messageRows.length})...`,
        messages: {
          total: validMessages.length,
          processed: Math.min(inserted + existingIdSet.size, validMessages.length),
          percentage: Math.min(
            100,
            Math.round(((inserted + existingIdSet.size) / validMessages.length) * 100)
          ),
        },
        canContinueToApp: true,
      });
    }

    return inserted + existingIdSet.size;
  }

  private async processMessageAI(
    userId: string,
    whatsappAccountId: string,
    conversationId: string,
    contactId: string,
    messageId: string,
    text: string,
    contactName: string
  ) {
    // The message is already stored. Queue the analysis; the job is idempotent per message,
    // so a repeated webhook delivery cannot create a second job or duplicate extractions.
    await this.aiQueueService.enqueueMessageJob({
      messageId,
      conversationId,
      whatsappAccountId,
      userId,
      jobType: 'MESSAGE_ANALYSIS',
      priority: 1,
    });
  }
}
