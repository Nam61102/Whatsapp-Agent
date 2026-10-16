import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ChatsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getAccount(userId: string) {
    let account = await this.prisma.whatsAppAccount.findFirst({
      where: { userId },
    });
    if (!account) {
      account = await this.prisma.whatsAppAccount.create({
        data: {
          userId,
          status: 'DISCONNECTED',
          displayName: 'Primary WhatsApp',
          provider: 'BAILEYS',
        },
      });
    }
    return account;
  }

  async getChats(userId: string, search?: string, limit: number = 50, offset: number = 0) {
    const account = await this.getAccount(userId);

    const whereClause: any = {
      userId,
      whatsappAccountId: account.id,
      NOT: [{ externalChatId: 'status@broadcast' }],
      lastMessageAt: { not: null },
    };

    if (search) {
      whereClause.AND = [
        {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { lastMessageText: { contains: search, mode: 'insensitive' } },
            {
              contact: {
                OR: [
                  { displayName: { contains: search, mode: 'insensitive' } },
                  { pushName: { contains: search, mode: 'insensitive' } },
                  { phoneNumber: { contains: search } },
                ],
              },
            },
          ],
        },
      ];
    }

    const conversations = await this.prisma.conversation.findMany({
      where: whereClause,
      include: {
        contact: {
          select: {
            id: true,
            displayName: true,
            pushName: true,
            verifiedName: true,
            phoneNumber: true,
            profilePhotoUrl: true,
            about: true,
            isBusiness: true,
            isSavedContact: true,
            lid: true,
            lastSeenAt: true,
          },
        },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
      skip: offset,
    });

    // The preview and time come from the real latest message, so the list always matches what is
    // inside the chat. The copy saved on the conversation can lag behind (history sync, retention).
    const latest = await Promise.all(
      conversations.map((c) =>
        this.prisma.message.findFirst({
          where: { conversationId: c.id },
          orderBy: { messageTimestamp: 'desc' },
          select: {
            textContent: true,
            messageType: true,
            messageTimestamp: true,
            isFromMe: true,
            metadata: true,
            senderContact: { select: { displayName: true, pushName: true } },
          },
        })
      )
    );
    const withLatest = conversations.map((c, i) => {
      const m = latest[i];
      if (!m) return c;
      const isGroup = c.chatType === 'GROUP' || c.externalChatId?.endsWith('@g.us');
      const who = (m.metadata as any)?.senderName || m.senderContact?.displayName || m.senderContact?.pushName;
      const body = m.textContent && m.textContent.trim() ? m.textContent : '[Message]';
      return {
        ...c,
        lastMessageText: isGroup && !m.isFromMe && who ? `${who}: ${body}` : body,
        lastMessageAt: m.messageTimestamp,
      };
    });

    const total = await this.prisma.conversation.count({ where: whereClause });

    return { conversations: withLatest, total, limit, offset };
  }

  async getChatById(userId: string, chatId: string) {
    const account = await this.getAccount(userId);

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: chatId,
        whatsappAccountId: account.id,
        userId,
      },
      include: {
        contact: {
          include: {
            aiProfile: true,
          },
        },
      },
    });

    if (!conversation || conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }

    return conversation;
  }

  async markAsRead(userId: string, chatId: string) {
    const account = await this.getAccount(userId);

    const updated = await this.prisma.conversation.updateMany({
      where: {
        id: chatId,
        whatsappAccountId: account.id,
        userId,
      },
      data: {
        unreadCount: 0,
      },
    });

    return { success: true, count: updated.count };
  }
}
