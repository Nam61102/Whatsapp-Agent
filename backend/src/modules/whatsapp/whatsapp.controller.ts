import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { WhatsAppService } from './whatsapp.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class InitiateConnectDto {
  @ApiPropertyOptional({
    enum: ['QR', 'PAIRING_CODE'],
    default: 'QR',
    description: 'Connection authentication method (QR code or 8-digit phone pairing code)',
  })
  @IsOptional()
  @IsEnum(['QR', 'PAIRING_CODE'])
  method?: 'QR' | 'PAIRING_CODE';

  @ApiPropertyOptional({
    description: 'Force takeover and disconnect another active device session',
  })
  @IsOptional()
  forceTakeover?: boolean;
}

export class RequestPairingCodeDto {
  @ApiProperty({
    example: '+919876543210',
    description: 'Phone number in international E.164 format with country code',
  })
  @IsString()
  @IsNotEmpty()
  phoneNumber!: string;

  @ApiPropertyOptional({
    description: 'Force takeover and disconnect another active device session',
  })
  @IsOptional()
  forceTakeover?: boolean;
}

@ApiTags('WhatsApp')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/whatsapp')
@UseGuards(JwtAuthGuard)
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Get WhatsApp account connection status and statistics',
    description: 'Returns connection status, active QR code (if pending), phone number, synced contacts, groups and message counts.',
  })
  @ApiResponse({
    status: 200,
    description: 'WhatsApp account status details.',
  })
  async getStatus(@Req() req: any) {
    const clientSessionId = (req.headers['x-client-session-id'] as string) || undefined;
    return this.whatsappService.getStatus(req.user.id, clientSessionId);
  }

  @Get('sync-progress')
  @ApiOperation({
    summary: 'Get live WhatsApp data synchronization progress',
    description: 'Retrieves percentage progress, stage (CONTACTS, CHATS, MESSAGES, COMPLETED), and item counts for the active sync pipeline.',
  })
  @ApiResponse({
    status: 200,
    description: 'Synchronization progress status.',
  })
  async getSyncProgress(@Req() req: any) {
    return this.whatsappService.getSyncProgress(req.user.id);
  }

  @Post('connect')
  @ApiOperation({
    summary: 'Initiate WhatsApp connection',
    description: 'Initializes the Baileys socket session and generates a QR code Data URL or prepares pairing code state.',
  })
  @ApiBody({ type: InitiateConnectDto, required: false })
  @ApiResponse({
    status: 200,
    description: 'Connection initiated.',
  })
  async initiateConnect(@Req() req: any, @Body() body: InitiateConnectDto) {
    const clientSessionId = (req.headers['x-client-session-id'] as string) || undefined;
    const deviceInfo = (req.headers['x-device-info'] as string) || req.headers['user-agent'] || 'Web/Mobile Client';
    const clientIp = req.ip || req.connection?.remoteAddress;
    return this.whatsappService.initiateConnect(
      req.user.id,
      body?.method || 'QR',
      Boolean(body?.forceTakeover),
      clientSessionId,
      deviceInfo,
      clientIp
    );
  }

  @Post('pairing-code')
  @ApiOperation({
    summary: 'Request WhatsApp 8-digit pairing code',
    description: 'Requests an official WhatsApp linking pairing code for the provided international phone number.',
  })
  @ApiBody({ type: RequestPairingCodeDto })
  @ApiResponse({
    status: 200,
    description: 'Pairing code generated.',
  })
  async requestPairingCode(@Req() req: any, @Body() body: RequestPairingCodeDto) {
    const clientSessionId = (req.headers['x-client-session-id'] as string) || undefined;
    const deviceInfo = (req.headers['x-device-info'] as string) || req.headers['user-agent'] || 'Web/Mobile Client';
    const clientIp = req.ip || req.connection?.remoteAddress;
    return this.whatsappService.requestPairingCode(
      req.user.id,
      body?.phoneNumber,
      Boolean(body?.forceTakeover),
      clientSessionId,
      deviceInfo,
      clientIp
    );
  }

  @Post('disconnect-other')
  @ApiOperation({
    summary: 'Disconnect active session on another device and take over connection',
    description: 'Terminates active connection on another device and prepares this session for linking.',
  })
  async disconnectOther(@Req() req: any) {
    const clientSessionId = (req.headers['x-client-session-id'] as string) || undefined;
    const deviceInfo = (req.headers['x-device-info'] as string) || req.headers['user-agent'] || 'Web/Mobile Client';
    return this.whatsappService.disconnectOtherSession(req.user.id, clientSessionId, deviceInfo);
  }

  @Post('complete-connect')
  @ApiOperation({
    summary: 'Complete and confirm WhatsApp connection',
    description: 'Confirms authenticated session state and returns the current connection status.',
  })
  @ApiResponse({ status: 200, description: 'Updated account status.' })
  async completeConnect(@Req() req: any) {
    return this.whatsappService.getStatus(req.user.id);
  }

  @Post('sync')
  @ApiOperation({
    summary: 'Trigger full WhatsApp account synchronization',
    description: 'Starts background reconciliation of contacts, chats, group participants and message history.',
  })
  @ApiResponse({ status: 200, description: 'Account sync initiated.' })
  async sync(@Req() req: any) {
    return this.whatsappService.syncAccount(req.user.id);
  }

  @Post('link-contacts')
  @ApiOperation({
    summary: 'Link saved contacts to their WhatsApp LIDs',
    description: 'Asks WhatsApp for the LID of every saved contact phone number, stores the pairs, and refreshes chat titles so chats show saved names.',
  })
  @ApiResponse({ status: 200, description: 'Number of saved contacts checked and linked.' })
  async linkContacts(@Req() req: any) {
    const account = await this.whatsappService.getOrCreateAccount(req.user.id);
    return this.whatsappService.linkSavedContactsToLids(req.user.id, account.id);
  }

  @Post('resync')
  @ApiOperation({
    summary: 'Re-synchronize WhatsApp data and app state',
    description: 'Forces full snapshot resync of app state versions, group participants, and new incoming messages.',
  })
  @ApiResponse({ status: 200, description: 'Resync triggered.' })
  async resync(@Req() req: any) {
    return this.whatsappService.resyncData(req.user.id);
  }

  @Post('reset-synced-data')
  @ApiOperation({
    summary: 'Reset synced WhatsApp data',
    description: 'Wipes local cached messages, contacts and AI extractions while keeping authentication credentials intact.',
  })
  @ApiResponse({ status: 200, description: 'Synced data wiped successfully.' })
  async resetSyncedData(@Req() req: any) {
    return this.whatsappService.resetSyncedData(req.user.id);
  }

  @Post('disconnect')
  @ApiOperation({
    summary: 'Disconnect WhatsApp and unlink device',
    description: 'Logs out from the WhatsApp Web session, clears session keys from disk, and wipes synced account data.',
  })
  @ApiResponse({ status: 200, description: 'WhatsApp session disconnected.' })
  async disconnect(@Req() req: any) {
    return this.whatsappService.disconnect(req.user.id);
  }
}
