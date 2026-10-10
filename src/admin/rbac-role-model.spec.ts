import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AdminController } from './admin.controller';
import { RbacService, canAssignRole } from './rbac/rbac.service';
import type { RbacContext } from './rbac/rbac.service';
import {
  MENU_NODE_CODES,
  PRESET_ROLES,
  ROLE_TEMPLATES,
  SUPER_ROLE_CODE,
} from './rbac/registry';
import type { AuthRequest } from '../auth/jwt-auth.guard';

/**
 * 统一角色管理（IKKRMQ）：多角色、预设角色与超级管理员。
 * - 预设角色登记：super-admin（内置通配钉死不可编辑/删/授予）+ org-admin
 *   （组织域读+校区经营，从 campus-admin 裁剪）+ campus-admin（= campus-operator
 *   全集+落位配置）+ campus-operator（对齐旧 campus-operations 迁移模板）；
 *   仅登记菜单树与说明，实际权限勾选仍走角色管理页（首灌后启动同步不重置）。
 * - 多角色叠加语义：账号绑多角色（AdminAccountRole 多行）功能权限=并集，
 *   数据范围不因角色改变（orgLevel/organizationId/campusId 决定，IKKRMP）；
 *   勾父菜单不隐式授予子写按钮（perms 平铺：菜单行只带自身 GET 模式）。
 * - 分配边界（service 层防御）：assignableBy（platform 仅超管 | org | campus）
 *   × applicableLevel（null 不限 | org | campus 适配目标账号层级）；超管全可。
 */
