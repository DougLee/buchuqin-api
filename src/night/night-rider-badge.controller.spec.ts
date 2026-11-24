import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StaffIdentityGuard } from '../auth/staff-identity.guard';
import { NightCampusEnabledGuard } from './night-campus-enabled.guard';
import { NightRiderBadgeController } from './night-rider-badge.controller';
import type { PrismaService } from '../database/prisma.service';
import type { AuthRequest } from '../auth/jwt-auth.guard';

/** 首页夜宵角标 dashboard（道哥 2026-11-24 A 方案）：
 *  骑手/未开通校区一律全零空工作台，不再 403 触发全局 toast。 */
describe('NightRiderBadgeController', () => {
  const makeReq = (role: string, campusId: string) =>
    ({ user: { id: 'staff-1', role, campusId } }) as unknown as AuthRequest;

  const makeDb = (nightEnabled: boolean | null) =>
    ({
      campus: { findUnique: jest.fn().mockResolvedValue(nightEnabled === null ? null : { nightEnabled }) },
    }) as unknown as PrismaService;

  const makeService = () => ({ dashboard: jest.fn().mockResolvedValue({ pendingOrders: 3 }) });

  it('骑手（任意校区）直接全零，不查库不进 service', async () => {
    const service = makeService();
    const db = makeDb(true); // 即使校区开通也不该走到这
    const ctl = new NightRiderBadgeController(db, service as never);
    const res = await ctl.dashboard(makeReq('fulltime-rider', 'campus-x'));
    expect(res.data).toMatchObject({ pendingOrders: 0, inWindow: false });
    expect((res.data as { store: { id: string } }).store.id).toBe('');
    expect(db.campus.findUnique).not.toHaveBeenCalled();
    expect(service.dashboard).not.toHaveBeenCalled();
  });

  it('楼长系但校区未开通 / 校区行缺失：全零，不进 service', async () => {
    for (const campusRow of [false, null]) {
      const service = makeService();
      const db = makeDb(campusRow as boolean | null);
      const ctl = new NightRiderBadgeController(db, service as never);
      const res = await ctl.dashboard(makeReq('building-manager', 'campus-x'));
      expect(res.data).toMatchObject({ pendingOrders: 0, campus: { nightEnabled: false } });
      expect(service.dashboard).not.toHaveBeenCalled();
    }
  });

  it('楼长系且校区开通：进原 service 工作台', async () => {
    const service = makeService();
    const db = makeDb(true);
    const ctl = new NightRiderBadgeController(db, service as never);
    const res = await ctl.dashboard(makeReq('building-manager', 'campus-x'));
    expect(res.data).toEqual({ pendingOrders: 3 });
    expect(service.dashboard).toHaveBeenCalledWith('staff-1');
  });

  it('守卫口径：类级仅 Jwt+StaffIdentity，方法不再挂 NightCampusEnabledGuard', () => {
    const classGuards =
      Reflect.getMetadata(GUARDS_METADATA, NightRiderBadgeController) || [];
    const methodGuards =
      Reflect.getMetadata(
        GUARDS_METADATA,
        NightRiderBadgeController.prototype.dashboard,
      ) || [];
    expect(classGuards).toContain(JwtAuthGuard);
    expect(classGuards).toContain(StaffIdentityGuard);
    expect([...classGuards, ...methodGuards]).not.toContain(
      NightCampusEnabledGuard,
    );
  });
});
