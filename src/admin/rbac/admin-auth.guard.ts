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
import { RbacService, matchUrl, type RbacContext } from './rbac.service';
import { isSuperOnlyOperation } from './access-policy';
import { ADMIN_URL_WHITELIST } from './registry';

export interface RbacRequest extends Request {
  user: AuthRequest['user'];
  /** AdminAuthGuard 注入：本请求的 RBAC 上下文（有效权限=平台级 ∪ 上下文校区校区级） */
  rbac?: RbacContext;
}

/** 全局前缀（main.ts setGlobalPrefix）——判权模式以 /admin 为根，先剥掉 */
const GLOBAL_PREFIX = '/api/v1';

/** 归一化请求路径：剥全局前缀与尾部斜杠（/admin/x/ 与 /admin/x 同权） */
export function normalizeAdminPath(path: string): string {
  const stripped = path.startsWith(GLOBAL_PREFIX)
    ? path.slice(GLOBAL_PREFIX.length)
    : path;
  return stripped.replace(/\/+$/, '') || '/';
}

/**
 * 后台鉴权守卫（蛋词体系版，2026-09-19 拍板 B）：替换控制器内权限码判权。
 * 链路：JWT 验签 → AdminAccount 实时加载（不信任 token 里的 role claim）→
 * 状态/会话版本校验（停用/改密/撤权后旧 token 即刻失效）→ 有效权限装载 →
 * **URL 判权（默认拒绝）**：rbac.allow(ctx, method, path) 按菜单 perms 模式
 * （'METHOD /admin/x/:seg'）匹配；白名单端点（rbac/me、
 * rbac/permmenu）登录即可读。授权读取失败默认拒绝（异常上抛，绝不回退宽松权限）。
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
    this.rbac.assertSession(account, request.user.sv);
    // Business services must use the same current campus as permission calculation.
    // Otherwise a token issued before switching campuses could combine old data with new rights.
    request.user.campusId = account.campusId;
    // 4) 有效权限装载（DB 异常 → 拒绝）
    const ctx = await this.rbac.getEffective(account);
    // 5) URL 判权（蛋词同款文案；白名单精确 method+path 放行，默认拒绝）
    const method = request.method.toUpperCase();
    const path = normalizeAdminPath(request.path);
    // A platform grant for one capability must not widen a campus grant for another.
    request.rbac = {
      ...ctx,
      platform: ctx.super || matchUrl(ctx.platformPatterns ?? [], method, path),
    };
    if (!ctx.super && isSuperOnlyOperation(method, path))
      throw new ForbiddenException('仅超级管理员可以配置权限');
    if (ADMIN_URL_WHITELIST.has(`${method} ${path}`)) return true;
    if (!this.rbac.allow(ctx, method, path))
      throw new ForbiddenException('所在用户组暂无权限');
    return true;
  }
}
