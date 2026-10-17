import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com', description: 'User email address' })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({ example: 'password123', description: 'User password (minimum 6 characters)', minLength: 6 })
  @IsString()
  @MinLength(6)
  password!: string;

  @ApiProperty({ example: 'Vaibhav', description: 'Full name or display name' })
  @IsString()
  @IsNotEmpty()
  name!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'user@example.com', description: 'Registered email address' })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({ example: 'password123', description: 'Account password' })
  @IsString()
  @IsNotEmpty()
  password!: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      const email = 'demo@user.com';
      const existing = await this.prisma.user.findUnique({
        where: { email },
      });

      if (!existing) {
        const authUserId = randomUUID();
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash('password123', salt);

        await this.prisma.user.create({
          data: {
            authUserId,
            email,
            passwordHash,
            name: 'User',
            userSettings: {
              create: {
                retentionDays: 365,
                autoAIAnalysis: true,
                notificationsEnabled: true,
              },
            },
          },
        });
      }
    } catch (e: any) {
      console.warn('[AuthService] Auto-seed error (non-fatal):', e.message);
    }
  }

  private generateToken(user: { id: string; authUserId: string; email: string; name: string }) {
    const secret = process.env.JWT_SECRET as string;
    const expiresIn = (process.env.JWT_EXPIRES_IN || '7d') as any;
    return jwt.sign(
      {
        sub: user.id,
        authUserId: user.authUserId,
        email: user.email,
        name: user.name,
        aud: 'authenticated',
        role: 'authenticated',
      },
      secret,
      { expiresIn }
    );
  }

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      throw new ConflictException('A user with this email address already exists');
    }

    const authUserId = randomUUID();
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(dto.password, salt);

    // Create user document in MongoDB with passwordHash
    const user = await this.prisma.user.create({
      data: {
        authUserId,
        email,
        passwordHash,
        name: dto.name.trim(),
        userSettings: {
          create: {
            retentionDays: 365,
            autoAIAnalysis: true,
            notificationsEnabled: true,
          },
        },
      },
      select: {
        id: true,
        authUserId: true,
        email: true,
        name: true,
        avatarUrl: true,
        createdAt: true,
      },
    });

    const token = this.generateToken(user);

    return {
      user,
      accessToken: token,
      tokenType: 'Bearer',
    };
  }

  async login(dto: LoginDto) {
    const email = dto.email.toLowerCase().trim();

    // Retrieve user profile from MongoDB
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        whatsappAccounts: {
          take: 1,
          select: {
            id: true,
            phoneNumber: true,
            status: true,
            displayName: true,
          },
        },
      },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const token = this.generateToken(user);

    return {
      user: {
        id: user.id,
        authUserId: user.authUserId,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        whatsappAccount: user.whatsappAccounts[0] || null,
      },
      accessToken: token,
      tokenType: 'Bearer',
    };
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ id: userId }, { authUserId: userId }],
      },
      select: {
        id: true,
        authUserId: true,
        email: true,
        name: true,
        avatarUrl: true,
        phone: true,
        createdAt: true,
        userSettings: true,
        whatsappAccounts: {
          take: 1,
          select: {
            id: true,
            phoneNumber: true,
            status: true,
            displayName: true,
            lastConnectedAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      ...user,
      whatsappAccount: user.whatsappAccounts[0] || null,
    };
  }
}
