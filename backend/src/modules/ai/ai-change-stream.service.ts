import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { MongoClient, ChangeStream } from 'mongodb';
import { AIQueueService } from './ai-queue.service';
import { AIService } from './ai.service';
import { EventsGateway } from '../gateway/events.gateway';

@Injectable()
export class AIChangeStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AIChangeStreamService.name);
  private mongoClient: MongoClient | null = null;
  private changeStream: ChangeStream | null = null;
  private isRunning = false;

  constructor(
    private readonly aiQueueService: AIQueueService,
    @Inject(forwardRef(() => AIService))
    private readonly aiService: AIService,
    private readonly eventsGateway: EventsGateway
  ) {}

  async onModuleInit() {
    this.startChangeStream().catch((err) => {
      this.logger.warn(`Initial MongoDB Change Stream startup warning: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    this.stopChangeStream();
  }

  private async startChangeStream() {
    if (this.isRunning) return;

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      this.logger.error('DATABASE_URL is missing. Cannot start MongoDB Change Stream.');
      return;
    }

    try {
      this.mongoClient = new MongoClient(databaseUrl);
      await this.mongoClient.connect();
      const db = this.mongoClient.db();

      this.logger.log('Connected to MongoDB for Realtime Message Change Stream monitoring.');
      this.isRunning = true;

      // Watch "messages" collection for INSERT operations
      this.changeStream = db.collection('messages').watch(
        [
          {
            $match: {
              operationType: 'insert',
            },
          },
        ],
        { fullDocument: 'updateLookup' }
      );

      this.changeStream.on('change', async (change: any) => {
        try {
          const doc = change.fullDocument;
          if (!doc || !doc._id) return;

          const messageId = doc._id.toString();
          const userId = doc.userId ? doc.userId.toString() : '';
          const whatsappAccountId = doc.whatsappAccountId ? doc.whatsappAccountId.toString() : '';
          const conversationId = doc.conversationId ? doc.conversationId.toString() : '';
          const textContent = doc.textContent || '';
          const isFromMe = Boolean(doc.isFromMe);

          // Only process valid text messages
          if (!userId || !whatsappAccountId || !conversationId) return;

          // If message is sent by ME (user replied), dismiss action items for this conversation!
          if (isFromMe) {
            const repliedAt = doc.messageTimestamp ? new Date(doc.messageTimestamp) : new Date();
            await this.aiService.dismissActionItemsForConversation(conversationId, repliedAt);
            // A live reply typed on the phone answers what was waiting. History sync is not a reply.
            if (Date.now() - repliedAt.getTime() < 10 * 60 * 1000) {
              await this.aiService.resolveRepliedItems(userId, conversationId, repliedAt);
            }
            this.eventsGateway.sendToUser(userId, 'dashboard:updated', { conversationId });
            this.logger.log(`[CHANGE_STREAM] Outgoing message inserted: Dismissed action items for conversation ${conversationId}`);
            // Own messages are still read for commitments and plans, but only live ones (not history).
            if (Date.now() - repliedAt.getTime() > 10 * 60 * 1000 || !textContent.trim()) return;
          }

          // History sync inserts thousands of old messages at once; those are not realtime.
          // (Turning AI on handles recent history separately.)
          const sentAt = doc.messageTimestamp ? new Date(doc.messageTimestamp).getTime() : Date.now();
          if (Date.now() - sentAt > 10 * 60 * 1000) return;

          // Check if AI Analysis is enabled for user before enqueueing
          const userSettings = await this.aiQueueService.getUserSettings(userId);
          if (!userSettings || !userSettings.autoAIAnalysis) {
            this.logger.debug(
              `[CHANGE_STREAM] New message inserted: ${messageId}, but AI Analysis is disabled for user ${userId}. Skipping.`
            );
            return;
          }

          this.logger.log(
            `[CHANGE_STREAM] New incoming message inserted: ${messageId}. Enqueueing AI processing...`
          );

          // Enqueue with HIGH priority (1) for realtime AI processing
          await this.aiQueueService.enqueueMessageJob({
            messageId,
            conversationId,
            whatsappAccountId,
            userId,
            jobType: 'MESSAGE_ANALYSIS',
            priority: 1,
          });
        } catch (err: any) {
          this.logger.error(`Error handling Change Stream event: ${err.message}`);
        }
      });

      this.changeStream.on('error', (err: any) => {
        this.logger.warn(`MongoDB Change Stream error: ${err.message}. Attempting reconnect...`);
        this.stopChangeStream();
        setTimeout(() => this.startChangeStream(), 5000);
      });
    } catch (err: any) {
      this.logger.error(`Failed to start MongoDB Change Stream: ${err.message}`);
      this.isRunning = false;
    }
  }

  private stopChangeStream() {
    this.isRunning = false;
    if (this.changeStream) {
      try {
        this.changeStream.close();
      } catch {}
      this.changeStream = null;
    }
    if (this.mongoClient) {
      try {
        this.mongoClient.close();
      } catch {}
      this.mongoClient = null;
    }
  }
}
