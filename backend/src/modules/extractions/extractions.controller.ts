import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ExtractionsService } from './extractions.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IsNotEmpty, IsString } from 'class-validator';

export class UpdateExtractionStatusDto {
  @ApiProperty({
    example: 'ARCHIVED',
    enum: ['ACTIVE', 'ARCHIVED', 'DISMISSED'],
    description: 'New status for the extracted memory',
  })
  @IsString()
  @IsNotEmpty()
  status!: string;
}

@ApiTags('Extractions')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/extractions')
@UseGuards(JwtAuthGuard)
export class ExtractionsController {
  constructor(private readonly extractionsService: ExtractionsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get list of AI-extracted memories',
    description: 'Retrieves categorized structured entities (BIRTHDAY, MEETING, TASK, TOPIC, FINANCIAL, REMINDER) extracted from conversations.',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    example: 'MEETING',
    description: 'Filter by extraction type (BIRTHDAY, MEETING, TASK, TOPIC, FINANCIAL, REMINDER)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    example: 'ACTIVE',
    description: 'Filter by memory status (ACTIVE, ARCHIVED, DISMISSED) (default: ACTIVE)',
  })
  @ApiQuery({ name: 'limit', required: false, example: '50', description: 'Number of extractions to return (default: 50)' })
  @ApiQuery({ name: 'offset', required: false, example: '0', description: 'Pagination offset (default: 0)' })
  @ApiResponse({
    status: 200,
    description: 'List of AI extractions.',
    schema: {
      example: {
        extractions: [
          {
            id: '6ab1095895fe47010c283e40',
            extractionType: 'MEETING',
            title: 'Design Sync with Mobile Team',
            summary: 'Weekly design sync regarding Expo navigation overhaul.',
            eventDate: '2026-09-29T10:00:00.000Z',
            status: 'ACTIVE',
            importanceScore: 0.85,
            confidenceScore: 0.94,
          },
        ],
        total: 18,
      },
    },
  })
  async getExtractions(
    @Req() req: any,
    @Query('type') type?: string,
    @Query('status') status: string = 'ACTIVE',
    @Query('limit') limit: string = '50',
    @Query('offset') offset: string = '0'
  ) {
    return this.extractionsService.getExtractions(
      req.user.id,
      type,
      status,
      parseInt(limit, 10) || 50,
      parseInt(offset, 10) || 0
    );
  }

  @Get('history')
  @ApiOperation({
    summary: 'Full extraction history (all statuses) with filters and pagination',
    description:
      'Database-backed list of every saved extraction, newest first. Filter by status (comma list or ALL), type, priority, contactId, conversationId, search and created-date range.',
  })
  @ApiQuery({ name: 'status', required: false, example: 'ACTIVE,REVIEWED,IN_PROGRESS' })
  @ApiQuery({ name: 'type', required: false, example: 'TASK,MEETING' })
  @ApiQuery({ name: 'priority', required: false, example: 'HIGH,URGENT' })
  @ApiQuery({ name: 'contactId', required: false })
  @ApiQuery({ name: 'conversationId', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'from', required: false, example: '2026-10-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-10-31' })
  @ApiQuery({ name: 'limit', required: false, example: '30' })
  @ApiQuery({ name: 'offset', required: false, example: '0' })
  async getHistory(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('priority') priority?: string,
    @Query('contactId') contactId?: string,
    @Query('conversationId') conversationId?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    return this.extractionsService.getHistory(req.user.id, {
      status,
      type,
      priority,
      contactId,
      conversationId,
      search,
      from,
      to,
      limit: parseInt(limit || '30', 10) || 30,
      offset: parseInt(offset || '0', 10) || 0,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get AI extraction details by ID',
    description: 'Retrieves full structured metadata, linked message source references, and confidence scores for an extraction.',
  })
  @ApiParam({ name: 'id', description: 'Extraction database ID' })
  @ApiResponse({ status: 200, description: 'Extraction item details.' })
  @ApiResponse({ status: 404, description: 'Extraction not found.' })
  async getExtractionById(@Req() req: any, @Param('id') id: string) {
    return this.extractionsService.getExtractionById(req.user.id, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit an extraction',
    description: 'Update title, description, priority, dueAt, notes and/or status. Saved to the database and recorded in the history of the item.',
  })
  @ApiParam({ name: 'id', description: 'Extraction database ID' })
  async updateItem(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { title?: string; description?: string; priority?: string; dueAt?: string | null; notes?: string | null; status?: string }
  ) {
    return this.extractionsService.updateItem(req.user.id, id, body || {});
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Update extraction status',
    description: 'Changes the status of an extraction memory (e.g. mark as ARCHIVED or DISMISSED).',
  })
  @ApiParam({ name: 'id', description: 'Extraction database ID' })
  @ApiBody({ type: UpdateExtractionStatusDto })
  @ApiResponse({ status: 200, description: 'Extraction status updated.' })
  async updateStatus(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: UpdateExtractionStatusDto
  ) {
    return this.extractionsService.updateStatus(req.user.id, id, body.status);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Dismiss or delete an extraction memory',
    description: 'Soft-deletes or removes an extracted memory from active dashboard widgets.',
  })
  @ApiParam({ name: 'id', description: 'Extraction database ID' })
  @ApiQuery({ name: 'category', required: false, description: 'Optional entity category' })
  @ApiResponse({ status: 200, description: 'Extraction dismissed successfully.' })
  async dismissItem(
    @Req() req: any,
    @Param('id') id: string,
    @Query('category') category?: string
  ) {
    return this.extractionsService.dismissItem(req.user.id, id, category);
  }
}
