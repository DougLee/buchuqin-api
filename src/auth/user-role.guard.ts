import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthRequest } from './jwt-auth.guard';
import { PrismaService } from '../database/prisma.service';

/** 允许访问的角色元数据 key（@SetMetadata(USER_ROLES_KEY, [...])）。 */
export const USER_ROLES_KEY = 'userRoles';

/**
 * 角色白名单守卫（IK93GT）：
 * 用户端接口只允许 role === 'user' 的 token 访问，
 * 员工/admin token 调用户端接口直接 403，防止越权读写用户数据。
 */
@Injectable()
export class UserRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<string[] | undefined>(
      USER_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!roles?.length) return true;
    const request = context.switchToHttp().getRequest<AuthRequest & Request>();
    if (!request.user || !roles.includes(request.user.role))
      throw new ForbiddenException('当前角色无权访问用户端接口');
    if (request.user.appKind && request.user.appKind !== 'user')
      throw new ForbiddenException('请使用用户端登录身份');
    const user = await this.db.user.findUnique({ where: { id: request.user.id }, select: { campusId: true, role: true, campus: { select: { organizationId: true } } } });
    if (!user || user.role !== 'user' || user.campusId !== request.user.campusId || (request.user.organizationId !== undefined && request.user.organizationId !== user.campus.organizationId))
      throw new UnauthorizedException('用户身份或校区已变化，请重新登录');
    return true;
  }
}
