import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ChatsService } from './chats.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('Chats')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/chats')
@UseGuards(JwtAuthGuard)
export class ChatsController {
  constructor(private readonly chatsService: ChatsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get paginated list of conversations',
    description: 'Retrieves all individual and group chats ordered by latest message timestamp, with optional text search and pagination.',
  })
  @ApiQuery({ name: 'search', required: false, description: 'Filter chats by contact name or message preview' })
  @ApiQuery({ name: 'limit', required: false, example: '50', description: 'Number of chats to return (default: 50)' })
  @ApiQuery({ name: 'offset', required: false, example: '0', description: 'Pagination offset (default: 0)' })
  @ApiResponse({
    status: 200,
    description: 'List of conversations.',
    schema: {
      example: {
        chats: [
          {
            id: '6ab1095895fe47010c283e05',
            title: 'Namrata',
            chatType: 'INDIVIDUAL',
            unreadCount: 2,
            lastMessageText: 'See you tomorrow at 10am!',
            lastMessageAt: '2026-09-28T07:30:00.000Z',
            contact: {
              id: '6ab1095895fe47010c283e06',
              displayName: 'Namrata',
              phoneNumber: '+919876543210',
            },
          },
        ],
        total: 107,
      },
    },
  })
  async getChats(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('limit') limit: string = '50',
    @Query('offset') offset: string = '0'
  ) {
    return this.chatsService.getChats(
      req.user.id,
      search,
      parseInt(limit, 10) || 50,
      parseInt(offset, 10) || 0
    );
  }

  @Get(':chatId')
  @ApiOperation({
    summary: 'Get chat details by conversation ID',
    description: 'Retrieves a single conversation along with contact details and group participants if applicable.',
  })
  @ApiParam({ name: 'chatId', description: 'Conversation database ID or WhatsApp JID' })
  @ApiResponse({ status: 200, description: 'Conversation details.' })
  @ApiResponse({ status: 404, description: 'Conversation not found.' })
  async getChatById(@Req() req: any, @Param('chatId') chatId: string) {
    return this.chatsService.getChatById(req.user.id, chatId);
  }

  @Post(':chatId/read')
  @ApiOperation({
    summary: 'Mark conversation as read',
    description: 'Clears unread count for the chat and marks latest received messages as read.',
  })
  @ApiParam({ name: 'chatId', description: 'Conversation database ID or WhatsApp JID' })
  @ApiResponse({ status: 200, description: 'Chat marked as read.' })
  async markAsRead(@Req() req: any, @Param('chatId') chatId: string) {
    return this.chatsService.markAsRead(req.user.id, chatId);
  }
}
