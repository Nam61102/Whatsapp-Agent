import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsGateway } from '../gateway/events.gateway';
import { AIService } from '../ai/ai.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { accountCache } from '../../shared/ttl-cache';

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
    private readonly aiService: AIService,
    private readonly whatsappService: WhatsAppService
  ) {}

  private async getAccount(userId: string) {
    const account = await accountCache.getOrLoad(userId, () => this.prisma.whatsAppAccount.findFirst({ where: { userId } }));
    if (!account) {
      throw new NotFoundException('WhatsApp account not found');
    }
    return account;
  }

  async getMessages(
    userId: string,
    chatId: string,
    limit: number = 50,
    before?: string
  ) {
    const account = await this.getAccount(userId);

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: chatId,
        whatsappAccountId: account.id,
        userId,
      },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.userId !== userId) {
      throw new ForbiddenException('Access denied to conversation messages');
    }

    const whereClause: any = {
      conversationId: chatId,
      whatsappAccountId: account.id,
      userId,
    };

    if (before) {
      const cursorMessage = await this.prisma.message.findFirst({
        where: { id: before, conversationId: chatId, userId },
      });
      if (cursorMessage) {
        whereClause.messageTimestamp = {
          lt: cursorMessage.messageTimestamp,
        };
      }
    }

    const messages = await this.prisma.message.findMany({
      where: whereClause,
      orderBy: { messageTimestamp: 'desc' },
      take: limit,
      include: {
        media: true,
        statuses: true,
        replySuggestionsAsSource: {
          take: 3,
        },
      },
    });

    // Reset unread count when messages are viewed
    if (conversation.unreadCount > 0) {
      await this.prisma.conversation.update({
        where: { id: chatId },
        data: { unreadCount: 0 },
      });
    }

    // If no messages stored yet for this chat, request history on-demand from WhatsApp
    if (messages.length === 0 && conversation.externalChatId) {
      this.whatsappService.fetchChatHistory(userId, conversation.externalChatId, limit).catch((err) => {
        this.logger.debug(`On-demand history query notice: ${err.message}`);
      });
    }

    return {
      messages: messages.reverse(),
      hasMore: messages.length === limit,
    };
  }

  async sendMessage(
    userId: string,
    chatId: string,
    textContent: string,
    mediaUrl?: string,
    actionItem?: { id: string; category?: string }
  ) {
    const account = await this.getAccount(userId);

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: chatId,
        whatsappAccountId: account.id,
        userId,
      },
      include: { contact: true },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.userId !== userId) {
      throw new ForbiddenException('Access denied to conversation');
    }

    const externalMessageId = `msg_out_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date();

    const message = await this.prisma.message.create({
      data: {
        userId,
        whatsappAccountId: account.id,
        conversationId: chatId,
        externalMessageId,
        senderType: 'ME',
        messageType: mediaUrl ? 'IMAGE' : 'TEXT',
        textContent: textContent ? textContent.trim() : null,
        isFromMe: true,
        currentStatus: 'SENT',
        messageTimestamp: now,
        statuses: {
          create: {
            userId,
            whatsappAccountId: account.id,
            status: 'SENT',
          },
        },
        ...(mediaUrl
          ? {
              media: {
                create: {
                  userId,
                  whatsappAccountId: account.id,
                  mediaType: 'image',
                  storageBucket: 'whatsapp-media',
                  storagePath: mediaUrl,
                  mimeType: 'image/jpeg',
                },
              },
            }
          : {}),
      },
      include: {
        media: true,
        statuses: true,
      },
    });

    // Update conversation last message
    await this.prisma.conversation.update({
      where: { id: chatId },
      data: {
        lastMessageText: textContent || '[Image]',
        lastMessageAt: now,
      },
    });

    // Dismiss any pending AI Action Center items for this conversation
    await this.aiService.dismissActionItemsForConversation(chatId, now);

    // The reply answers whatever was waiting for one in this chat.
    await this.aiService.resolveRepliedItems(userId, chatId, now);

    // The reply was sent from an Action Center card: that card is done.
    if (actionItem?.id) {
      await this.aiService.resolveActionItem(userId, actionItem.id, actionItem.category);
    }

    // Non-blocking asynchronous dispatch to real WhatsApp recipient via Baileys socket
    if (textContent && conversation.externalChatId) {
      setImmediate(() => {
        this.whatsappService
          .sendWhatsAppMessage(userId, conversation.externalChatId, textContent.trim())
          .catch((err) => this.logger.warn(`Failed to dispatch message via Baileys: ${err.message}`));
      });
    }

    // Broadcast message to WebSocket clients across user and account rooms
    this.eventsGateway.sendToUser(userId, 'chat.message.new', { chatId, message });
    this.eventsGateway.sendToUser(userId, 'message.new', { chatId, message });
    this.eventsGateway.sendToUser(userId, 'dashboard:updated', { chatId });
    this.eventsGateway.sendToAccount(account.id, 'chat.message.new', { chatId, message });
    this.eventsGateway.sendToAccount(account.id, 'message.new', { chatId, message });

    return message;
  }

  async getReplySuggestions(userId: string, chatId: string, messageId: string) {
    const account = await this.getAccount(userId);

    const message = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId: chatId,
        whatsappAccountId: account.id,
        userId,
      },
      include: {
        conversation: {
          include: {
            contact: {
              include: { aiProfile: true },
            },
          },
        },
        replySuggestionsAsSource: true,
      },
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    if (message.replySuggestionsAsSource.length > 0) {
      return { suggestions: message.replySuggestionsAsSource };
    }

    // Fetch recent messages for context
    const recentMessages = await this.prisma.message.findMany({
      where: { conversationId: chatId, whatsappAccountId: account.id, userId },
      orderBy: { messageTimestamp: 'desc' },
      take: 6,
    });

    const history = recentMessages.reverse().map((m) => ({
      sender: m.isFromMe ? 'Me' : message.conversation.contact?.displayName || 'Contact',
      text: m.textContent || '',
    }));

    const suggestions = await this.aiService.generateReplySuggestions(
      message.textContent || '',
      message.conversation.contact?.displayName || 'Contact',
      history,
      message.conversation.contact?.aiProfile
    );

    // Persist suggestions in database
    const createdSuggestions = [];
    for (const s of suggestions) {
      const created = await this.prisma.aIReplySuggestion.create({
        data: {
          userId,
          whatsappAccountId: account.id,
          conversationId: chatId,
          sourceMessageId: message.id,
          suggestion: s.text,
          tone: s.tone.toLowerCase(),
          confidence: s.confidence,
        },
      });
      createdSuggestions.push(created);
    }

    return { suggestions: createdSuggestions };
  }
}
