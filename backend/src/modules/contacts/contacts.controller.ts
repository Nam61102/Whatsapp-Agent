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
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ContactsService } from './contacts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DeviceContactsService } from '../../shared/device-contacts.service';

@ApiTags('Contacts')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/contacts')
@UseGuards(JwtAuthGuard)
export class ContactsController {
  constructor(
    private readonly contactsService: ContactsService,
    private readonly deviceContactsService: DeviceContactsService
  ) {}

  @Post('device')
  @ApiOperation({
    summary: 'Upload the user\'s device phonebook',
    description:
      'The mobile app sends every { phoneNumber, name } pair it reads from the OS address book here. The backend keeps this in-memory per user and overlays those names onto every /chats and /contacts response so the UI always matches the real phonebook — even on web where the browser cannot read phonebook contacts.',
  })
  @ApiResponse({ status: 200, description: 'Device phonebook stored for the session.' })
  async uploadDeviceContacts(
    @Req() req: any,
    @Body() body: { contacts?: Array<{ phoneNumber: string; name: string }> }
  ) {
    const stored = this.deviceContactsService.setUserContacts(
      req.user.id,
      body?.contacts || []
    );
    return { success: true, stored };
  }

  @Get()
  @ApiOperation({
    summary: 'Get paginated list of contacts',
    description: 'Returns synced WhatsApp address book contacts and groups, filterable by name, phone number, and type.',
  })
  @ApiQuery({ name: 'search', required: false, description: 'Filter contacts by name or phone number' })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['ALL', 'INDIVIDUAL', 'GROUP'],
    description: 'Filter by contact type (ALL, INDIVIDUAL, or GROUP)',
  })
  @ApiQuery({ name: 'limit', required: false, example: '50', description: 'Number of contacts to return' })
  @ApiQuery({ name: 'offset', required: false, example: '0', description: 'Pagination offset' })
  @ApiResponse({
    status: 200,
    description: 'List of contacts.',
    schema: {
      example: {
        contacts: [
          {
            id: '6ab1095895fe47010c283e20',
            displayName: 'Namrata',
            phoneNumber: '+919876543210',
            isGroup: false,
            isSavedContact: true,
          },
        ],
        total: 142,
      },
    },
  })
  async getContacts(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('type') type?: 'ALL' | 'INDIVIDUAL' | 'GROUP',
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    const parsedLimit = limit !== undefined && limit !== '' ? parseInt(limit, 10) : undefined;
    const parsedOffset = offset !== undefined && offset !== '' ? parseInt(offset, 10) : 0;

    return this.contactsService.getContacts(
      req.user.id,
      search,
      isNaN(parsedLimit as number) ? undefined : parsedLimit,
      isNaN(parsedOffset) ? 0 : parsedOffset,
      type
    );
  }

  @Get(':contactId')
  @ApiOperation({
    summary: 'Get contact details by ID',
    description: 'Fetches detailed metadata, phone number, WhatsApp JID, and linked AI Persona Profile for a single contact.',
  })
  @ApiParam({ name: 'contactId', description: 'Contact database ID' })
  @ApiResponse({ status: 200, description: 'Contact details.' })
  @ApiResponse({ status: 404, description: 'Contact not found.' })
  async getContactById(@Req() req: any, @Param('contactId') contactId: string) {
    return this.contactsService.getContactById(req.user.id, contactId);
  }
}
