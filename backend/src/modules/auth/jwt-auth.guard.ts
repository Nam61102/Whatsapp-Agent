import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication token missing or invalid');
    }

    const token = authHeader.split(' ')[1];
    const secret = process.env.JWT_SECRET as string;

    try {
      const decoded = jwt.verify(token, secret) as { sub: string; authUserId?: string; email?: string; name?: string };

      // Resolve canonical public.users.id
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { id: decoded.sub },
            { authUserId: decoded.sub },
            { authUserId: decoded.authUserId || '' },
          ],
        },
        select: { id: true, authUserId: true, email: true, name: true },
      });

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
