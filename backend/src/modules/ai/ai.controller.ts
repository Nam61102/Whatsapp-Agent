import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  UseGuards,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AIService } from './ai.service';
import { AIQueueService } from './ai-queue.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { findChatMessagesForContact } from '../../shared/contact-resolver';
import { accountCache } from '../../shared/ttl-cache';

/** Bump when the profile format changes; older saved profiles are rebuilt. */
const PROFILE_VERSION = 'v3-multilingual';

@ApiTags('AI')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/ai')
@UseGuards(JwtAuthGuard)
export class AIController {
  constructor(
    private readonly aiService: AIService,
    private readonly aiQueueService: AIQueueService,
    private readonly prisma: PrismaService
  ) {}

  private async getAccount(userId: string) {
    const account = await accountCache.getOrLoad(userId, () => this.prisma.whatsAppAccount.findFirst({ where: { userId } }));
    if (!account) {
      throw new NotFoundException('No WhatsApp account connected for this user');
    }
    return account;
  }

  @Get('dashboard')
  @ApiOperation({
    summary: 'Get AI dashboard intelligence overview',
    description: 'Retrieves categorized AI insights including key highlights, trending topics, urgent action items, upcoming birthdays, and meetings.',
  })
  @ApiResponse({
    status: 200,
    description: 'AI dashboard overview data.',
    schema: {
      example: {
        summary: 'You have 3 upcoming meetings this week and 1 birthday tomorrow.',
        highlights: [
          { title: 'Project Kickoff', date: '2026-09-29T10:00:00.000Z', contact: 'Alex' },
        ],
        actionItems: [
          { task: 'Send quarterly deck by Friday', contact: 'Namrata', priority: 'HIGH' },
        ],
        stats: {
          analyzedMessages: 1250,
          activeMemories: 24,
        },
      },
    },
  })
  async getDashboard(@Req() req: any) {
    const account = await this.getAccount(req.user.id);
    return this.aiService.getDashboardOverview(req.user.id, account.id);
  }

  @Get('token-usage')
  @ApiOperation({
    summary: 'Get Gemini AI token consumption metrics',
    description: 'Returns real-time token counts, prompt/response token usage, and daily limits for the Google Gemini 2.5 Flash model.',
  })
  @ApiResponse({
    status: 200,
    description: 'Token usage metrics.',
    schema: {
      example: {
        totalTokens: 48200,
        promptTokens: 38100,
        candidateTokens: 10100,
        dailyLimit: 1000000,
        remainingTokens: 951800,
      },
    },
  })
  async getTokenUsage(@Req() req: any) {
    const account = await this.getAccount(req.user.id);
    return this.aiService.getTokenUsageStats(req.user.id, account.id);
  }

  @Post('chats/:chatId/reply-suggestions')
  @ApiOperation({
    summary: 'Generate contextual AI reply suggestions for a chat',
    description: 'Analyzes recent conversation history with Gemini 2.5 Flash and returns 3 personalized reply options (casual, professional, friendly).',
  })
  @ApiParam({ name: 'chatId', description: 'Conversation database ID or WhatsApp JID' })
  @ApiResponse({
    status: 200,
    description: 'Generated reply suggestions.',
    schema: {
      example: {
        suggestions: [
          { text: 'Sounds great, see you at 4 PM!', tone: 'casual', confidence: 0.95 },
          { text: 'Confirmed. I will have the report ready.', tone: 'professional', confidence: 0.92 },
          { text: 'Looking forward to it! 😊', tone: 'friendly', confidence: 0.88 },
        ],
      },
    },
  })
  async getReplySuggestions(@Req() req: any, @Param('chatId') chatId: string) {
    const account = await this.getAccount(req.user.id);
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: chatId,
        whatsappAccountId: account.id,
        userId: req.user.id,
      },
      include: {
        contact: true,
        messages: {
          orderBy: { messageTimestamp: 'desc' },
          take: 10,
        },
      },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const lastMessage = conversation.messages[0];
    // Nothing to answer when the last message is the user's own.
    if (!lastMessage || !lastMessage.textContent || lastMessage.isFromMe) {
      return { suggestions: [] };
    }

    // A reply the analysis job already prepared is reused instead of calling the model again.
    const stored = await this.prisma.aIReplySuggestion.findFirst({
      where: { sourceMessageId: lastMessage.id, userId: req.user.id },
    });
    if (stored) {
      return {
        suggestions: [{ text: stored.suggestion, tone: stored.tone, language: stored.language || 'en', confidence: stored.confidence }],
      };
    }

