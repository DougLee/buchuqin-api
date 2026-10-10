import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { RbacService } from './rbac/rbac.service';
import type { RbacContext } from './rbac/rbac.service';
import { resolveOrganizationByAppId } from '../common/organization';
import type { AuthRequest } from '../auth/jwt-auth.guard';

/**
 * 组织 B 平台端开通流程（IKKRMS，ADR-0001）：
 * - 组织 CRUD（超管）：name/shortName/wxAppId 必填唯一——wxAppId 一经
 *   登记，AppID→组织映射即生效（resolveOrganizationByAppId 命中即限定
 *   组织校区集合），错登记=串组织，故登记/换绑两入口都强查重；
 * - bootstrap 一条龙（超管）：组织管理员（orgLevel='org'+organizationId
 *   绑定+org-admin 预设角色平台级授权）+ 首个校区（organizationId 归属）；
 * - 幂等：已有管理员或校区时返回现状不重复建（部分开通可续开）；
 * - 数据边界抽验（IKKRMP 模式）：组织 B 管理员本组织校区可聚焦，组织 A
 *   校区（真实校区/总部仓）一律 403。
 */
describe('organization bootstrap (IKKRMS / ADR-0001)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const rbac = new RbacService(db);
  const controller = new AdminController(service, rbac);
  const ts = String(Date.now());
  // wxAppId 须 wx+16 位十六进制（CreateOrganizationDto 口径），时间戳+随机转 hex 保证唯一
  const hex = (Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16))
    .padEnd(16, '0')
    .slice(0, 16);
  const WX_APPID = `wx${hex}`;
  const ORG_NAME = `开通测试组织${ts.slice(-6)}`;
  const ORG_SHORT = `开通${ts.slice(-4)}`;
  const ADMIN_USERNAME = `obt${ts}`; // 3-20 位字母/数字/下划线
  const ADMIN_PASSWORD = 'spec-password-8';
  const OPERATOR = `spec-operator-${ts}`;

  let orgId = '';
  let campusId = '';
  let adminAccountId = '';
  let orgBCtx!: RbacContext;
  let campusCountBefore = -1;

  /** 守卫等价请求夹具（org-boundary.spec 同款：ctx 挂 req.rbac） */
  const reqOf = (ctx: RbacContext, query: Record<string, string> = {}): AuthRequest =>
    ({
      rbac: ctx,
      query,
      user: { id: ctx.accountId, campusId: ctx.campusId },
    }) as unknown as AuthRequest;

  beforeAll(async () => {
    await db.rbacState.upsert({
      where: { id: 'global' },
      update: {},
      create: { id: 'global', version: 0 },
    });
    // org-admin 预设角色（启动同步登记；本 spec 幂等兜底——已有行零覆盖）
    await db.adminRole.upsert({
      where: { code: 'org-admin' },
      update: {},
      create: {
        code: 'org-admin',
        name: '组织管理员',
        seeded: true,
        menusMigrated: true,
        assignableBy: 'platform',
        applicableLevel: 'org',
      },
    });
    campusCountBefore = await db.campus.count();
  });

  afterAll(async () => {
    if (adminAccountId)
      await db.adminAccount.deleteMany({ where: { id: adminAccountId } });
    if (campusId) {
      // bootstrap 建校区会复制官方库模板类别集（IKKA1S），连同审计一并清
      await db.auditLog.deleteMany({ where: { entityId: campusId } });
      await db.category.deleteMany({ where: { campusId } });
      await db.campus.deleteMany({ where: { id: campusId } });
    }
    if (orgId) {
      await db.auditLog.deleteMany({ where: { entityId: orgId } });
      await db.organization.deleteMany({ where: { id: orgId } });
    }
    await db.adminAccount.deleteMany({ where: { username: ADMIN_USERNAME } });
    await db.$disconnect();
  });

  it('创建组织：name/shortName/wxAppId 查重拒绝；wxAppId 登记即映射生效；敏感凭据只回布尔', async () => {
    const view = await service.createOrganization(
      {
        name: ORG_NAME,
        shortName: ORG_SHORT,
        wxAppId: WX_APPID,
        wxSecret: 'spec-secret',
        mchId: 'spec-mch',
      },
      OPERATOR,
    );
    orgId = view.id;
    expect(view).toMatchObject({
      name: ORG_NAME,
      shortName: ORG_SHORT,
      status: 'active',
      wxAppId: WX_APPID,
      mchId: 'spec-mch',
      hasWxSecret: true,
      hasMchApiV3Key: false,
    });
    // 只写不回读：响应体不得出现敏感明文字段
    for (const leak of ['wxSecret', 'mchApiV3Key', 'privateKey'])
      expect(view).not.toHaveProperty(leak);
    // 唯一性：name / shortName / wxAppId 任一撞车即 400
    await expect(
      service.createOrganization(
        { name: ORG_NAME, shortName: `他组${ts.slice(-4)}`, wxAppId: `wx${'a'.repeat(16)}` },
        OPERATOR,
      ),
    ).rejects.toThrow('组织名称 已被其他组织登记');
    await expect(
      service.createOrganization(
        { name: `他名${ts.slice(-6)}`, shortName: ORG_SHORT, wxAppId: `wx${'b'.repeat(16)}` },
        OPERATOR,
      ),
    ).rejects.toThrow('组织简称 已被其他组织登记');
    await expect(
      service.createOrganization(
        { name: `他名${ts.slice(-6)}`, shortName: `他组${ts.slice(-4)}`, wxAppId: WX_APPID },
        OPERATOR,
      ),
    ).rejects.toThrow('小程序 AppID 已被其他组织登记');
    // ADR 锚点：登记即生效——AppID→组织映射立即可解析（IKKRMO）
    await expect(resolveOrganizationByAppId(db, WX_APPID)).resolves.toMatchObject({
      id: orgId,
      name: ORG_NAME,
    });
    // 换绑唯一性：改配到已被登记的 AppID 同样拒绝（exclude 自身后查重）
    const other = await service.createOrganization(
      { name: `邻组${ts.slice(-6)}`, shortName: `邻组${ts.slice(-4)}`, wxAppId: `wx${'c'.repeat(16)}` },
      OPERATOR,
    );
    await expect(
      service.updateOrganization(orgId, { wxAppId: other.wxAppId! }, OPERATOR),
    ).rejects.toThrow('小程序 AppID 已被其他组织登记');
    // 显式 null=清除（回落 env 单组织兼容路径），清除后可再登记回自己
    await service.updateOrganization(orgId, { wxAppId: null }, OPERATOR);
    await expect(resolveOrganizationByAppId(db, WX_APPID)).resolves.toBeNull();
    await expect(
      service.updateOrganization(orgId, { wxAppId: WX_APPID }, OPERATOR),
    ).resolves.toMatchObject({ wxAppId: WX_APPID });
    await db.organization.delete({ where: { id: other.id } });
  });

  it('bootstrap：管理员+首校区一次建齐——orgLevel 绑定、org-admin 平台级授权、审计留痕', async () => {
    const result = await service.bootstrapOrganization(
      orgId,
      {
        adminUsername: ADMIN_USERNAME,
        adminPassword: ADMIN_PASSWORD,
        adminNickname: '组织B管理员',
        campusName: '开通测试大学',
        campusShortName: '开通测试',
        campusWarehouseName: '开通测试仓',
      },
      OPERATOR,
    );
    expect(result.created).toEqual({ admin: true, campus: true });
    campusId = result.campus.id;
    adminAccountId = result.admin.id;

    // 组织管理员账号：orgLevel='org' + 固定组织 + 运营落点=首校区
    const account = await db.adminAccount.findUnique({
      where: { id: adminAccountId },
      include: { rbacRoles: { include: { role: true } } },
    });
    expect(account).toMatchObject({
      username: ADMIN_USERNAME,
      orgLevel: 'org',
      organizationId: orgId,
      campusId,
      status: 'active',
    });
    // 默认绑 org-admin 预设角色，按平台级授权（IKKRMQ：数据边界由账号层级收口）
    expect(account!.rbacRoles).toHaveLength(1);
    expect(account!.rbacRoles[0]).toMatchObject({
      scope: 'platform',
      campusId: null,
    });
    expect(account!.rbacRoles[0].role.code).toBe('org-admin');

    // 首个校区：organizationId 归属 + 官方库模板类别集初始化（IKKA1S）
    const campus = await db.campus.findUnique({ where: { id: campusId } });
    expect(campus).toMatchObject({
      name: '开通测试大学',
      shortName: '开通测试',
      warehouseName: '开通测试仓',
      organizationId: orgId,
      status: 'active',
    });
    const officialTemplates = await db.category.count({
      where: { campusId: 'campus-official' },
    });
    if (officialTemplates > 0)
      expect(
        await db.category.count({ where: { campusId } }),
      ).toBe(officialTemplates);

    // 审计留痕（开通一条龙）
    const auditRow = await db.auditLog.findFirst({
      where: { action: 'organization.bootstrap', entityId: orgId },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.after).toMatchObject({
      adminCreated: true,
      campusCreated: true,
    });

    // 装载真实上下文（守卫等价）供边界抽验
    orgBCtx = await rbac.getEffective(account!);
    expect(orgBCtx.orgLevel).toBe('org');
    expect(orgBCtx.organizationId).toBe(orgId);
  });

  it('bootstrap 幂等：重复提交返回现状不重复建；部分开通（先有校区）可续开管理员', async () => {
    // 全量重复：created 全 false、id 原样、库内计数不变
    const adminCount = await db.adminAccount.count({
      where: { orgLevel: 'org', organizationId: orgId },
    });
    const again = await service.bootstrapOrganization(
      orgId,
      {
        // 用户名/密码不再消费（管理员已存在），换值也应零副作用
        adminUsername: `ignored${ts}`,
        adminPassword: 'ignored-password-8',
        campusName: '重复提交大学',
        campusShortName: '重复提交',
        campusWarehouseName: '重复提交仓',
      },
      OPERATOR,
    );
    expect(again.created).toEqual({ admin: false, campus: false });
    expect(again.admin.id).toBe(adminAccountId);
    expect(again.campus.id).toBe(campusId);
    await expect(
      db.adminAccount.count({ where: { orgLevel: 'org', organizationId: orgId } }),
    ).resolves.toBe(adminCount);
    expect(await db.campus.count()).toBe(campusCountBefore + 1);

    // 部分开通续开：新组织先手建校区（无管理员），bootstrap 只补管理员
    const partialOrg = await service.createOrganization(
      { name: `续开组织${ts.slice(-6)}`, shortName: `续开${ts.slice(-4)}`, wxAppId: `wx${'d'.repeat(16)}` },
      OPERATOR,
    );
    const partialCampus = await db.campus.create({
      data: {
        name: '续开大学',
        shortName: '续开大学',
        warehouseName: '续开仓',
        organizationId: partialOrg.id,
      },
    });
    const resumed = await service.bootstrapOrganization(
      partialOrg.id,
      {
        adminUsername: `rsm${ts}`,
        adminPassword: ADMIN_PASSWORD,
        campusName: '不再建的校区',
        campusShortName: '不再建',
        campusWarehouseName: '不再建仓',
      },
      OPERATOR,
    );
    expect(resumed.created).toEqual({ admin: true, campus: false });
    expect(resumed.campus.id).toBe(partialCampus.id);
    expect(
      await db.campus.count({ where: { organizationId: partialOrg.id } }),
    ).toBe(1);
    // 清理续开夹具
    await db.adminAccount.deleteMany({ where: { id: resumed.admin.id } });
    await db.auditLog.deleteMany({
      where: { entityId: { in: [partialCampus.id, partialOrg.id] } },
    });
    await db.campus.deleteMany({ where: { id: partialCampus.id } });
    await db.organization.deleteMany({ where: { id: partialOrg.id } });
  });

  it('数据边界抽验（IKKRMP 模式）：组织 B 管理员本组织校区可聚焦，组织 A 校区 403', async () => {
    // 缺省=本组织运营落点（首校区）
    await expect(controller['campusScope'](reqOf(orgBCtx))).resolves.toBe(campusId);
    // 本组织校区显式指定 OK（组织内切换无需逐校区授权）
    await expect(
      controller['campusScope'](reqOf(orgBCtx, { campus: campusId })),
    ).resolves.toBe(campusId);
    // 组织 A 真实校区/总部仓：一律 403（看不到 org-a 数据）
    for (const foreign of ['campus-hbut', 'campus-hq']) {
      await expect(
        controller['scopedCampus'](reqOf(orgBCtx, { campus: foreign })),
      ).rejects.toThrow(ForbiddenException);
    }
  });

  it('停用组织不可开通（先启用再开）；启停审计留痕', async () => {
    await service.setOrganizationStatus(orgId, 'disabled', OPERATOR);
    await expect(
      service.bootstrapOrganization(
        orgId,
        {
          adminUsername: ADMIN_USERNAME,
          adminPassword: ADMIN_PASSWORD,
          campusName: '停用态校区',
          campusShortName: '停用态',
          campusWarehouseName: '停用态仓',
        },
        OPERATOR,
      ),
    ).rejects.toThrow('组织已停用，请先启用再开通');
    await expect(
      db.auditLog.findFirst({
        where: { action: 'organization.status', entityId: orgId },
      }),
    ).resolves.toMatchObject({
      before: { status: 'active' },
      after: { status: 'disabled' },
    });
    await service.setOrganizationStatus(orgId, 'active', OPERATOR);
  });
});
