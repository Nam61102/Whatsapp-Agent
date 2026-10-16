import {
  Body,
  Controller,
  Get,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SettingsService, UpdateSettingsDto } from './settings.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('Settings')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get user settings and retention configuration',
    description: 'Fetches active message retention period, AI feature flags, token limits, and notification preferences.',
  })
  @ApiResponse({
    status: 200,
    description: 'User settings details.',
    schema: {
      example: {
        retentionDays: 3,
        autoAIAnalysis: true,
        realtimeAI: true,
        aiReplySuggestions: true,
        aiExtractions: true,
        dailyTokenLimit: 1000000,
        notificationsEnabled: true,
      },
    },
  })
  async getSettings(@Req() req: any) {
    return this.settingsService.getSettings(req.user.id);
  }

  @Patch()
  @ApiOperation({
    summary: 'Update user settings and retention policies',
    description: 'Updates retention period in days, toggles AI features, updates token usage ceilings, and configures notifications.',
  })
  @ApiBody({ type: UpdateSettingsDto })
  @ApiResponse({
    status: 200,
    description: 'Settings successfully updated.',
    schema: {
      example: {
        retentionDays: 15,
        autoAIAnalysis: true,
        realtimeAI: true,
        aiReplySuggestions: true,
        aiExtractions: true,
        dailyTokenLimit: 1000000,
        notificationsEnabled: true,
      },
    },
  })
  async updateSettings(@Req() req: any, @Body() body: UpdateSettingsDto) {
    return this.settingsService.updateSettings(req.user.id, body);
  }
}
