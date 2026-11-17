import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { AuthRequest } from '../auth/jwt-auth.guard';

/** 只拦截新增经营入口，历史履约、收货和账务处理不随校区关停失效。 */
@Injectable()
export class NightCampusEnabledGuard implements CanActivate {
  constructor(private readonly db: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<AuthRequest>();
    const campus = user?.campusId
      ? await this.db.campus.findUnique({ where: { id: user.campusId }, select: { nightEnabled: true } })
      : null;
    if (!campus?.nightEnabled) throw new ForbiddenException('本校区未开通夜宵服务');
    return true;
  }
}
