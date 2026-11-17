import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { assertNightEnabled, nightAccess, hasCampusNightHistory } from '../common/night-access';

/** 只拦截新增经营入口，历史履约、收货和账务处理不随校区关停失效。 */
@Injectable()
export class NightCampusEnabledGuard implements CanActivate {
  constructor(private readonly db: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<AuthRequest>();
    if (!user || !['user', 'building-manager'].includes(user.role))
      throw new ForbiddenException('仅正式楼长可新增夜宵经营业务');
    await assertNightEnabled(this.db, user?.campusId);
    return true;
  }
}

@Injectable()
export class NightRiderAccessGuard implements CanActivate {
  constructor(private readonly db: PrismaService) {}
  async canActivate(context: ExecutionContext) {
    const { user } = context.switchToHttp().getRequest<AuthRequest>();
    if ((await nightAccess(this.db, user?.campusId)).enabled) return true;
    if (user && await hasCampusNightHistory(this.db, user.campusId, user.id)) return true;
    throw new ForbiddenException('本校区未开通夜宵服务');
  }
}
