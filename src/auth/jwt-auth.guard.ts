import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
export interface AuthUser {
  id: string;
  campusId: string;
  role:
    | 'user'
    | 'building-manager'
    | 'intern-building-manager'
    | 'fulltime-rider'
    | 'parttime-rider'
    | 'hq'
    | 'admin'
    | 'operations'
    | 'warehouse'
    | 'finance';
}
export interface AuthRequest extends Request {
  user: AuthUser;
}
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException('请先登录');
    try {
      request.user = this.jwt.verify<AuthUser>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });
      return true;
    } catch {
      throw new UnauthorizedException('登录已失效');
    }
  }
}
