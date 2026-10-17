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

  /** Newest message of each given chat, in a single database round trip. */
  async latestMessages(
    chatIds: string[]
  ): Promise<Map<string, { text: string | null; at: Date; isFromMe: boolean; sender: string | null }>> {
    const out = new Map<string, { text: string | null; at: Date; isFromMe: boolean; sender: string | null }>();
    if (chatIds.length === 0) return out;
    const res: any = await this.prisma.$runCommandRaw({
      aggregate: 'messages',
      pipeline: [
        { $match: { conversationId: { $in: chatIds.map((id) => ({ $oid: id })) } } },
        { $sort: { messageTimestamp: -1 } },
        {
          $group: {
            _id: '$conversationId',
            text: { $first: '$textContent' },
            at: { $first: '$messageTimestamp' },
            isFromMe: { $first: '$isFromMe' },
            sender: { $first: '$metadata.senderName' },
          },
        },
      ],
      cursor: {},
    });
    for (const r of res?.cursor?.firstBatch ?? []) {
      const id = r._id?.$oid ?? String(r._id);
      const at = new Date(r.at?.$date ?? r.at);
      if (Number.isNaN(at.getTime())) continue;
      out.set(id, { text: r.text ?? null, at, isFromMe: Boolean(r.isFromMe), sender: r.sender ?? null });
    }
    return out;
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
    // One query for all chats on the page, and the total is counted at the same time.
    const [latestByChat, total] = await Promise.all([
      this.latestMessages(conversations.map((c) => c.id)),
      this.prisma.conversation.count({ where: whereClause }),
    ]);
    const withLatest = conversations.map((c) => {
      const m = latestByChat.get(c.id);
      if (!m) return c;
      const isGroup = c.chatType === 'GROUP' || c.externalChatId?.endsWith('@g.us');
      const body = m.text && m.text.trim() ? m.text : '[Message]';
      return {
        ...c,
        lastMessageText: isGroup && !m.isFromMe && m.sender ? `${m.sender}: ${body}` : body,
        lastMessageAt: m.at,
      };
    });

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
