import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { RbacService } from './rbac/rbac.service';
import type { RbacContext } from './rbac/rbac.service';
import { MENU_NODES } from './rbac/registry';
import { legacyRbacCtx, specReq } from './rbac/spec-fixtures';

/**
 * 多租户组织基线（IKKRMM，ADR-0001）：
 * - Organization 表 + Campus.organizationId 可空扩展（本阶段不收紧 NOT NULL）；
 * - 组织 A（org-a）迁移回填：campus-hq 与真实校区归 org-a，campus-official
 *   平台伪校区留空=平台层；
 * - 最小只读端点：organizations 列表（校区数/用户数聚合）+ 详情（敏感凭据
 *   只回「已配置」位）；平台级能力（PLATFORM_PATTERNS 拦校区级授予）；
 * - RbacContext.organizationId：账号→campusId→campus.organizationId 推导，
 *   平台账号无组织；本阶段不参与判权（IKKRMP 的活）。
 * 组织 A 兼容铁律：campuses() 契约不变，仅多透出 organizationId 字段。
 */
describe('organization baseline (IKKRMM / ADR-0001)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const rbac = new RbacService(db);
  const tag = `orgspec-${Date.now()}`;
  const ORG_ID = `org-spec-${tag}`;
  const CAMPUS_ID = `campus-spec-${tag}`;
  let unassignedCampusId = '';
  const userIds: string[] = [];
  const accountIds: string[] = [];
  const ROLE_CODE = `spec-org-role-${tag}`;

  beforeAll(async () => {
    await db.organization.create({
      data: { id: ORG_ID, name: '测试组织', shortName: '测组' },
    });
    await db.campus.create({
      data: {
        id: CAMPUS_ID,
        name: '组织测试大学',
        shortName: '组织测试',
        warehouseName: '组织测试仓',
        organizationId: ORG_ID,
      },
    });
    for (const nickname of ['组织测试用户甲', '组织测试用户乙']) {
      userIds.push(
        (
          await db.user.create({
            data: { campusId: CAMPUS_ID, nickname, phone: `1${tag.replace(/\D/g, '').padEnd(10, '0').slice(0, 10)}` },
          })
        ).id,
      );
    }
  });

  afterAll(async () => {
    await db.adminAccount.deleteMany({ where: { id: { in: accountIds } } });
    await db.adminRole.deleteMany({ where: { code: ROLE_CODE } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    if (unassignedCampusId) {
      await db.auditLog.deleteMany({ where: { entityId: unassignedCampusId } });
      await db.category.deleteMany({ where: { campusId: unassignedCampusId } });
      await db.campus.deleteMany({ where: { id: unassignedCampusId } });
    }
    await db.campus.deleteMany({ where: { id: CAMPUS_ID } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
    await db.$disconnect();
  });

  it('组织 A 基线（org-a）存在且真实校区已回填，campus-official 留空=平台层', async () => {
    const orgA = await db.organization.findUnique({ where: { id: 'org-a' } });
    expect(orgA).not.toBeNull();
    expect(orgA!.name).toBe('不出寝食社');
    expect(orgA!.status).toBe('active');
    // 迁移回填口径：hq 与真实校区归 org-a；官方库伪校区永属平台层
    const official = await db.campus.findUnique({
      where: { id: 'campus-official' },
      select: { organizationId: true },
    });
    expect(official?.organizationId ?? null).toBeNull();
    const hq = await db.campus.findUnique({
      where: { id: 'campus-hq' },
      select: { organizationId: true },
    });
    expect(hq?.organizationId).toBe('org-a');
  });

  it('organizations()：列表含每组织校区数/用户数聚合（经校区归属汇总）', async () => {
    const list = await service.organizations();
    const mine = list.find((o) => o.id === ORG_ID);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({
      name: '测试组织',
      shortName: '测组',
      status: 'active',
      campusCount: 1,
      userCount: 2,
    });
    // 组织 A 基线：总部仓+真实校区（本库 campus-hbut/campus-hq）
    const orgA = list.find((o) => o.id === 'org-a');
    expect(orgA).toBeDefined();
    expect(orgA!.campusCount).toBeGreaterThanOrEqual(2);
  });

  it('organizationDetail()：校区清单+聚合；敏感凭据只回「已配置」位', async () => {
    const detail = await service.organizationDetail(ORG_ID);
    expect(detail.campusCount).toBe(1);
    expect(detail.userCount).toBe(2);
    expect(detail.campuses.map((c) => c.id)).toEqual([CAMPUS_ID]);
    // 预留微信配置：明文字段不出现，只回布尔位
    expect(detail).not.toHaveProperty('wxSecret');
    expect(detail).not.toHaveProperty('mchApiV3Key');
    expect(detail).not.toHaveProperty('privateKey');
    expect(detail.hasWxSecret).toBe(false);
    expect(detail.hasMchApiV3Key).toBe(false);
    expect(detail.hasPrivateKey).toBe(false);
    await expect(service.organizationDetail(`org-${tag}-missing`)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('campuses() 契约兼容：仅多透出 organizationId（组织 A 现有行为零变化）', async () => {
    const rows = await service.campuses();
    const mine = rows.find((c) => c.id === CAMPUS_ID);
    expect(mine?.organizationId).toBe(ORG_ID);
    const hq = rows.find((c) => c.id === 'campus-hq');
    expect(hq?.organizationId).toBe('org-a');
    // 官方库伪校区仍不出现在校区列表（IKAJSM 语义不因组织层改变）
    expect(rows.some((c) => c.id === 'campus-official')).toBe(false);
    // 新建校区默认未分配组织（先扩展不收紧：分配入口属 IKKRMS）
    unassignedCampusId = (
      await service.createCampus(
        { name: '未分配测试大学', shortName: '未分配', warehouseName: '未分配测试仓' },
        'spec-org',
      )
    ).id;
    const fresh = await db.campus.findUnique({
      where: { id: unassignedCampusId },
      select: { organizationId: true },
    });
    expect(fresh?.organizationId ?? null).toBeNull();
  });

  it('RbacContext.organizationId：校区级账号=上下文校区组织；平台级账号=无组织', async () => {
    const role = await db.adminRole.upsert({
      where: { code: ROLE_CODE },
      update: {},
      create: { code: ROLE_CODE, name: '组织测试角色', seeded: true, menusMigrated: true },
    });
    const campusAccount = await db.adminAccount.create({
      data: {
        username: `spec-org-c-${tag}`,
        passwordHash: 'x',
        role: 'rbac',
        campusId: CAMPUS_ID,
        rbacMigrated: true,
      },
    });
    accountIds.push(campusAccount.id);
    await db.adminAccountRole.create({
      data: {
        accountId: campusAccount.id,
        roleId: role.id,
        scope: 'campus',
        campusId: CAMPUS_ID,
        grantedBy: 'spec',
      },
    });
    const ctx = await rbac.getEffective(campusAccount);
    expect(ctx.platform).toBe(false);
    expect(ctx.organizationId).toBe(ORG_ID);

    const platformAccount = await db.adminAccount.create({
      data: {
        username: `spec-org-p-${tag}`,
        passwordHash: 'x',
        role: 'rbac',
        campusId: CAMPUS_ID,
        rbacMigrated: true,
      },
    });
    accountIds.push(platformAccount.id);
    await db.adminAccountRole.create({
      data: {
        accountId: platformAccount.id,
        roleId: role.id,
        scope: 'platform',
        grantedBy: 'spec',
      },
    });
    const pctx = await rbac.getEffective(platformAccount);
    expect(pctx.platform).toBe(true);
    expect(pctx.organizationId).toBeNull();
  });

  it('端点判权：平台级能力——超管放行；校区模板拒绝；校区级授予不放行', () => {
    expect(rbac.allow(legacyRbacCtx('admin'), 'GET', '/admin/organizations')).toBe(true);
    expect(rbac.allow(legacyRbacCtx('admin'), 'GET', '/admin/organizations/org-a')).toBe(true);
    // 旧五角色模板均未登记组织菜单 → 默认拒绝
    for (const role of ['hq', 'operations', 'warehouse', 'finance'])
      expect(rbac.allow(legacyRbacCtx(role), 'GET', '/admin/organizations')).toBe(false);
    // PLATFORM_PATTERNS 兜底：即便校区级角色被授予该模式（后台误配），仍拒
    const mixed: RbacContext = {
      accountId: 'spec-mixed',
      username: 'mixed',
      nickname: 'mixed',
      campusId: CAMPUS_ID,
      platform: false,
      super: false,
      campuses: [CAMPUS_ID],
      patterns: new Set(['GET /admin/organizations', 'GET /admin/organizations/:id']),
      platformPatterns: new Set(),
      menuCodes: new Set(),
    };
    expect(rbac.allow(mixed, 'GET', '/admin/organizations')).toBe(false);
    expect(rbac.allow(mixed, 'GET', '/admin/organizations/org-a')).toBe(false);
    mixed.platformPatterns = new Set(['GET /admin/organizations']);
    mixed.platform = true;
    expect(rbac.allow(mixed, 'GET', '/admin/organizations')).toBe(true);
  });

  it('registry：organizations 菜单登记（系统目录下，perms=两个 GET 端点）', () => {
    const node = MENU_NODES.find((n) => n.code === 'organizations');
    expect(node).toBeDefined();
    expect(node!.type).toBe(1);
    expect(node!.parent).toBe('g.sys');
    expect(node!.perms).toEqual([
      'GET /admin/organizations',
      'GET /admin/organizations/:id',
    ]);
  });

  it('controller happy-path：端点直通服务层（ok 信封）', async () => {
    const calls: string[] = [];
    const controller = new AdminController(
      {
        organizations: async () => {
          calls.push('list');
          return [{ id: 'org-a', campusCount: 2, userCount: 3 }];
        },
        organizationDetail: async (id: string) => {
          calls.push(`detail:${id}`);
          return { id };
        },
      } as unknown as AdminService,
      new RbacService(new PrismaService()),
    );
    await expect(controller.organizations()).resolves.toBeDefined();
    await expect(controller.organizationDetail('org-a')).resolves.toBeDefined();
    expect(calls).toEqual(['list', 'detail:org-a']);
    // 判权语义钉死：超管请求夹具下端点可调用（guard 层模式已在上文覆盖）
    expect((specReq('admin') as { rbac?: unknown }).rbac).toBeDefined();
  });
});
