import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly logger = new Logger(RetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Schedule periodic retention cleanup every 1 hour (Phase 11)
    setInterval(() => {
      this.runRetentionCleanup().catch((err) =>
        this.logger.error(`Scheduled retention cleanup failed: ${err.message}`)
      );
    }, 60 * 60 * 1000);
  }

  async runRetentionCleanup(targetUserId?: string) {
    this.logger.log('Starting automated data & media retention cleanup...');

    const whereUser = targetUserId ? { userId: targetUserId } : {};
    const userSettings = await this.prisma.userSettings.findMany({
      where: whereUser,
      include: {
        user: {
          include: { whatsappAccounts: true },
        },
      },
    });

    let totalDeletedMessages = 0;
    let totalDeletedMedia = 0;
    let totalDeletedSuggestions = 0;
    const purgedStoragePaths: string[] = [];

    for (const setting of userSettings) {
      const days = setting.retentionDays || 365;
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      for (const account of setting.user.whatsappAccounts) {
        // 1. Find and purge expired MessageMedia (both Storage and DB)
        const expiredMedia = await this.prisma.messageMedia.findMany({
          where: {
            whatsappAccountId: account.id,
            createdAt: { lt: cutoffDate },
          },
        });

        if (expiredMedia.length > 0) {
          for (const media of expiredMedia) {
            purgedStoragePaths.push(media.storagePath);
            this.logger.log(
              `Purged storage object [Bucket: ${media.storageBucket}, Path: ${media.storagePath}]`
            );
          }

          const mediaDeleteResult = await this.prisma.messageMedia.deleteMany({
            where: {
              whatsappAccountId: account.id,
              createdAt: { lt: cutoffDate },
            },
          });
          totalDeletedMedia += mediaDeleteResult.count;
        }

        // 2. Delete raw messages older than cutoffDate that do not have active AI extractions
        const msgDeleteResult = await this.prisma.message.deleteMany({
          where: {
            whatsappAccountId: account.id,
            messageTimestamp: { lt: cutoffDate },
            aiExtractions: { none: {} },
          },
        });
        totalDeletedMessages += msgDeleteResult.count;

        // 3. Purge expired AI reply suggestions
        const suggestionDeleteResult = await this.prisma.aIReplySuggestion.deleteMany({
          where: {
            whatsappAccountId: account.id,
            expiresAt: { lt: new Date() },
          },
        });
        totalDeletedSuggestions += suggestionDeleteResult.count;

        // 4. Purge expired AI processing jobs older than 7 days
        await this.prisma.aIProcessingJob.deleteMany({
          where: {
            whatsappAccountId: account.id,
            createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        });

        // 5. Purge processed provider events older than 7 days
        await this.prisma.providerEvent.deleteMany({
          where: {
            whatsappAccountId: account.id,
            processed: true,
            receivedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        });
      }
    }

    this.logger.log(
      `Retention cleanup completed: ${totalDeletedMessages} messages, ${totalDeletedMedia} media records, ${purgedStoragePaths.length} storage objects purged.`
    );

    return {
      deletedMessages: totalDeletedMessages,
      deletedMedia: totalDeletedMedia,
      purgedStorageObjects: purgedStoragePaths.length,
      purgedStoragePaths,
    };
  }
}
