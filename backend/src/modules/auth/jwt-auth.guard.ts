import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../../prisma/prisma.service';
import { TtlCache } from '../../shared/ttl-cache';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  static readonly userCache = new TtlCache<{ id: string; authUserId: string | null; email: string; name: string }>(60_000);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication token missing or invalid');
    }

    const token = authHeader.split(' ')[1];
    const secret = (process.env.JWT_SECRET || 'e24b49b1226b702551ec18d9825015ecd437d0cbc6d9aecd5f749bf59d9bbe53') as string;

    try {
      const decoded = jwt.verify(token, secret) as { sub: string; authUserId?: string; email?: string; name?: string };

      // Resolve canonical public.users.id. Reused for a minute: this ran on EVERY request and each run is a
      // round trip to the database. A removed user stays valid for at most that minute.
      const user = await JwtAuthGuard.userCache.getOrLoad(`${decoded.sub}|${decoded.authUserId || ''}`, () =>
        this.prisma.user.findFirst({
          where: {
            OR: [
              { id: decoded.sub },
              { authUserId: decoded.sub },
              { authUserId: decoded.authUserId || '' },
            ],
          },
          select: { id: true, authUserId: true, email: true, name: true },
        })
      );

      if (!user) {
        throw new UnauthorizedException('User associated with authentication token not found');
      }

      request.user = {
        id: user.id,
        authUserId: user.authUserId,
        email: user.email,
        name: user.name,
      };
      return true;
    } catch (err: any) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or expired authentication token');
    }
  }
}
