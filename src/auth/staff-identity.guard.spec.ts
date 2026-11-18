import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { StaffIdentityGuard } from './staff-identity.guard';
import type { AuthUser } from './jwt-auth.guard';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { FulfillmentController } from '../fulfillment/fulfillment.controller';
import { NightRiderController } from '../night/night-rider.controller';

describe('履约会话实时身份校验', () => {
  const user: AuthUser = { id: 'staff', campusId: 'campus-a', role: 'building-manager', organizationId: 'org-a', appKind: 'delivery' };
  const staff = { role: 'building-manager', status: 'offline', campusId: 'campus-a', campus: { organizationId: 'org-a' } };
  const context = (identity: AuthUser) => ({ switchToHttp: () => ({ getRequest: () => ({ user: identity }) }) }) as ExecutionContext;
  function fixture(row: unknown = staff) {
    const db = { staff: { findUnique: jest.fn().mockResolvedValue(row) } };
    return { db, guard: new StaffIdentityGuard(db as unknown as PrismaService) };
  }
  it('白天配送与夜宵配送均安装实时守卫', () => {
    for (const controller of [FulfillmentController, NightRiderController])
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toContain(StaffIdentityGuard);
  });
  it('有效员工允许离线登录，兼容缺少appKind/organizationId的旧令牌', async () => {
    const { guard } = fixture();
    await expect(guard.canActivate(context(user))).resolves.toBe(true);
    const { appKind: _app, organizationId: _org, ...legacy } = user;
    await expect(guard.canActivate(context(legacy))).resolves.toBe(true);
  });
  it.each([
    ['已删除', { ...staff, status: 'deleted' }],
    ['不存在', null],
    ['调岗', { ...staff, role: 'parttime-rider' }],
    ['调校区', { ...staff, campusId: 'campus-b' }],
    ['变更组织', { ...staff, campus: { organizationId: 'org-b' } }],
  ])('%s的员工旧令牌不能读写或自行恢复在线', async (_name, row) => {
    const { guard } = fixture(row);
    await expect(guard.canActivate(context(user))).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('用户端令牌和非配送角色在查员工前拒绝', async () => {
    const { guard, db } = fixture();
    await expect(guard.canActivate(context({ ...user, appKind: 'user' }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(context({ ...user, role: 'user' }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.staff.findUnique).not.toHaveBeenCalled();
  });
});
