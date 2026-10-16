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

    const total = await this.prisma.conversation.count({ where: whereClause });

    return { conversations, total, limit, offset };
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
