import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AdminService } from '../admin/admin.service';
import { AdminController } from '../admin/admin.controller';
import { AdminAuthGuard } from '../admin/rbac/admin-auth.guard';
import { RbacService } from '../admin/rbac/rbac.service';
import { BusinessService } from '../business/business.service';
import { UserOrdersService } from '../business/user-orders.service';
import { NightUserService } from './night-user.service';
import { NightRiderService } from './night-rider.service';
import { NightAdminService } from './night-admin.service';
import { NightOrderService } from './night-order.service';
import { NightInventoryService } from './night-inventory.service';
import { NightCampusEnabledGuard, NightRiderAccessGuard } from './night-campus-enabled.guard';
import { PaymentsService } from '../payments/payments.service';
import { JwtAuthGuard, type AuthRequest } from '../auth/jwt-auth.guard';
import { nightAccess } from '../common/night-access';

const integration = process.env.NIGHT_STOCK_INTEGRATION === '1' ? describe : describe.skip;
integration('组织授权与校区开通（独立PostgreSQL）', () => {
  const db = new PrismaService(), rbac = new RbacService(db);
  const business = new BusinessService(db), service = new AdminService(db, business);
  const controller = new AdminController(service, rbac);
  const inventory = new NightInventoryService(db);
  const nightAdmin = new NightAdminService(db, {} as PaymentsService, {} as NightOrderService);
  const tag = randomUUID();
  let orgId: string, campusId: string, foreignCampus: string, staffId: string, storeId: string, userId: string;
  let account: Awaited<ReturnType<typeof db.adminAccount.create>>;
  const req = async (body: unknown = {}) => ({ user: { id: account.id, campusId, role: 'admin', sv: 0 }, rbac: { ...await rbac.getEffective(account) }, body, query: {}, path: '/api/v1/admin/campuses/' + campusId, method: 'PATCH' }) as unknown as AuthRequest;
  const context = (request: unknown) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as ExecutionContext;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    if (!url.pathname.endsWith('_spec') || !url.searchParams.get('schema')?.startsWith('night_stock_')) throw Error('仅允许独立测试schema');
    const org = await db.organization.create({ data: { name: `夜宵授权-${tag}` } }); orgId = org.id;
    const campus = await db.campus.create({ data: { organizationId: orgId, name: tag, shortName: '权限验收', warehouseName: '验收仓', nightEnabled: true, nightStartAt: '00:00', nightEndAt: '23:59' } }); campusId = campus.id;
    const other = await db.organization.create({ data: { name: `其他组织-${tag}`, nightEnabled: true } });
    foreignCampus = (await db.campus.create({ data: { organizationId: other.id, name: `其他校区-${tag}`, shortName: '其他', warehouseName: '其他仓' } })).id;
    const building = await db.building.create({ data: { campusId, name: '授权验收楼' } });
    const staff = await db.staff.create({ data: { campusId, name: '授权验收楼长', staffNo: tag, role: 'building-manager', roleText: '楼长', building: building.name, onTimeRate: 100, income: 0 } }); staffId = staff.id;
    storeId = (await db.nightStore.create({ data: { campusId, buildingId: building.id, managerStaffId: staffId, status: 'open' } })).id;
    userId = (await db.user.create({ data: { campusId, nickname: '授权验收用户', phone: tag } })).id;
    await rbac.syncRegistry();
    account = await db.adminAccount.create({ data: { username: tag, passwordHash: 'isolated-test-not-a-login-password', role: 'admin', campusId, orgLevel: 'org', organizationId: orgId } });
    const role = await db.adminRole.findUniqueOrThrow({ where: { code: 'org-admin' } });
    await db.adminAccountRole.create({ data: { accountId: account.id, roleId: role.id, scope: 'platform' } });
    // A retained role grant must remain inert while either business switch is off.
    const nightRole = await db.adminRole.create({ data: { code: `night-access-${tag}`, name: '独立验收授权' } });
    const menus = await db.adminMenu.findMany({ where: { code: { in: ['night-stores', 'night-stores.write', 'night-orders', 'night-deposit'] } } });
    await db.adminRoleMenu.createMany({ data: menus.map(menu => ({ roleId: nightRole.id, menuId: menu.id })) });
    await db.adminAccountRole.create({ data: { accountId: account.id, roleId: nightRole.id, scope: 'platform' } });
  });
  afterAll(async () => { await db.$disconnect(); });

  it('旧组织迁移默认不授权，不改变原营销白名单', async () => {
    const schema = new URL(process.env.DATABASE_URL!).searchParams.get('schema')!;
    if (!/^night_stock_[a-z0-9_]+$/.test(schema)) throw Error('Unexpected schema');
    const sql = readFileSync(resolve(__dirname, '../../prisma/migrations/20261117160000_organization_night_access/migration.sql'), 'utf8');
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE night_org_before (LIKE "${schema}"."Organization" INCLUDING DEFAULTS) ON COMMIT DROP`);
      await tx.$executeRawUnsafe('ALTER TABLE pg_temp.night_org_before DROP COLUMN "nightEnabled"');
      await tx.$executeRawUnsafe(`INSERT INTO pg_temp.night_org_before (id,name,capabilities) VALUES ('legacy-a','legacy-a',NULL),('legacy-b','legacy-b','["marketing"]'::jsonb)`);
      await tx.$executeRawUnsafe(sql.replace('"Organization"', 'pg_temp.night_org_before'));
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; nightEnabled: boolean; capabilities: unknown }>>('SELECT id,"nightEnabled",capabilities FROM pg_temp.night_org_before ORDER BY id');
      expect(rows).toEqual([{ id: 'legacy-a', nightEnabled: false, capabilities: null }, { id: 'legacy-b', nightEnabled: false, capabilities: ['marketing'] }]);
    });
  });

  it('组织默认不授权，旧校区开关不能越过组织，页面上下文和直接经营API都关闭', async () => {
    expect(await nightAccess(db, campusId)).toEqual({ authorized: false, enrolled: true, enabled: false });
    const user = new NightUserService(db, {} as NightOrderService);
    expect((await user.entry(campusId)).inNightSession).toBe(false);
    expect((await user.stores(campusId)).stores).toEqual([]);
    expect(await new NightRiderService(db, {} as NightOrderService).businessContext(staffId)).toMatchObject({ nightEnabled: false, canSwitchWorkspace: false });
    await expect(new NightCampusEnabledGuard(db).canActivate(context({ user: { campusId, role: 'building-manager' } }))).rejects.toThrow('未开通');
    await expect(new NightRiderAccessGuard(db).canActivate(context({ user: { id: staffId, campusId } }))).rejects.toThrow('未开通');
    await expect(inventory.stockPool(staffId)).rejects.toThrow('未开通');
    expect((await rbac.buildMeResponse(account, campusId)).menus.some(m => m.code.startsWith('night-'))).toBe(false);
  });

  it('组织管理员不能给未授权组织开通校区，普通校区账号也不能自行开通', async () => {
    await expect(controller.updateCampus(await req(), campusId, { nightEnabled: true })).rejects.toThrow('组织尚未获授权');
    const request = await req(); (request.rbac as { orgLevel: string }).orgLevel = 'campus';
    await expect(controller.updateCampus(request, campusId, { nightEnabled: true })).rejects.toThrow('仅超管或本组织管理员');
    await expect(controller.updateCampus(await req(), foreignCampus, { nightEnabled: true })).rejects.toThrow();
  });

  it('组织管理员不能通过组织编辑接口给自己授权，共享营销接口也不能绕过开关', async () => {
    const guard = new AdminAuthGuard({ canActivate: async () => true } as unknown as JwtAuthGuard, db, rbac);
    const request = await req({ nightEnabled: true });
    Object.assign(request, { path: '/api/v1/admin/organizations/' + orgId, method: 'PATCH' });
    await expect(guard.canActivate(context(request))).rejects.toThrow('仅超级管理员');
    Object.assign(request, { path: '/api/v1/admin/coupons', method: 'POST', body: { businessType: 'night' } });
    await expect(guard.canActivate(context(request))).rejects.toThrow('未开通');
  });

  it('超管授权组织不会自动开启旧校区，也不会自动开店', async () => {
    await service.updateOrganization(orgId, { nightEnabled: true }, 'isolated-super');
    expect(await nightAccess(db, campusId)).toEqual({ authorized: true, enrolled: false, enabled: false });
    expect((await db.nightStore.findUniqueOrThrow({ where: { id: storeId } })).status).toBe('closed');
    expect((await rbac.buildMeResponse(account, campusId)).menus.some(m => m.code.startsWith('night-'))).toBe(false);
  });

  it('本组织管理员开通校区后沿用已有菜单权限；未开店时用户仍为白天', async () => {
    await controller.updateCampus(await req(), campusId, { nightEnabled: true });
    expect((await rbac.buildMeResponse(account, campusId)).menus.some(m => m.code === 'night-stores')).toBe(true);
    expect(await new NightCampusEnabledGuard(db).canActivate(context({ user: { campusId, role: 'building-manager' } }))).toBe(true);
    expect((await new NightUserService(db, {} as NightOrderService).entry(campusId)).inNightSession).toBe(false);
    await expect(nightAdmin.saveConfig(account.id, { campusId, nightEnabled: false })).rejects.toThrow('校区管理');
  });

  it('关闭校区保留历史订单、收货和账务入口，不能新增备货或恢复经营', async () => {
    await db.nightOrder.create({ data: { storeId, userId, managerStaffId: staffId, orderNo: 'YX-' + tag, businessDate: '2026-11-17', status: 'completed', statusText: '已完成', items: [], productAmount: 600, payableAmount: 600, commissionRate: 0, address: {}, timeline: [] } });
    await db.nightStore.update({ where: { id: storeId }, data: { status: 'open' } });
    await controller.updateCampus(await req(), campusId, { nightEnabled: false });
    expect((await db.nightStore.findUniqueOrThrow({ where: { id: storeId } })).status).toBe('closed');
    expect(await new NightRiderAccessGuard(db).canActivate(context({ user: { id: staffId, campusId } }))).toBe(true);
    await expect(inventory.stockPool(staffId)).rejects.toThrow('未开通');
    await expect(nightAdmin.assertAccess(campusId, 'GET', '/admin/night/orders')).resolves.toBeUndefined();
    await expect(nightAdmin.assertAccess(campusId, 'POST', `/admin/night/stores/${storeId}/products`)).rejects.toThrow('未开通');
    expect(await new UserOrdersService(business, new NightOrderService(db, { registerNightPaymentHandler() {} } as unknown as PaymentsService), db).list(userId)).toMatchObject({ nightVisible: true, total: 1 });
  });

  it('组织撤权后所有下属校区关闭，重新授权仍须逐校区开通', async () => {
    await controller.updateCampus(await req(), campusId, { nightEnabled: true });
    await service.updateOrganization(orgId, { nightEnabled: false }, 'isolated-super');
    expect(await nightAccess(db, campusId)).toEqual({ authorized: false, enrolled: false, enabled: false });
    expect(await db.nightOrder.count({ where: { storeId } })).toBe(1);
    await service.updateOrganization(orgId, { nightEnabled: true }, 'isolated-super');
    expect((await nightAccess(db, campusId)).enabled).toBe(false);
  });
});