describe('role model (IKKRMQ)', () => {
  /* ==================== 一、预设角色登记（纯单元） ==================== */

  describe('预设角色登记（registry）', () => {
    it('四个预设角色齐备：super-admin / org-admin / campus-admin / campus-operator', () => {
      expect(PRESET_ROLES.map((p) => p.code)).toEqual([
        SUPER_ROLE_CODE,
        'org-admin',
        'campus-admin',
        'campus-operator',
      ]);
    });

    it('分配边界登记：org-admin=platform→org 账号；campus-admin=org→campus；campus-operator=campus→campus', () => {
      const by = (code: string) => PRESET_ROLES.find((p) => p.code === code)!;
      expect(by('org-admin')).toMatchObject({
        assignableBy: 'platform',
        applicableLevel: 'org',
      });
      expect(by('campus-admin')).toMatchObject({
        assignableBy: 'org',
        applicableLevel: 'campus',
      });
      expect(by('campus-operator')).toMatchObject({
        assignableBy: 'campus',
        applicableLevel: 'campus',
      });
      expect(by(SUPER_ROLE_CODE)).toMatchObject({
        assignableBy: 'platform',
        applicableLevel: null,
      });
    });

    it('campus-operator 与旧 campus-operations 迁移模板逐节点对齐（钉死不漂移）', () => {
      const preset = PRESET_ROLES.find((p) => p.code === 'campus-operator')!;
      const template = ROLE_TEMPLATES.find(
        (t) => t.code === 'campus-operations',
      )!;
      expect([...preset.menuCodes].sort()).toEqual(
        [...template.menuCodes].sort(),
      );
    });

    it('campus-admin ⊇ campus-operator，另含校区落位配置三节点', () => {
      const admin = PRESET_ROLES.find((p) => p.code === 'campus-admin')!;
      const operator = PRESET_ROLES.find((p) => p.code === 'campus-operator')!;
      for (const c of operator.menuCodes) expect(admin.menuCodes).toContain(c);
      for (const c of [
        'campus-config',
        'campus-config.slots',
        'campus-config.notices',
      ])
        expect(admin.menuCodes).toContain(c);
    });

    it('org-admin= campus-admin 裁剪：含组织域读（organizations），裁掉驻场执行与单校区落位配置', () => {
      const org = PRESET_ROLES.find((p) => p.code === 'org-admin')!;
      expect(org.menuCodes).toContain('organizations');
      // 裁剪：驻场执行（拣货出库/拣货任务/流水/库位）+ 单校区落位（配送配置/时段/公告）
      for (const c of [
        'inventory.outbound',
        'warehouse-orders',
        'inventory-txns',
        'locations',
        'locations.write',
        'campus-config',
        'campus-config.slots',
        'campus-config.notices',
        'campuses.config.write',
      ])
        expect(org.menuCodes).not.toContain(c);
      // 保留经营管理面
      for (const c of [
        'orders.write',
        'after-sales.audit',
        'products.price',
        'inventory.adjust',
      ])
        expect(org.menuCodes).toContain(c);
    });

    it('super-admin 登记为通配：不落菜单行；全部预设引用的节点均已登记', () => {
      expect(
        PRESET_ROLES.find((p) => p.code === SUPER_ROLE_CODE)!.menuCodes,
      ).toEqual([]);
      for (const p of PRESET_ROLES)
        for (const c of p.menuCodes) expect(MENU_NODE_CODES.has(c)).toBe(true);
    });
  });

  /* ==================== 二、分配规则（canAssignRole 纯函数） ==================== */

  describe('分配规则 canAssignRole（超管全可；层级下放收口）', () => {
    it('超管操作者：任何 assignableBy × applicableLevel × 目标层级全可', () => {
      const superOp = { super: true as const, orgLevel: 'campus' as const };
      for (const assignableBy of ['platform', 'org', 'campus'] as const)
        for (const applicableLevel of [null, 'org', 'campus'] as const)
          for (const target of ['platform', 'org', 'campus'] as const)
            expect(
              canAssignRole(superOp, { assignableBy, applicableLevel }, target),
            ).toBe(true);
    });

    it('org 级操作者：仅 assignableBy∈{org,campus}；applicableLevel 须适配目标层级（null 不限）', () => {
      const orgOp = { super: false, orgLevel: 'org' as const };
      expect(canAssignRole(orgOp, { assignableBy: 'platform' }, 'org')).toBe(
        false,
      );
      expect(
        canAssignRole(
          orgOp,
          { assignableBy: 'org', applicableLevel: 'org' },
          'org',
        ),
      ).toBe(true);
      // 具层级角色不下放给不匹配目标（含平台级目标）
      expect(
        canAssignRole(
          orgOp,
          { assignableBy: 'org', applicableLevel: 'org' },
          'campus',
        ),
      ).toBe(false);
      expect(
        canAssignRole(
          orgOp,
          { assignableBy: 'org', applicableLevel: 'org' },
          'platform',
        ),
      ).toBe(false);
      expect(
        canAssignRole(
          orgOp,
          { assignableBy: 'campus', applicableLevel: 'campus' },
          'campus',
        ),
      ).toBe(true);
      // null=不限层级
      expect(
        canAssignRole(
          orgOp,
          { assignableBy: 'org', applicableLevel: null },
          'campus',
        ),
      ).toBe(true);
      expect(
        canAssignRole(
          orgOp,
          { assignableBy: 'campus', applicableLevel: null },
          'org',
        ),
      ).toBe(true);
    });

    it('campus 级操作者：仅 assignableBy=campus；平台独占与 org 级角色一律拒', () => {
      const campusOp = { super: false, orgLevel: 'campus' as const };
      expect(
        canAssignRole(
          campusOp,
          { assignableBy: 'campus', applicableLevel: 'campus' },
          'campus',
        ),
      ).toBe(true);
      expect(
        canAssignRole(
          campusOp,
          { assignableBy: 'campus', applicableLevel: null },
          'campus',
        ),
      ).toBe(true);
      expect(canAssignRole(campusOp, { assignableBy: 'org' }, 'campus')).toBe(
        false,
      );
      expect(
        canAssignRole(campusOp, { assignableBy: 'platform' }, 'campus'),
      ).toBe(false);
    });

    it('非超管平台层操作者：一律不可分配（平台层分配权超管独占，fail closed）', () => {
      const plainOp = { super: false, orgLevel: 'platform' as const };
      for (const assignableBy of ['platform', 'org', 'campus'] as const)
        expect(canAssignRole(plainOp, { assignableBy }, 'org')).toBe(false);
      // 未标层级信息的操作者按最紧处理（同非超管平台层）
      expect(canAssignRole({}, { assignableBy: 'campus' }, 'campus')).toBe(
        false,
      );
      // 列值缺省语义：assignableBy 未落库按 'platform'（现状收紧默认）
      expect(canAssignRole({ super: false, orgLevel: 'org' }, {}, 'org')).toBe(
        false,
      );
    });
  });

  /* ==================== 三、叠加语义 / service 层防御 / super-admin 保护（DB） ==================== */

  const db = new PrismaService();
  const rbac = new RbacService(db);
  const controller = new AdminController({} as never, rbac);
  const ts = String(Date.now());
  const ORG = `orgspecq${ts}`;
  const C1 = `campus-spec-q1-${ts}`;
  const C2 = `campus-spec-q2-${ts}`;
  // 分配边界夹具角色：platform 独占 / org 专用 / campus 专用 / org 不限层级
  const RP = `spec-q-rp-${ts}`;
  const RO = `spec-q-ro-${ts}`;
  const RC = `spec-q-rc-${ts}`;
  const RN = `spec-q-rn-${ts}`;
  // 叠加夹具角色：R1=仅商品菜单行（父）；R2=仅商品编辑按钮（子写）
  const R1 = `spec-q-r1-${ts}`;
  const R2 = `spec-q-r2-${ts}`;
  const SUPER_ACTOR = {
    id: `spec-q-super-${ts}`,
    username: 'spec-q',
    super: true,
  };
  const ORG_ACTOR = {
    id: `spec-q-org-${ts}`,
    username: 'spec-q',
    super: false,
    orgLevel: 'org' as const,
  };
  const CAMPUS_ACTOR = {
    id: `spec-q-campus-${ts}`,
    username: 'spec-q',
    super: false,
    orgLevel: 'campus' as const,
  };
  const PLAIN_ACTOR = { id: `spec-q-plain-${ts}`, username: 'spec-q' };
  const accountIds: string[] = [];
  const usernames = [
    `specq_union_${ts}`,
    `specq_parent_${ts}`,
    `specq_orgstack_${ts}`,
    `specq_torg_${ts}`,
    `specq_tcampus_${ts}`,
    `specq_flip_${ts}`,
  ];

  const reqOf = (
    ctx: RbacContext,
    query: Record<string, string> = {},
  ): AuthRequest =>
    ({
      rbac: ctx,
      query,
      user: { id: ctx.accountId, campusId: ctx.campusId },
    }) as unknown as AuthRequest;

  const mkAccount = (
    username: string,
    data: { campusId: string; orgLevel?: string; organizationId?: string },
    grants: {
      roleId: string;
      scope: 'platform' | 'campus';
      campusId?: string;
    }[],
  ) =>
    db.$transaction(async (tx) => {
      const acc = await tx.adminAccount.create({
        data: {
          username,
          passwordHash: 'x',
          role: 'rbac',
          rbacMigrated: true,
          ...data,
        },
      });
      accountIds.push(acc.id);
      for (const g of grants) {
        await tx.adminAccountRole.create({
          data: {
            accountId: acc.id,
            roleId: g.roleId,
            scope: g.scope,
            campusId: g.scope === 'campus' ? g.campusId! : null,
            grantedBy: 'spec',
          },
        });
      }
      return acc;
    });

  let unionCtx!: RbacContext;
  let parentCtx!: RbacContext;
  let orgStackCtx!: RbacContext;
  let targetOrgId!: string;
  let targetCampusId!: string;
  let flipAccountId!: string;

  beforeAll(async () => {
    // 启动同步：登记菜单树 + 预设角色（幂等；本地库已迁移过其余步骤为 no-op）
    await rbac.syncRegistry();
    await db.organization.create({
      data: { id: ORG, name: '角色模型测试组织', shortName: 'Q' },
    });
    for (const [id, name] of [
      [C1, '角色模型一号'],
      [C2, '角色模型二号'],
    ] as const) {
      await db.campus.create({
        data: {
          id,
          name,
          shortName: name.slice(0, 4),
          warehouseName: `${name}仓`,
          organizationId: ORG,
        },
      });
    }
    const mkRole = async (
      code: string,
      menuCodes: string[],
      boundary: { assignableBy: string; applicableLevel: string | null },
    ) => {
      const role = await db.adminRole.create({
        data: {
          code,
          name: code,
          seeded: true,
          menusMigrated: true,
          ...boundary,
        },
      });
      const menus = await db.adminMenu.findMany({
        where: { code: { in: menuCodes } },
        select: { id: true },
      });
      if (menus.length)
        await db.adminRoleMenu.createMany({
          data: menus.map((m) => ({ roleId: role.id, menuId: m.id })),
        });
      return role;
    };
    const [rp, ro, rc, rn, r1, r2] = await Promise.all([
      mkRole(RP, ['audit'], {
        assignableBy: 'platform',
        applicableLevel: null,
      }),
      mkRole(RO, ['rules'], { assignableBy: 'org', applicableLevel: 'org' }),
      mkRole(RC, ['locations'], {
        assignableBy: 'campus',
        applicableLevel: 'campus',
      }),
      mkRole(RN, ['organizations'], {
        assignableBy: 'org',
        applicableLevel: null,
      }),
      mkRole(R1, ['products'], {
        assignableBy: 'campus',
        applicableLevel: null,
      }),
      mkRole(R2, ['products.write'], {
        assignableBy: 'campus',
        applicableLevel: null,
      }),
    ]);
    void rp;

    // 多角色并集：campus 级账号同校区绑 R1（父菜单）+R2（子写按钮）
    const unionAccount = await mkAccount(
      usernames[0],
      { campusId: C1, orgLevel: 'campus' },
      [
        { roleId: r1.id, scope: 'campus', campusId: C1 },
        { roleId: r2.id, scope: 'campus', campusId: C1 },
      ],
    );
    unionCtx = await rbac.getEffective(unionAccount);

    // 仅父菜单（无子按钮）：勾菜单不隐式授写
    const parentAccount = await mkAccount(
      usernames[1],
      { campusId: C1, orgLevel: 'campus' },
      [{ roleId: r1.id, scope: 'campus', campusId: C1 }],
    );
    parentCtx = await rbac.getEffective(parentAccount);

    // org 级账号叠加平台级角色（RN 含组织域读）：层级优先于平台视角
    const orgStackAccount = await mkAccount(
      usernames[2],
      { campusId: C1, orgLevel: 'org', organizationId: ORG },
      [{ roleId: rn.id, scope: 'platform' }],
    );
    orgStackCtx = await rbac.getEffective(orgStackAccount);

    // 分配边界目标账号：org 级 / campus 级各一
    const targetOrg = await mkAccount(
      usernames[3],
      { campusId: C1, orgLevel: 'org', organizationId: ORG },
      [],
    );
    targetOrgId = targetOrg.id;
    const targetCampus = await mkAccount(
      usernames[4],
      { campusId: C1, orgLevel: 'campus' },
      [],
    );
    targetCampusId = targetCampus.id;
    const flip = await mkAccount(
      usernames[5],
      { campusId: C1, orgLevel: 'campus' },
      [],
    );
    flipAccountId = flip.id;
  });

  afterAll(async () => {
    await db.adminAccount.deleteMany({ where: { id: { in: accountIds } } });
    await db.adminAccount.deleteMany({
      where: { username: { in: usernames } },
    });
    // role_menu 外键无级联（Restrict），先清关联再删角色
    await db.adminRoleMenu.deleteMany({
      where: { role: { code: { in: [RP, RO, RC, RN, R1, R2] } } },
    });
    await db.adminRole.deleteMany({
      where: { code: { in: [RP, RO, RC, RN, R1, R2] } },
    });
    await db.campus.deleteMany({ where: { id: { in: [C1, C2] } } });
    await db.organization.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  /* ---------- 多角色叠加：功能并集、数据范围不变 ---------- */

  it('多角色并集：patterns/menuCodes=两角色菜单 perms 并集', () => {
    expect(unionCtx.patterns.has('GET /admin/products')).toBe(true); // R1 菜单行
    expect(unionCtx.patterns.has('POST /admin/products')).toBe(true); // R2 按钮行
    expect(unionCtx.patterns.has('PATCH /admin/products/:id')).toBe(true); // R2
    expect(unionCtx.menuCodes.has('products')).toBe(true);
    expect(rbac.allow(unionCtx, 'GET', '/admin/products')).toBe(true);
    expect(rbac.allow(unionCtx, 'POST', '/admin/products')).toBe(true);
  });

  it('角色只叠加功能权限不改数据范围：orgLevel/campuses/缺省落点不因多角色放大', async () => {
    expect(unionCtx.orgLevel).toBe('campus'); // 账号属性，角色不改
    expect(unionCtx.platform).toBe(false);
    expect(unionCtx.campuses).toEqual([C1]); // 授权集=绑定校区（多角色去重）
    expect(await controller['campusScope'](reqOf(unionCtx))).toBe(C1);
    await expect(
      controller['campusScope'](reqOf(unionCtx, { campus: C2 })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('勾父菜单不隐式授予子写按钮：菜单行只带自身 GET 模式，写按钮须单独勾选', () => {
    expect(parentCtx.patterns.has('GET /admin/products')).toBe(true);
    expect(parentCtx.patterns.has('POST /admin/products')).toBe(false);
    expect(parentCtx.patterns.has('PATCH /admin/products/:id')).toBe(false);
    expect(rbac.allow(parentCtx, 'GET', '/admin/products')).toBe(true);
    expect(rbac.allow(parentCtx, 'POST', '/admin/products')).toBe(false);
    expect(rbac.allow(parentCtx, 'PATCH', '/admin/products/x')).toBe(false);
    // 按钮行不进 menuCodes（目录/菜单行才可见）
    expect(parentCtx.menuCodes.has('products')).toBe(true);
    expect(parentCtx.menuCodes.has('products.write')).toBe(false);
  });

  it('org 级账号叠加平台级角色（组织域读）：功能可读组织，边界仍按组织收口', async () => {
    expect(orgStackCtx.platform).toBe(true);
    expect(orgStackCtx.orgLevel).toBe('org');
    expect(orgStackCtx.organizationId).toBe(ORG);
    // 平台级角色携带平台功能（组织域读）
    expect(rbac.allow(orgStackCtx, 'GET', '/admin/organizations')).toBe(true);
    // 数据边界：本组织校区可聚焦、越组织 403、缺省本落点
    expect(
      await controller['campusScope'](reqOf(orgStackCtx, { campus: C2 })),
    ).toBe(C2);
    await expect(
      controller['campusScope'](reqOf(orgStackCtx, { campus: 'campus-hbut' })),
    ).rejects.toThrow(ForbiddenException);
    expect(await controller['campusScope'](reqOf(orgStackCtx))).toBe(C1);
  });

  /* ---------- service 层防御：assignableBy / applicableLevel ---------- */

  it('超管操作者全可：平台独占角色（assignableBy=platform）照常授予', async () => {
    await rbac.setAccountRoles(SUPER_ACTOR, targetCampusId, [
      { roleCode: RP, scope: 'campus', campusId: C1 },
    ]);
    const rows = await db.adminAccountRole.findMany({
      where: { accountId: targetCampusId },
      include: { role: { select: { code: true } } },
    });
    expect(rows.map((r) => r.role.code)).toEqual([RP]);
  });

  it('org 级操作者：平台独占角色拒（403）；org 专用角色只适配 org 级目标', async () => {
    await expect(
      rbac.setAccountRoles(ORG_ACTOR, targetOrgId, [
        { roleCode: RP, scope: 'campus', campusId: C1 },
      ]),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      rbac.setAccountRoles(ORG_ACTOR, targetCampusId, [
        { roleCode: RO, scope: 'campus', campusId: C1 },
      ]),
    ).rejects.toThrow(/不允许由当前操作者分配/);
    // assignableBy=org 且 applicableLevel=org：org 级目标放行
    await rbac.setAccountRoles(ORG_ACTOR, targetOrgId, [
      { roleCode: RO, scope: 'campus', campusId: C1 },
    ]);
    // assignableBy=org、applicableLevel=null：campus 级目标亦放行（不限层级）
    await rbac.setAccountRoles(ORG_ACTOR, targetCampusId, [
      { roleCode: RN, scope: 'campus', campusId: C1 },
    ]);
  });

  it('campus 级操作者：仅 assignableBy=campus；未标层级信息的操作者 fail closed', async () => {
    await rbac.setAccountRoles(CAMPUS_ACTOR, targetCampusId, [
      { roleCode: RC, scope: 'campus', campusId: C1 },
    ]);
    await expect(
      rbac.setAccountRoles(CAMPUS_ACTOR, targetCampusId, [
        { roleCode: RN, scope: 'campus', campusId: C1 },
      ]),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      rbac.setAccountRoles(PLAIN_ACTOR, targetCampusId, [
        { roleCode: RC, scope: 'campus', campusId: C1 },
      ]),
    ).rejects.toThrow(ForbiddenException);
  });

  it('updateAccount 同请求改层级+授权：按合并态层级校验适配', async () => {
    // 合并态=org（同请求升级）：org 专用角色适配放行
    await rbac.updateAccount(ORG_ACTOR, flipAccountId, {
      orgLevel: 'org',
      organizationId: ORG,
      grants: [{ roleCode: RO, scope: 'campus', campusId: C1 }],
    });
    const flipped = await db.adminAccount.findUnique({
      where: { id: flipAccountId },
    });
    expect(flipped?.orgLevel).toBe('org');
    // 合并态=org：campus 专用角色（applicableLevel=campus）不适配拒
    await expect(
      rbac.updateAccount(ORG_ACTOR, flipAccountId, {
        grants: [{ roleCode: RC, scope: 'campus', campusId: C1 }],
      }),
    ).rejects.toThrow(/不允许由当前操作者分配/);
  });

  /* ---------- super-admin 保护与预设首灌 ---------- */

  it('super-admin 不可经授权通道授予（系统仅保留内置主账号）', async () => {
    await expect(
      rbac.setAccountRoles(SUPER_ACTOR, targetCampusId, [
        { roleCode: SUPER_ROLE_CODE, scope: 'platform' },
      ]),
    ).rejects.toThrow('超级管理员不可授予');
  });

  it('启动同步登记预设角色：边界值落库、菜单首灌齐平', async () => {
    const rows = await db.adminRole.findMany({
      where: { code: { in: ['org-admin', 'campus-admin', 'campus-operator'] } },
    });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const def = PRESET_ROLES.find((p) => p.code === row.code)!;
      expect(row.seeded).toBe(true);
      expect(row.assignableBy).toBe(def.assignableBy);
      expect(row.applicableLevel).toBe(def.applicableLevel);
      expect(await db.adminRoleMenu.count({ where: { roleId: row.id } })).toBe(
        def.menuCodes.length,
      );
    }
    const superRow = await db.adminRole.findUnique({
      where: { code: SUPER_ROLE_CODE },
    });
    expect(superRow?.builtin).toBe(true);
    expect(superRow?.status).toBe('active');
    expect(superRow?.assignableBy).toBe('platform');
  });

  it('super-admin 不可编辑不可删除；预设角色可由超管经菜单树维护且不被启动同步重置', async () => {
    const superRow = (await db.adminRole.findUnique({
      where: { code: SUPER_ROLE_CODE },
    }))!;
    await expect(
      rbac.updateRole({ username: 'spec-q' }, superRow.id, { name: 'x' }),
    ).rejects.toThrow('内置超级管理员不可编辑');
    await expect(
      rbac.deleteRole({ username: 'spec-q' }, superRow.id),
    ).rejects.toThrow('内置超级管理员不可删除');

    // 预设角色（非 builtin）可编辑：菜单树全量重设
    const opRow = (await db.adminRole.findUnique({
      where: { code: 'campus-operator' },
    }))!;
    await rbac.updateRole({ username: 'spec-q' }, opRow.id, {
      menuCodes: ['dashboard'],
    });
    expect(await db.adminRoleMenu.count({ where: { roleId: opRow.id } })).toBe(
      1,
    );
    // 再跑启动同步不重置（seeded 后实际权限勾选以角色管理页为准）
    await rbac.syncRegistry();
    expect(await db.adminRoleMenu.count({ where: { roleId: opRow.id } })).toBe(
      1,
    );
    // 还原完整首灌菜单（不留脏状态）
    const def = PRESET_ROLES.find((p) => p.code === 'campus-operator')!;
    await rbac.updateRole({ username: 'spec-q' }, opRow.id, {
      menuCodes: def.menuCodes,
    });
    expect(await db.adminRoleMenu.count({ where: { roleId: opRow.id } })).toBe(
      def.menuCodes.length,
    );
  });
});
