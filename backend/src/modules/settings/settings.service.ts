import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RetentionService } from '../retention/retention.service';
import { AIQueueService } from '../ai/ai-queue.service';

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional } from 'class-validator';

export class UpdateSettingsDto {
  @ApiPropertyOptional({ example: 3, description: 'Message retention duration in days (e.g. 3, 7, 15, 30, 60, 90). Default 3.' })
  @IsOptional()
  @IsNumber()
  retentionDays?: number;

  @ApiPropertyOptional({ example: true, description: 'Enable or disable automated AI intelligence pipeline' })
  @IsOptional()
  @IsBoolean()
  autoAIAnalysis?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Enable real-time AI processing' })
  @IsOptional()
  @IsBoolean()
  realtimeAI?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Enable 3-option contextual AI reply suggestions' })
  @IsOptional()
  @IsBoolean()
  aiReplySuggestions?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Enable entity and memory extractions' })
  @IsOptional()
  @IsBoolean()
  aiExtractions?: boolean;

  @ApiPropertyOptional({ example: 1000000, description: 'Daily Gemini API token consumption ceiling' })
  @IsOptional()
  @IsNumber()
  dailyTokenLimit?: number;

  @ApiPropertyOptional({ example: true, description: 'Enable push notifications and AI alerts' })
  @IsOptional()
  @IsBoolean()
  notificationsEnabled?: boolean;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly retentionService: RetentionService,
    @Inject(forwardRef(() => AIQueueService))
    private readonly aiQueueService: AIQueueService
  ) {}

  private async resolveUserId(userId: string): Promise<string> {
    if (!userId) return userId;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(userId);
    try {
      const user = await this.prisma.user.findFirst({
        where: isObjectId
          ? { OR: [{ id: userId }, { authUserId: userId }] }
          : { authUserId: userId },
        select: { id: true },
      });
      return user ? user.id : userId;
    } catch {
      return userId;
    }
  }

  async getSettings(userId: string) {
    const realUserId = await this.resolveUserId(userId);
    let settings = await this.prisma.userSettings.findUnique({
      where: { userId: realUserId },
    });

    if (!settings) {
      settings = await this.prisma.userSettings.create({
        data: {
          userId: realUserId,
          retentionDays: 365,
          autoAIAnalysis: true,
          realtimeAI: true,
          aiReplySuggestions: true,
          aiExtractions: true,
          dailyTokenLimit: 100000,
          notificationsEnabled: true,
        },
      });
    }

    return settings;
  }

  async updateSettings(userId: string, dto: UpdateSettingsDto) {
    const realUserId = await this.resolveUserId(userId);
    const existing = await this.getSettings(realUserId); // Ensure exists

    const updated = await this.prisma.userSettings.update({
      where: { userId: realUserId },
      data: {
        ...(dto.retentionDays !== undefined && { retentionDays: Number(dto.retentionDays) }),
        ...(dto.autoAIAnalysis !== undefined && { autoAIAnalysis: dto.autoAIAnalysis }),
        ...(dto.realtimeAI !== undefined && { realtimeAI: dto.realtimeAI }),
        ...(dto.aiReplySuggestions !== undefined && { aiReplySuggestions: dto.aiReplySuggestions }),
        ...(dto.aiExtractions !== undefined && { aiExtractions: dto.aiExtractions }),
        ...(dto.dailyTokenLimit !== undefined && { dailyTokenLimit: Number(dto.dailyTokenLimit) }),
        ...(dto.notificationsEnabled !== undefined && { notificationsEnabled: dto.notificationsEnabled }),
      },
    });

    // If retentionDays was updated, trigger retention cleanup immediately
    if (dto.retentionDays !== undefined) {
      this.retentionService.runRetentionCleanup(realUserId).catch(() => {});
    }

    // If autoAIAnalysis was toggled ON (from false to true), scan unprocessed retained messages
    if (dto.autoAIAnalysis === true && !existing.autoAIAnalysis) {
      this.aiQueueService.processUnprocessedMessagesOnAIEnable(realUserId).catch(() => {});
    }

    return updated;
  }
}
