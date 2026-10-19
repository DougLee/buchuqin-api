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
  /** RBAC V1 会话版本（仅后台账号签发）：AdminAccount.sessionVersion，bump 即旧 token 失效 */
  sv?: number;
  /** 小程序组织身份由服务端按实际 code2session AppID 推导，客户端无权指定。 */
  organizationId?: string;
  /** 区分用户端与履约端令牌；旧令牌缺省兼容。 */
  appKind?: 'user' | 'delivery';
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
