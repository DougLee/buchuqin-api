import { nightAccess, assertNightEnabled, isNightHistoryOperation } from './night-access';
import type { PrismaService } from '../database/prisma.service';

describe('夜宵两个开关', () => {
  it.each([
    [false, false, false], [false, true, false], [true, false, false], [true, true, true],
  ])('组织授权%s、校区开通%s，最终可用%s', async (authorized, enrolled, enabled) => {
    const db = { campus: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org', nightEnabled: enrolled }) }, organization: { findUnique: jest.fn().mockResolvedValue({ nightEnabled: authorized, status: 'active' }) } } as unknown as PrismaService;
    expect(await nightAccess(db, 'campus')).toEqual({ authorized, enrolled, enabled });
    if (enabled) await expect(assertNightEnabled(db, 'campus')).resolves.toBeUndefined();
    else await expect(assertNightEnabled(db, 'campus')).rejects.toThrow('未开通');
  });
  it('无组织和组织停用均不放行，不沿用营销的null全开语义', async () => {
    const findUnique = jest.fn().mockResolvedValue({ organizationId: null, nightEnabled: true });
    const organization = jest.fn().mockResolvedValue({ nightEnabled: true, status: 'disabled' });
    const db = { campus: { findUnique }, organization: { findUnique: organization } } as unknown as PrismaService;
    expect((await nightAccess(db, 'campus')).enabled).toBe(false);
    expect(organization).not.toHaveBeenCalled();
    findUnique.mockResolvedValue({ organizationId: 'org', nightEnabled: true });
    expect((await nightAccess(db, 'campus')).enabled).toBe(false);
  });
  it('关闭后只保留历史履约和账务操作，经营与商品配置不可用', () => {
    for (const [method, path] of [
      ['GET', '/admin/night/orders'], ['POST', '/admin/night/orders/old/refund'],
      ['POST', '/admin/night/stock-orders/old/ship'], ['POST', '/admin/night/settlements/settle'],
      ['GET', '/admin/night/stores/old/deposit-refunds'], ['POST', '/admin/night/stores/old/deposit/refunds/request/sync'],
    ]) expect(isNightHistoryOperation(method!, path!)).toBe(true);
    for (const [method, path] of [
      ['POST', '/admin/night/stores'], ['GET', '/admin/night/catalog'], ['PUT', '/admin/night/config'],
      ['POST', '/admin/night/stores/old/products'], ['POST', '/admin/night/opening-requests/old/review'],
    ]) expect(isNightHistoryOperation(method!, path!)).toBe(false);
  });
});