    const history = conversation.messages
      .reverse()
      .map((m) => ({
        sender: m.isFromMe ? 'Me' : conversation.contact?.displayName || 'Contact',
        text: m.textContent || '',
      }));

    const isGroup = conversation.chatType === 'GROUP' || conversation.externalChatId?.includes('@g.us');
    const groupName = isGroup ? (conversation.title || conversation.contact?.displayName || null) : null;
    const senderName = isGroup ? 'Group member' : (conversation.contact?.displayName || 'Contact');

    const suggestionsRes = await this.aiService.generateReplySuggestionsWithTokens(
      lastMessage.textContent,
      senderName,
      groupName,
      req.user?.name || 'User',
      history
    );

    // Not saved on purpose: these are only for the chat screen. Saving them would put every chat
    // the user opens into the dashboard's "Reply Needed" list. Only important messages get a saved
    // reply, and that is done by the analysis job.
    return { suggestions: suggestionsRes.items || [] };
  }

  @Get('action-center')
  @ApiOperation({
    summary: 'List saved Action Center items',
    description:
      'Saved, important items only: REPLY_NEEDED, FOLLOW_UP (meeting, payment, task, appointment, travel, event) and BIRTHDAY. Items stay until dismissed or their date passes.',
  })
  @ApiQuery({ name: 'category', required: false, enum: ['ALL', 'REPLY_NEEDED', 'FOLLOW_UP', 'BIRTHDAY'] })
  @ApiQuery({ name: 'limit', required: false, example: '50' })
  @ApiQuery({ name: 'offset', required: false, example: '0' })
  async getActionCenter(
    @Req() req: any,
    @Query('category') category: string = 'ALL',
    @Query('limit') limit: string = '50',
    @Query('offset') offset: string = '0'
  ) {
    const account = await this.getAccount(req.user.id);
    const take = Math.min(200, parseInt(limit, 10) || 50);
    const skip = parseInt(offset, 10) || 0;
    const items = await this.aiService.getActionCenterItems(req.user.id, account.id, take + skip, category);
    return { items: items.slice(skip, skip + take), total: items.length, limit: take, offset: skip };
  }

  @Get('chats/:chatId/reply-suggestions')
  @ApiOperation({
    summary: 'Get saved reply suggestions for a chat',
    description: 'Returns the stored, unused reply suggestions. Does not call the AI model.',
  })
  @ApiParam({ name: 'chatId', description: 'Conversation database ID' })
  async getSavedReplySuggestions(@Req() req: any, @Param('chatId') chatId: string) {
    const account = await this.getAccount(req.user.id);
    const suggestions = await this.prisma.aIReplySuggestion.findMany({
      where: { conversationId: chatId, userId: req.user.id, whatsappAccountId: account.id, isUsed: false },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    return { suggestions };
  }

  @Post('reply-suggestions/:id/use')
  @ApiOperation({
    summary: 'Mark a reply suggestion as used',
    description: 'Call after the user sends or edits-and-sends the suggested reply, so it leaves the Action Center.',
  })
  @ApiParam({ name: 'id', description: 'Reply suggestion database ID' })
  async markSuggestionUsed(@Req() req: any, @Param('id') id: string) {
    const account = await this.getAccount(req.user.id);
    const result = await this.prisma.aIReplySuggestion.updateMany({
      where: { id, userId: req.user.id, whatsappAccountId: account.id },
      data: { isUsed: true, usedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Reply suggestion not found');
    return { success: true };
  }

  @Post('analyze-recent')
  @ApiOperation({
    summary: 'Analyse recent messages now',
    description:
      'Queues AI analysis for recent incoming messages that have a real signal (birthday, amount, or an event with a date/time). Ads and casual chat are skipped. Capped per call.',
  })
  @ApiQuery({ name: 'hours', required: false, example: '24' })
  @ApiQuery({ name: 'max', required: false, example: '60' })
  async analyzeRecent(@Req() req: any, @Query('hours') hours: string = '24', @Query('max') max: string = '60') {
    await this.aiQueueService.processUnprocessedMessagesOnAIEnable(req.user.id, {
      maxAgeHours: Math.min(168, Math.max(1, parseInt(hours, 10) || 24)),
      maxMessages: Math.min(200, Math.max(1, parseInt(max, 10) || 60)),
    });
    return { success: true };
  }

  @Get('jobs')
  @ApiOperation({
    summary: 'List AI processing jobs',
    description: 'Shows where analysis failed: status, failed stage, error category, attempts and next retry time.',
  })
  @ApiQuery({ name: 'status', required: false, example: 'FAILED' })
  @ApiQuery({ name: 'limit', required: false, example: '50' })
  async listJobs(@Req() req: any, @Query('status') status?: string, @Query('limit') limit: string = '50') {
    const jobs = await this.prisma.aIProcessingJob.findMany({
      where: { userId: req.user.id, ...(status ? { status: { in: status.split(',').map((s) => s.trim().toUpperCase()) } } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(200, parseInt(limit, 10) || 50),
    });
    return { jobs };
  }

  @Post('jobs/:id/retry')
  @ApiOperation({ summary: 'Retry a failed AI job', description: 'Resets attempts and queues the job again. Already saved items are not duplicated.' })
  @ApiParam({ name: 'id', description: 'AI processing job ID' })
  async retryJob(@Req() req: any, @Param('id') id: string) {
    const ok = await this.aiQueueService.retryJob(req.user.id, id);
    if (!ok) throw new NotFoundException('Job not found');
    return { success: true };
  }

  @Post('messages/:messageId/reanalyze')
  @ApiOperation({ summary: 'Run AI analysis again for one message' })
  @ApiParam({ name: 'messageId', description: 'Message database ID' })
  async reanalyzeMessage(@Req() req: any, @Param('messageId') messageId: string) {
    const ok = await this.aiQueueService.reanalyzeMessage(req.user.id, messageId);
    if (!ok) throw new NotFoundException('Message not found');
    return { success: true };
  }

  @Get('contacts/:contactId/profile')
  @ApiOperation({
    summary: 'Get or generate AI persona profile for a contact',
    description: 'Extracts communication style, preferred languages, frequently discussed topics, interests, and key events for a contact.',
  })
  @ApiParam({ name: 'contactId', description: 'Contact database ID' })
  @ApiResponse({
    status: 200,
    description: 'Contact AI persona profile.',
    schema: {
      example: {
        id: '6ab1095895fe47010c283e30',
        summary: 'Close friend and colleague. Frequent discussions on tech and travel.',
        likes: ['Coffee', 'Weekend hikes', 'Startups'],
        dislikes: ['Late meetings'],
        interests: ['React Native', 'AI tools'],
        communicationStyle: { tone: 'Casual', emojiUsage: 'Moderate', languages: ['English', 'Hindi'] },
        frequentlyDiscussedTopics: ['Sprint planning', 'Design review'],
        confidence: 0.92,
      },
    },
  })
  async getContactProfile(@Req() req: any, @Param('contactId') contactId: string) {
    const account = await this.getAccount(req.user.id);
    const contact = await this.prisma.contact.findFirst({
      where: {
        id: contactId,
        whatsappAccountId: account.id,
        userId: req.user.id,
      },
      include: { aiProfile: true },
    });

    if (!contact) {
      throw new NotFoundException('Contact not found');
    }

    // Latest real chat messages with this contact (phone or LID link only, oldest first)
    const messages = await findChatMessagesForContact(this.prisma, req.user.id, account.id, contact, 300);

    if (messages.length === 0) {
      return {
        status: 'NO_DATA',
        message: 'No chat messages with this contact yet, so there is nothing to analyse.',
      };
    }

    const latestMessageId = messages[messages.length - 1].id;
    // Profiles saved by the old format (summary, style, topics) are rebuilt as likes/dislikes.
    if (contact.aiProfile && contact.aiProfile.version === PROFILE_VERSION && contact.aiProfile.lastAnalyzedMessageId === latestMessageId) {
      return contact.aiProfile;
    }

    let generated: any;
    try {
      generated = await this.aiService.generateContactProfile(
        contact.displayName,
        messages.map((m) => ({ isFromMe: m.isFromMe, text: m.textContent || '' }))
      );
    } catch (err: any) {
      throw new ServiceUnavailableException('AI analysis could not be generated right now. Please try again.');
    }

    const data = {
      // Only likes and dislikes are kept now; the other fields stay empty.
      summary: '',
      likes: generated.likes,
      dislikes: generated.dislikes,
      interests: [],
      communicationStyle: {},
      frequentlyDiscussedTopics: [],
      importantEvents: [],
      confidence: generated.confidence,
      sourceMessageCount: messages.length,
      lastAnalyzedMessageId: latestMessageId,
      lastAnalyzedAt: new Date(),
      version: PROFILE_VERSION,
    };

    if (contact.aiProfile) {
      return this.prisma.contactAIProfile.update({ where: { id: contact.aiProfile.id }, data });
    }
    return this.prisma.contactAIProfile.create({
      data: { userId: req.user.id, whatsappAccountId: account.id, contactId: contact.id, ...data },
    });
  }
}
