import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NightCampusEnabledGuard } from './night-campus-enabled.guard';
import { NightRiderController } from './night-rider.controller';
import type { PrismaService } from '../database/prisma.service';

describe('校区开通前置校验', () => {
  const context = { switchToHttp: () => ({ getRequest: () => ({ user: { campusId: 'campus', role: 'building-manager' } }) }) } as unknown as ExecutionContext;
  it('未开通和校区不存在均拒绝，已开通校区不受营业时间限制', async () => {
    const findUnique = jest.fn().mockResolvedValue({ nightEnabled: false });
    const guard = new NightCampusEnabledGuard({ campus: { findUnique }, organization: { findUnique: jest.fn().mockResolvedValue({ nightEnabled: true, status: 'active' }) } } as unknown as PrismaService);
    await expect(guard.canActivate(context)).rejects.toThrow('本校区未开通夜宵服务');
    findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(context)).rejects.toThrow('本校区未开通夜宵服务');
    findUnique.mockResolvedValue({ nightEnabled: true, organizationId: 'org' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findUnique).toHaveBeenLastCalledWith({ where: { id: 'campus' }, select: { organizationId: true, nightEnabled: true } });
  });
  it('所有新增经营入口都挂守卫，历史履约、收货和账务仍可处理', () => {
    // dashboard 已迁 NightRiderBadgeController（首页角标不可 403，2026-11-24）
    const guarded: Array<keyof NightRiderController> = ['depositTiers', 'depositPay', 'stockPool', 'createStockOrder', 'open', 'resume', 'products', 'toggleShelf', 'setFeatured'];
    const cleanup: Array<keyof NightRiderController> = ['depositDetail', 'depositPayStatus', 'stockOrders', 'cancelStock', 'receiveStock', 'inventoryReports', 'submitInventoryReport', 'resubmitInventoryReport', 'inventoryTransactions', 'orders', 'orderDetail', 'accept', 'deliver', 'income', 'orderEarning', 'close', 'pause'];
    for (const name of guarded) expect(Reflect.getMetadata(GUARDS_METADATA, NightRiderController.prototype[name]) || []).toContain(NightCampusEnabledGuard);
    for (const name of cleanup) expect(Reflect.getMetadata(GUARDS_METADATA, NightRiderController.prototype[name]) || []).not.toContain(NightCampusEnabledGuard);
  });
});
