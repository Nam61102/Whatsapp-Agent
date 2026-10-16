import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MessagesService } from './messages.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({ example: 'Hello! How are you doing today?', description: 'Text message content to send' })
  @IsString()
  @IsNotEmpty()
  text!: string;

  @ApiPropertyOptional({ example: 'https://example.com/image.jpg', description: 'Optional media URL for image/document attachment' })
  @IsOptional()
  @IsString()
  mediaUrl?: string;

  @ApiPropertyOptional({ description: 'Action Center card this reply answers. The card is closed once the message is sent.' })
  @IsOptional()
  @IsString()
  actionItemId?: string;

  @ApiPropertyOptional({ example: 'FOLLOW_UP', description: 'Category of that card (REPLY_NEEDED, FOLLOW_UP, BIRTHDAY)' })
  @IsOptional()
  @IsString()
  actionCategory?: string;
}

@ApiTags('Messages')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/chats/:chatId/messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get()
  @ApiOperation({
    summary: 'Get message history for a conversation',
    description: 'Fetches paginated chronological messages for the given chat ID, supporting cursor pagination with "before" ISO timestamp.',
  })
  @ApiParam({ name: 'chatId', description: 'Conversation database ID or WhatsApp JID' })
  @ApiQuery({ name: 'limit', required: false, example: '50', description: 'Number of messages to retrieve (default: 50)' })
  @ApiQuery({ name: 'before', required: false, example: '2026-09-28T07:00:00.000Z', description: 'Cursor timestamp to fetch older messages before this date' })
  @ApiResponse({
    status: 200,
    description: 'Message history list.',
    schema: {
      example: {
        messages: [
          {
            id: '6ab1095895fe47010c283e10',
            textContent: 'Hey Vaibhav, are we meeting at 4 PM?',
            messageType: 'TEXT',
            isFromMe: false,
            currentStatus: 'READ',
            messageTimestamp: '2026-09-28T06:45:00.000Z',
          },
          {
            id: '6ab1095895fe47010c283e11',
            textContent: 'Yes! See you in the conference room.',
            messageType: 'TEXT',
            isFromMe: true,
            currentStatus: 'READ',
            messageTimestamp: '2026-09-28T06:46:00.000Z',
          },
        ],
        hasMore: false,
      },
    },
  })
  async getMessages(
    @Req() req: any,
    @Param('chatId') chatId: string,
    @Query('limit') limit: string = '50',
    @Query('before') before?: string
  ) {
    return this.messagesService.getMessages(
      req.user.id,
      chatId,
      parseInt(limit, 10) || 50,
      before
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Send a message in a conversation',
    description: 'Sends a real-time WhatsApp message via the Baileys adapter and broadcasts real-time socket events.',
  })
  @ApiParam({ name: 'chatId', description: 'Conversation database ID or WhatsApp JID' })
  @ApiBody({ type: SendMessageDto })
  @ApiResponse({
    status: 201,
    description: 'Message sent successfully.',
    schema: {
      example: {
        id: '6ab1095895fe47010c283e12',
        externalMessageId: '3EB0...',
        textContent: 'Hello! How are you doing today?',
        isFromMe: true,
        currentStatus: 'SENT',
        messageTimestamp: '2026-09-28T07:45:00.000Z',
      },
    },
  })
  async sendMessage(
    @Req() req: any,
    @Param('chatId') chatId: string,
    @Body() body: SendMessageDto
  ) {
    return this.messagesService.sendMessage(
      req.user.id,
      chatId,
      body.text,
      body.mediaUrl,
      body.actionItemId ? { id: body.actionItemId, category: body.actionCategory } : undefined
    );
  }
}
