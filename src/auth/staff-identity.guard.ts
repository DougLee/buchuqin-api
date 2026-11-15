import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { AuthRequest } from './jwt-auth.guard';

const STAFF_ROLES = ['building-manager', 'intern-building-manager', 'fulltime-rider', 'parttime-rider'];

/** JWT 只证明签发时身份；删除、调岗或调校区后不能继续使用旧会话。 */
@Injectable()
export class StaffIdentityGuard implements CanActivate {
  constructor(private readonly db: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<AuthRequest>();
    if (!user || !STAFF_ROLES.includes(user.role) || (user.appKind && user.appKind !== 'delivery'))
      throw new ForbiddenException('请使用履约端员工身份');
    const staff = await this.db.staff.findUnique({
      where: { id: user.id },
      select: { role: true, status: true, campusId: true, campus: { select: { organizationId: true } } },
    });
    if (!staff || staff.status === 'deleted' || staff.role !== user.role || staff.campusId !== user.campusId ||
      (user.organizationId !== undefined && user.organizationId !== staff.campus.organizationId))
      throw new UnauthorizedException('员工身份或校区已变化，请重新登录');
    return true;
  }
}
