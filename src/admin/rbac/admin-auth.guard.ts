import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard, type AuthRequest } from '../../auth/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { RbacService, type RbacContext } from './rbac.service';

export interface RbacRequest extends Request {
  user: AuthRequest['user'];
  /** AdminAuthGuard 注入：本请求的 RBAC 上下文（有效权限=平台级 ∪ 上下文校区校区级） */
  rbac?: RbacContext;
}

/**
 * 后台鉴权守卫（RBAC V1，2026-09-19）：替换 admin 控制器上的裸 JwtAuthGuard。
 * 链路：JWT 验签 → AdminAccount 实时加载（不信任 token 里的 role claim）→
 * 状态/会话版本校验（停用/改密/撤权后旧 token 即刻失效）→ 有效权限装载。
 * 授权读取失败默认拒绝（异常上抛，绝不回退宽松权限）。
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly jwtGuard: JwtAuthGuard,
    private readonly db: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1) JWT 验签（复用既有 Guard，claims 挂 request.user）
    await this.jwtGuard.canActivate(context);
    const request = context.switchToHttp().getRequest<RbacRequest>();
    // 2) 必须是后台账号（C 端/员工 token 一律 403）
    const account = await this.db.adminAccount.findUnique({
      where: { id: request.user.id },
    });
    if (!account)
      throw new ForbiddenException('该账号无后台访问权限');
    // 3) 状态 + 会话版本（旧 token 缺 sv 视为 0；bump 后即失效）
    if (account.status === 'disabled')
      throw new UnauthorizedException('账号已停用，请联系超级管理员');
    const tokenSv = (request.user as { sv?: number }).sv ?? 0;
    if (tokenSv !== account.sessionVersion)
      throw new UnauthorizedException('登录已失效，请重新登录');
    // 4) 有效权限装载（DB 异常 → 拒绝）
    request.rbac = await this.rbac.getEffective(account);
    return true;
  }
}
