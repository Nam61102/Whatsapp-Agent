import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService, LoginDto, RegisterDto } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@ApiTags('Auth')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({
    summary: 'Register a new user',
    description: 'Creates a new user account, initializes default settings, and returns an access token.',
  })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({
    status: 201,
    description: 'User successfully registered.',
    schema: {
      example: {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        user: {
          id: '6ab1095895fe47010c283e01',
          email: 'user@example.com',
          name: 'Vaibhav',
        },
      },
    },
  })
  @ApiResponse({ status: 409, description: 'User with this email already exists.' })
  async register(@Body(new ValidationPipe({ whitelist: true, transform: true })) dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @ApiOperation({
    summary: 'Log in with email and password',
    description: 'Authenticates a user and returns a JWT Bearer token.',
  })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: 200,
    description: 'User successfully authenticated.',
    schema: {
      example: {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        user: {
          id: '6ab1095895fe47010c283e01',
          email: 'user@example.com',
          name: 'Vaibhav',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid email or password.' })
  async login(@Body(new ValidationPipe({ whitelist: true, transform: true })) dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get current user profile',
    description: 'Fetches the authenticated user profile along with active WhatsApp account status.',
  })
  @ApiResponse({
    status: 200,
    description: 'Current user profile returned.',
    schema: {
      example: {
        id: '6ab1095895fe47010c283e01',
        email: 'user@example.com',
        name: 'Vaibhav',
        whatsappAccount: {
          id: '6ab1095895fe47010c283e02',
          status: 'CONNECTED',
          phoneNumber: '+919876543210',
          displayName: 'Primary WhatsApp',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized / Missing or invalid JWT.' })
  async getMe(@Req() req: any) {
    return this.authService.getMe(req.user.id);
  }
}
