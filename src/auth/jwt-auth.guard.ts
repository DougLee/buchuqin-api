import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
export interface AuthUser {
  id: string;
  campusId: string;
  role:
    | 'user'
    | 'building-manager'
    | 'fulltime-rider'
    | 'parttime-rider'
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
  constructor(private readonly jwt: JwtService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException('请先登录');
    try {
      request.user = this.jwt.verify<AuthUser>(token, {
        secret: 'buchuqinshishe-mock-secret',
      });
      return true;
    } catch {
      throw new UnauthorizedException('登录已失效');
    }
  }
}
