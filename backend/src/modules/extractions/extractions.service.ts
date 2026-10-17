import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AIService } from '../ai/ai.service';
import { ALL_STATUSES, PRIORITIES } from '../ai/ai-extraction.types';
import { accountCache } from '../../shared/ttl-cache';

@Injectable()
export class ExtractionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AIService
  ) {}

  private async getAccount(userId: string) {
    const account = await accountCache.getOrLoad(userId, () => this.prisma.whatsAppAccount.findFirst({ where: { userId } }));
    if (!account) {
      throw new NotFoundException('WhatsApp account not found');
    }
    return account;
  }

  async getExtractions(
    userId: string,
    type?: string,
    status: string = 'ACTIVE',
    limit: number = 50,
    offset: number = 0
  ) {
    const account = await this.getAccount(userId);
    const categoryFilter = type || 'ALL';

    const actionItems = await this.aiService.getActionCenterItems(
      userId,
      account.id,
      limit + offset,
      categoryFilter
    );

    const paginated = actionItems.slice(offset, offset + limit);

    return {
      extractions: paginated,
      total: actionItems.length,
      limit,
      offset,
    };
  }

  async getExtractionById(userId: string, id: string) {
    const account = await this.getAccount(userId);

    const extraction = await this.prisma.aIExtraction.findUnique({
      where: { id },
      include: {
        contact: true,
        conversation: true,
        message: true,
        sources: true,
      },
    });

    if (!extraction || extraction.userId !== userId || extraction.whatsappAccountId !== account.id) {
      throw new NotFoundException('Extraction not found');
    }

    return extraction;
  }

  async updateStatus(userId: string, id: string, status: string) {
    const account = await this.getAccount(userId);

    if (!ALL_STATUSES.includes(status)) {
      throw new BadRequestException(`status must be one of ${ALL_STATUSES.join(', ')}`);
    }

    const extraction = await this.prisma.aIExtraction.findUnique({
      where: { id },
    });

    if (!extraction || extraction.userId !== userId || extraction.whatsappAccountId !== account.id) {
      throw new NotFoundException('Extraction not found');
    }

    const updated = await this.prisma.aIExtraction.update({
      where: { id },
      data: { status },
    });

    return updated;
  }

  async dismissItem(userId: string, id: string, category?: string) {
    const account = await this.getAccount(userId);

    if (category === 'REPLY_NEEDED') {
      await this.prisma.aIReplySuggestion.updateMany({
        where: { id, userId, whatsappAccountId: account.id },
        data: { isUsed: true, usedAt: new Date() },
      });
    } else {
      await this.prisma.aIExtraction.updateMany({
        where: { id, userId, whatsappAccountId: account.id },
        data: { status: 'DISMISSED' },
      });
    }

    return { success: true, message: 'Action item dismissed successfully' };
  }

  /**
   * Full, database-backed history of extractions with filters and stable pagination.
   * Nothing here depends on frontend state; closed items stay queryable.
   */
  async getHistory(
    userId: string,
    filters: {
      status?: string;
      type?: string;
      priority?: string;
      contactId?: string;
      conversationId?: string;
      search?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    }
  ) {
    const account = await this.getAccount(userId);
    const limit = Math.min(100, Math.max(1, filters.limit || 30));
    const offset = Math.max(0, filters.offset || 0);

    const where: any = { userId, whatsappAccountId: account.id };
    const statuses = (filters.status || 'ALL').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!statuses.includes('ALL')) {
      const bad = statuses.filter((x) => !ALL_STATUSES.includes(x));
      if (bad.length) throw new BadRequestException(`Unknown status: ${bad.join(', ')}`);
      where.status = { in: statuses };
    }
    if (filters.type && filters.type !== 'ALL') {
      where.extractionType = { in: filters.type.split(',').map((x) => x.trim().toUpperCase()) };
    }
    if (filters.priority && filters.priority !== 'ALL') {
      const priorities = filters.priority.split(',').map((x) => x.trim().toUpperCase());
      if (priorities.some((x) => !(PRIORITIES as readonly string[]).includes(x))) {
        throw new BadRequestException(`priority must be one of ${PRIORITIES.join(', ')}`);
      }
      where.priority = { in: priorities };
    }
    if (filters.contactId) where.contactId = filters.contactId;
    if (filters.conversationId) where.conversationId = filters.conversationId;
    if (filters.from || filters.to) {
      const range: any = {};
      if (filters.from) range.gte = new Date(filters.from);
      if (filters.to) range.lte = new Date(filters.to);
      if (Object.values(range).some((d: any) => Number.isNaN(d.getTime()))) {
        throw new BadRequestException('from/to must be valid dates');
      }
      where.createdAt = range;
    }
    const q = filters.search?.trim();
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { summary: { contains: q, mode: 'insensitive' } },
        { supportingText: { contains: q, mode: 'insensitive' } },
        { contact: { is: { displayName: { contains: q, mode: 'insensitive' } } } },
        { contact: { is: { phoneNumber: { contains: q } } } },
      ];
    }

    const [total, rows] = await Promise.all([
      this.prisma.aIExtraction.count({ where }),
      this.prisma.aIExtraction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
        include: {
          contact: { select: { id: true, displayName: true, phoneNumber: true, profilePhotoUrl: true } },
          conversation: { select: { id: true, title: true, chatType: true } },
          message: { select: { id: true, textContent: true, messageTimestamp: true } },
        },
      }),
    ]);

    return { items: rows, total, limit, offset, hasMore: offset + rows.length < total };
  }

  /** User edits. Every change is saved and recorded in the history of the item. */
  async updateItem(
    userId: string,
    id: string,
    body: { title?: string; description?: string; priority?: string; dueAt?: string | null; notes?: string | null; status?: string }
  ) {
    const account = await this.getAccount(userId);
    const existing = await this.prisma.aIExtraction.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId || existing.whatsappAccountId !== account.id) {
      throw new NotFoundException('Extraction not found');
    }

    const data: any = {};
    if (body.title !== undefined) {
      if (!body.title.trim()) throw new BadRequestException('title cannot be empty');
      data.title = body.title.trim().slice(0, 120);
    }
    if (body.description !== undefined) {
      data.description = body.description.slice(0, 1000);
      data.summary = data.description;
    }
    if (body.priority !== undefined) {
      const p = body.priority.toUpperCase();
      if (!(PRIORITIES as readonly string[]).includes(p)) {
        throw new BadRequestException(`priority must be one of ${PRIORITIES.join(', ')}`);
      }
      data.priority = p;
    }
    if (body.dueAt !== undefined) {
      if (body.dueAt === null) {
        data.eventDate = null;
      } else {
        const d = new Date(body.dueAt);
        if (Number.isNaN(d.getTime())) throw new BadRequestException('dueAt must be a valid date');
        data.eventDate = d;
      }
    }
    if (body.notes !== undefined) data.notes = body.notes === null ? null : body.notes.slice(0, 2000);
    if (body.status !== undefined) {
      if (!ALL_STATUSES.includes(body.status)) {
        throw new BadRequestException(`status must be one of ${ALL_STATUSES.join(', ')}`);
      }
      data.status = body.status;
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('Nothing to update');

    const history: any[] = Array.isArray(existing.history) ? (existing.history as any[]) : [];
    data.history = [...history, { at: new Date().toISOString(), action: 'USER_EDIT', changes: Object.keys(data) }];

    return this.prisma.aIExtraction.update({ where: { id }, data });
  }
}
