import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AIService } from './ai.service';
import { TOKEN_LIMIT_ENFORCED } from './ai-extraction.types';
import { EventsGateway } from '../gateway/events.gateway';

/** Automatic revival (retries, lost queue entries) only for recent messages. */
const REVIVE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Jobs paused by the daily token limit may wait for the next day. */
const PAUSED_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export interface AIJobPayload {
  messageId: string;
  conversationId: string;
  whatsappAccountId: string;
  userId: string;
  jobType?: 'MESSAGE_ANALYSIS' | 'EXTRACTION' | 'REPLY_SUGGESTION';
  priority?: number; // 1 = HIGH (Realtime), 2 = NORMAL (Historical)
}

@Injectable()
export class AIQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AIQueueService.name);
  private isProcessing = false;
  private queue: AIJobPayload[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AIService,
    private readonly eventsGateway: EventsGateway
  ) {}

  private sweepTimer: NodeJS.Timeout | null = null;

  async onModuleInit() {
    // Resume any PENDING or RETRYING jobs from database on startup
    setTimeout(() => {
      this.sweepDueJobs().catch((err) => {
        this.logger.warn(`Job recovery failed: ${err.message}`);
      });
    }, 5000);

    // Retries are stored in the database; this loop is what actually runs them when they are due.
    this.sweepTimer = setInterval(() => {
      this.sweepDueJobs().catch((err) => this.logger.warn(`AI job sweep failed: ${err.message}`));
    }, 30 * 1000);
  }


  async scanAllUsersUnprocessed(): Promise<void> {
    const allSettings = await this.prisma.userSettings.findMany({
      where: { autoAIAnalysis: true },
      select: { userId: true },
    });
    for (const s of allSettings) {
      await this.processUnprocessedMessagesOnAIEnable(s.userId, { maxAgeHours: 72, maxMessages: 100 }).catch(() => {});
    }
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Re-queues jobs whose retry time has come, jobs stuck in PROCESSING, and jobs paused by the token limit. */
  async sweepDueJobs(): Promise<void> {
    const now = new Date();
    const due = await this.prisma.aIProcessingJob.findMany({
      where: {
        OR: [
          { status: 'RETRYING', nextRetryAt: { lte: now } },
          { status: 'QUEUED', updatedAt: { lte: new Date(Date.now() - 2 * 60 * 1000) } },
          { status: 'PROCESSING', updatedAt: { lte: new Date(Date.now() - 5 * 60 * 1000) } },
          // With no token cap nothing should stay paused; with a cap, wait before checking again.
          { status: 'PAUSED_TOKEN_LIMIT', updatedAt: { lte: new Date(Date.now() - (TOKEN_LIMIT_ENFORCED ? 10 * 60 * 1000 : 0)) } },
        ],
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
    if (due.length === 0) return;

    // Jobs for old messages (for example a history-sync flood) are not worth AI tokens.
    const messages = await this.prisma.message.findMany({
      where: { id: { in: due.map((j) => j.entityId) } },
      select: { id: true, messageTimestamp: true },
    });
    const sentAt = new Map(messages.map((m) => [m.id, m.messageTimestamp.getTime()]));
    const fresh: typeof due = [];
    const staleIds: string[] = [];
    for (const job of due) {
      const ts = sentAt.get(job.entityId);
      const maxAge = job.status === 'PAUSED_TOKEN_LIMIT' ? PAUSED_MAX_AGE_MS : REVIVE_MAX_AGE_MS;
      if (ts === undefined || Date.now() - ts > maxAge) staleIds.push(job.id);
      else fresh.push(job);
    }
    if (staleIds.length > 0) {
      await this.prisma.aIProcessingJob.updateMany({
        where: { id: { in: staleIds } },
        data: { status: 'SKIPPED', errorMessage: 'Source message is too old (or gone) for automatic processing' },
      });
      this.logger.log(`[AI_SWEEP] Skipped ${staleIds.length} stale jobs`);
    }

    let revived = 0;
    for (const job of fresh) {
      if (revived >= 20) break;
      if (this.queue.some((q) => q.messageId === job.entityId)) continue;
      if (job.status === 'PAUSED_TOKEN_LIMIT') {
        const settings = await this.getUserSettings(job.userId);
        if (!settings || !this.hasTokenBudget(settings)) continue;
      }
      await this.requeueJob(job);
      revived++;
    }
  }

  /** True when the user can spend tokens now. A new day counts: the counter resets when the job runs. */
  private hasTokenBudget(settings: { usedTokensToday: number; dailyTokenLimit: number; lastTokenResetDate: Date | null }): boolean {
    if (!TOKEN_LIMIT_ENFORCED) return true;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    if (settings.lastTokenResetDate && settings.lastTokenResetDate < startOfDay) return true;
    return settings.usedTokensToday < settings.dailyTokenLimit;
  }

  private async requeueJob(job: { id: string; entityId: string; userId: string; whatsappAccountId: string; jobType: string; priority: number }) {
    const message = await this.prisma.message.findUnique({
      where: { id: job.entityId },
      select: { id: true, conversationId: true, whatsappAccountId: true, userId: true },
    });
    if (!message) {
      await this.prisma.aIProcessingJob.update({
        where: { id: job.id },
        data: { status: 'SKIPPED', errorMessage: 'Source message deleted or expired' },
      });
      return;
    }
    await this.prisma.aIProcessingJob.update({ where: { id: job.id }, data: { status: 'QUEUED' } });
    this.queue.push({
      messageId: message.id,
      conversationId: message.conversationId,
      whatsappAccountId: message.whatsappAccountId,
      userId: message.userId,
      jobType: (job.jobType as any) || 'MESSAGE_ANALYSIS',
      priority: job.priority,
    });
    this.processNextJob();
  }

  /** Manual retry of a failed job: resets attempts and queues it again. */
  async retryJob(userId: string, jobId: string): Promise<boolean> {
    const job = await this.prisma.aIProcessingJob.findFirst({ where: { id: jobId, userId } });
    if (!job) return false;
    await this.prisma.aIProcessingJob.update({
      where: { id: job.id },
      data: { status: 'QUEUED', attempts: 0, errorMessage: null, errorCategory: null, failedStage: null, nextRetryAt: null },
    });
    await this.requeueJob(job);
    return true;
  }

  /** Re-run analysis for one message (creates the job if it never existed). Existing items are not duplicated. */
  async reanalyzeMessage(userId: string, messageId: string): Promise<boolean> {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, userId },
      select: { id: true, conversationId: true, whatsappAccountId: true, userId: true },
    });
    if (!message) return false;
    const idempotencyKey = `${message.whatsappAccountId}:${message.id}:MESSAGE_ANALYSIS`;
    const existing = await this.prisma.aIProcessingJob.findUnique({ where: { idempotencyKey } });
    if (existing) return this.retryJob(userId, existing.id);
    await this.enqueueMessageJob({ ...message, messageId: message.id, jobType: 'MESSAGE_ANALYSIS', priority: 1 });
    return true;
  }

  /**
   * Helper to retrieve user settings by userId or authUserId.
   */
  async getUserSettings(userId: string) {
    if (!userId) return null;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(userId);
    let realUserId = userId;
    if (!isObjectId) {
      const u = await this.prisma.user.findFirst({
        where: { OR: [{ id: userId }, { authUserId: userId }] },
        select: { id: true },
      });
      if (u) realUserId = u.id;
    }
    return this.prisma.userSettings.findUnique({ where: { userId: realUserId } });
  }

  /**
   * Enqueue a message for AI analysis asynchronously and safely.
   */
  async enqueueMessageJob(payload: AIJobPayload): Promise<void> {
    const jobType = payload.jobType || 'MESSAGE_ANALYSIS';
    const idempotencyKey = `${payload.whatsappAccountId}:${payload.messageId}:${jobType}`;

    try {
      // Check master AI switch
      const settings = await this.getUserSettings(payload.userId);
      if (!settings || !settings.autoAIAnalysis) {
        this.logger.debug(`[AI_QUEUE] autoAIAnalysis is OFF for user ${payload.userId}. Skipping job enqueue.`);
        return;
      }

      // 1. Check if job already completed or skipped
      const existingJob = await this.prisma.aIProcessingJob.findUnique({
        where: { idempotencyKey },
      });

      // A job skipped only because AI analysis was switched off is not final: when AI is on again
      // the message must be analysed. Other skips (noise, deleted message) stay final.
      if (existingJob?.status === 'SKIPPED' && existingJob.errorMessage?.startsWith('Automatic AI Analysis disabled')) {
        await this.prisma.aIProcessingJob.update({
          where: { id: existingJob.id },
          data: { status: 'QUEUED', attempts: 0, errorMessage: null },
        });
        existingJob.status = 'QUEUED';
      }

      if (existingJob && (existingJob.status === 'COMPLETED' || existingJob.status === 'SKIPPED')) {
        this.logger.debug(`[AI_QUEUE] Job ${idempotencyKey} already ${existingJob.status}. Skipping enqueue.`);
        return;
      }

      // 2. Create or update PENDING job in database
      if (!existingJob) {
        try {
          await this.prisma.aIProcessingJob.create({
            data: {
              userId: payload.userId,
              whatsappAccountId: payload.whatsappAccountId,
              idempotencyKey,
              jobType,
              entityType: 'message',
              entityId: payload.messageId,
              status: 'QUEUED',
              priority: payload.priority || 1,
            },
          });
        } catch (err: any) {
          // Another trigger (webhook or change stream) created the same job first: that is fine.
          if (err.code !== 'P2002') throw err;
        }
      }

      // 3. Add to in-memory priority queue
      const existingInQueue = this.queue.some(
        (q) => q.messageId === payload.messageId && (q.jobType || 'MESSAGE_ANALYSIS') === jobType
      );
      if (!existingInQueue) {
        if ((payload.priority || 1) === 1) {
          this.queue.unshift(payload); // HIGH priority at front
        } else {
          this.queue.push(payload); // NORMAL priority at end
        }
      }

      // 4. Trigger worker loop
      this.processNextJob();
    } catch (err: any) {
      this.logger.error(`Failed to enqueue AI job for message ${payload.messageId}: ${err.message}`);
    }
  }

  /**
   * Scans and enqueues unprocessed eligible messages within the user's configured retention period when AI is turned ON.
   */
  async processUnprocessedMessagesOnAIEnable(
    userId: string,
    opts: { maxAgeHours?: number; maxMessages?: number } = {}
  ): Promise<void> {
    const settings = await this.getUserSettings(userId);
    if (!settings || !settings.autoAIAnalysis) return;

    const retentionDays = settings.retentionDays || 3;
    const windowMs = Math.min(retentionDays * 24, opts.maxAgeHours ?? retentionDays * 24) * 60 * 60 * 1000;
    const cutoffDate = new Date(Date.now() - windowMs);

    const realUserId = settings.userId;

    this.logger.log(`[AI_ENABLE] Scanning unprocessed messages for user ${realUserId} within last ${retentionDays} days...`);

    const candidateMessages = await this.prisma.message.findMany({
      where: {
        userId: realUserId,
        messageTimestamp: { gte: cutoffDate },
        syncStatus: 'PROCESSED',
        aiStatus: { not: 'PROCESSED' },
        textContent: { not: null },
      },
      orderBy: { messageTimestamp: 'desc' },
      take: 5000,
    });
    const maxMessages = opts.maxMessages ?? 100;

    let enqueuedCount = 0;
    for (const msg of candidateMessages) {
      if (enqueuedCount >= maxMessages) break;
      // Bulk scans are strict: a birthday, an amount, or an event word with a date or time.
      if (
        msg.textContent &&
        this.aiService.isMessageEligibleForAI(msg.textContent) &&
        !this.aiService.looksPromotional(msg.textContent) &&
        this.aiService.hasStrongSignal(msg.textContent)
      ) {
        await this.enqueueMessageJob({
          messageId: msg.id,
          conversationId: msg.conversationId,
          whatsappAccountId: msg.whatsappAccountId,
          userId: realUserId,
          jobType: 'MESSAGE_ANALYSIS',
          priority: 2, // NORMAL priority
        });
        enqueuedCount++;
      }
    }

    this.logger.log(`[AI_ENABLE] Enqueued ${enqueuedCount} unprocessed eligible messages for user ${realUserId}.`);
  }

  /**
   * Worker loop to process queued AI jobs sequentially and asynchronously.
   */
  private async processNextJob(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const jobPayload = this.queue.shift()!;

    try {
      await this.aiService.processMessageAIJob(jobPayload);
    } catch (err: any) {
      this.logger.error(`Error executing AI job for message ${jobPayload.messageId}: ${err.message}`);
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        setTimeout(() => this.processNextJob(), 100);
      }
    }
  }
}
