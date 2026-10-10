import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AdminController } from './admin.controller';
import { RbacService, resolveOrgLevel } from './rbac/rbac.service';
import type { RbacContext } from './rbac/rbac.service';
import { legacyRbacCtx } from './rbac/spec-fixtures';
import type { AuthRequest } from '../auth/jwt-auth.guard';

/**
 * 固定后台账号数据边界（IKKRMP，ADR-0001）：
 * - AdminAccount.orgLevel/organizationId：'platform' 跨组织不受限 | 'org'
 *   固定组织（目标校区必须属于该组织）| 'campus' 恒本校区/授权集；
 *   NULL=历史账号按 campusId 推导（空/campus-hq→平台级，其余校区级）；
 * - campusScope/scopedCampus/assertCampusAllowed 消费 org 级边界：
 *   ?campus= 本组织任意校区（无需逐校区授权）、越组织 403、缺省本落点；
 *   每次请求实时查归属，切换不改变边界；
 * - 账号 CRUD（仅超管端点）：org 级必须指定已存在组织；platform/campus
 *   级不得指定组织。
 * 双组织 fixture：org-b（本 spec 自建）vs 组织 A（存量 org-a 基线）。
 */
describe('org boundary (IKKRMP / ADR-0001)', () => {
  const db = new PrismaService();
  const rbac = new RbacService(db);
  const controller = new AdminController({} as never, rbac);
  const ts = String(Date.now());
  const ORG_B = `orgspecb${ts}`;
  const CAMPUS_B1 = `campus-spec-b1-${ts}`;
  const CAMPUS_B2 = `campus-spec-b2-${ts}`;
  const ROLE_CODE = `spec-org-boundary-${ts}`;
  const ACTOR = { id: `spec-actor-${ts}`, username: 'spec' };
  const accountIds: string[] = [];
  const usernames = [
    `specob_org_${ts}`,
    `specob_orgp_${ts}`,
    `specob_hist_${ts}`,
    `specob_real_${ts}`,
    `specob_crud_${ts}`,
  ];
  const passwordHashPlaceholder = 'x';

  /** 以真实 getEffective 结果构造请求夹具（守卫等价：ctx 挂 req.rbac） */
  const reqOf = (ctx: RbacContext, query: Record<string, string> = {}): AuthRequest =>
    ({
      rbac: ctx,
      query,
      user: { id: ctx.accountId, campusId: ctx.campusId },
    }) as unknown as AuthRequest;

  let orgCtx!: RbacContext;
  let orgPlatformRoleCtx!: RbacContext;
  let histHqCtx!: RbacContext;
  let histRealCtx!: RbacContext;

  beforeAll(async () => {
    await db.rbacState.upsert({
      where: { id: 'global' },
      update: {},
      create: { id: 'global', version: 0 },
    });
    await db.organization.create({
      data: { id: ORG_B, name: '边界测试组织B', shortName: 'B' },
    });
    for (const [id, name] of [
      [CAMPUS_B1, '边界测试大学一号'],
      [CAMPUS_B2, '边界测试大学二号'],
    ] as const) {
      await db.campus.create({
        data: {
          id,
          name,
          shortName: name.slice(0, 4),
          warehouseName: `${name}仓`,
          organizationId: ORG_B,
        },
      });
    }
    const role = await db.adminRole.upsert({
      where: { code: ROLE_CODE },
      update: {},
      create: { code: ROLE_CODE, name: '边界测试角色', seeded: true, menusMigrated: true },
    });

    const mkAccount = (
      username: string,
      data: { campusId: string; orgLevel?: string; organizationId?: string },
      grants: { scope: 'platform' | 'campus'; campusId?: string }[],
    ) =>
      db.$transaction(async (tx) => {
        const acc = await tx.adminAccount.create({
          data: {
            username,
            passwordHash: passwordHashPlaceholder,
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
              roleId: role.id,
              scope: g.scope,
              campusId: g.scope === 'campus' ? g.campusId! : null,
              grantedBy: 'spec',
            },
          });
        }
        return acc;
      });

    // 组织级账号：固定 org-b，落点 B1，仅 B1 有校区级授权（B2 无授权——
    // 组织内切换不依赖逐校区授权是本 issue 的核心语义）
    const orgAccount = await mkAccount(
      usernames[0],
      { campusId: CAMPUS_B1, orgLevel: 'org', organizationId: ORG_B },
      [{ scope: 'campus', campusId: CAMPUS_B1 }],
    );
    orgCtx = await rbac.getEffective(orgAccount);

    // 组织级账号持有平台级角色：层级（账号属性）优先于平台视角
    const orgPlatformRoleAccount = await mkAccount(
      usernames[1],
      { campusId: CAMPUS_B1, orgLevel: 'org', organizationId: ORG_B },
      [{ scope: 'platform' }],
    );
    orgPlatformRoleCtx = await rbac.getEffective(orgPlatformRoleAccount);

    // 历史账号（orgLevel NULL）落总部仓：推导=平台级；IKKRMM 语义下
    // organizationId 仍按校区推导=org-a（行为零变化回归锚点）
    const histHqAccount = await mkAccount(
      usernames[2],
      { campusId: 'campus-hq' },
      [{ scope: 'campus', campusId: 'campus-hq' }],
    );
    histHqCtx = await rbac.getEffective(histHqAccount);

    // 历史账号（orgLevel NULL）落真实校区：推导=校区级
    const histRealAccount = await mkAccount(
      usernames[3],
      { campusId: 'campus-hbut' },
      [{ scope: 'campus', campusId: 'campus-hbut' }],
    );
    histRealCtx = await rbac.getEffective(histRealAccount);
  });

  afterAll(async () => {
    await db.adminAccount.deleteMany({ where: { id: { in: accountIds } } });
    await db.adminAccount.deleteMany({ where: { username: { in: usernames } } });
    await db.adminRole.deleteMany({ where: { code: ROLE_CODE } });
    await db.campus.deleteMany({ where: { id: { in: [CAMPUS_B1, CAMPUS_B2] } } });
    await db.organization.deleteMany({ where: { id: ORG_B } });
    await db.$disconnect();
  });

  /* ==================== ctx 装载：orgLevel / organizationId ==================== */

  it('getEffective：组织级账号 organizationId 显式优先（含平台角色）；orgLevel 记入 ctx', () => {
    expect(orgCtx.orgLevel).toBe('org');
    expect(orgCtx.organizationId).toBe(ORG_B);
    expect(orgCtx.platform).toBe(false);
    // 平台级角色不改变固定组织归属（账号属性优先）
    expect(orgPlatformRoleCtx.platform).toBe(true);
    expect(orgPlatformRoleCtx.orgLevel).toBe('org');
    expect(orgPlatformRoleCtx.organizationId).toBe(ORG_B);
  });

  it('历史账号推导回归：campus-hq/空 campusId→platform，真实校区→campus；organizationId 沿用 IKKRMM 推导', () => {
    expect(resolveOrgLevel('')).toBe('platform');
    expect(resolveOrgLevel('campus-hq')).toBe('platform');
    expect(resolveOrgLevel('campus-hbut')).toBe('campus');
    // 落总部仓的历史账号：推导平台级，但无平台角色→organizationId 仍=org-a（零变化）
    expect(histHqCtx.orgLevel).toBe('platform');
    expect(histHqCtx.platform).toBe(false);
    expect(histHqCtx.organizationId).toBe('org-a');
    // 落真实校区的历史账号：校区级 + org-a
    expect(histRealCtx.orgLevel).toBe('campus');
    expect(histRealCtx.organizationId).toBe('org-a');
  });

  /* ==================== 数据边界：三helpers（org 级） ==================== */

  it('org 级账号：?campus= 本组织任意校区 OK（无需逐校区授权）、缺省本落点', async () => {
    // B2 无任何授权，组织边界放行
    expect(await controller['campusScope'](reqOf(orgCtx, { campus: CAMPUS_B2 }))).toBe(CAMPUS_B2);
    expect(await controller['scopedCampus'](reqOf(orgCtx, { campus: CAMPUS_B2 }))).toBe(CAMPUS_B2);
    expect(await controller['assertCampusAllowed'](reqOf(orgCtx), CAMPUS_B2)).toBe(CAMPUS_B2);
    expect(await controller['campusScope'](reqOf(orgCtx))).toBe(CAMPUS_B1);
  });

  it('org 级账号访问组织 A 校区：403（真实校区/总部仓/平台伪校区一律拒）', async () => {
    for (const foreign of ['campus-hbut', 'campus-hq', 'campus-official']) {
      await expect(
        controller['campusScope'](reqOf(orgCtx, { campus: foreign })),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller['scopedCampus'](reqOf(orgCtx, { campus: foreign })),
      ).rejects.toThrow(ForbiddenException);
    }
    await expect(
      controller['assertCampusAllowed'](reqOf(orgCtx), 'campus-hbut'),
    ).rejects.toThrow(ForbiddenException);
    // 不存在的校区：400（与平台口径一致的失败类）
    await expect(
      controller['campusScope'](reqOf(orgCtx, { campus: `campus-x-${ts}` })),
    ).rejects.toThrow(BadRequestException);
  });

  it('org 级账号持有平台级角色：边界仍按组织收口（层级优先于平台视角）', async () => {
    expect(orgPlatformRoleCtx.platform).toBe(true);
    await expect(
      controller['campusScope'](reqOf(orgPlatformRoleCtx, { campus: CAMPUS_B2 })),
    ).resolves.toBe(CAMPUS_B2);
    await expect(
      controller['campusScope'](reqOf(orgPlatformRoleCtx, { campus: 'campus-hbut' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('平台级账号不受限：跨组织校区均可聚焦/操作', async () => {
    const platformReq = reqOf(legacyRbacCtx('admin'));
    expect(await controller['campusScope'](reqOf(legacyRbacCtx('admin'), { campus: CAMPUS_B1 }))).toBe(CAMPUS_B1);
    expect(await controller['scopedCampus'](reqOf(legacyRbacCtx('admin'), { campus: CAMPUS_B1 }))).toBe(CAMPUS_B1);
    expect(await controller['assertCampusAllowed'](platformReq, CAMPUS_B2)).toBe(CAMPUS_B2);
    // 缺省空串=跨校区全量（平台语义不变）
    expect(await controller['campusScope'](platformReq)).toBe('');
  });

  it('历史账号回归：授权集语义不变（推导 orgLevel 不放大边界）', async () => {
    // 落总部仓的历史账号（推导=平台级但无平台角色）：仍按校区授权集拒真实校区
    await expect(
      controller['campusScope'](reqOf(histHqCtx, { campus: 'campus-hbut' })),
    ).rejects.toThrow(ForbiddenException);
    expect(await controller['campusScope'](reqOf(histHqCtx))).toBe('campus-hq');
    // 落真实校区的历史账号：缺省本校区、集外 403
    expect(await controller['campusScope'](reqOf(histRealCtx))).toBe('campus-hbut');
    await expect(
      controller['scopedCampus'](reqOf(histRealCtx, { campus: 'campus-hq' })),
    ).rejects.toThrow(ForbiddenException);
  });

  /* ==================== 账号 CRUD：orgLevel/organizationId 校验 ==================== */

  it('createAccount 校验：org 必须指定组织（且须存在）；platform/campus 不得指定组织', async () => {
    const base = { username: usernames[4], password: 'spec-password-8', grants: [] as never[] };
    await expect(
      rbac.createAccount(ACTOR, { ...base, orgLevel: 'org' }),
    ).rejects.toThrow('组织级账号必须指定所属组织');
    await expect(
      rbac.createAccount(ACTOR, { ...base, orgLevel: 'org', organizationId: `org-x-${ts}` }),
    ).rejects.toThrow('组织不存在');
    await expect(
      rbac.createAccount(ACTOR, { ...base, orgLevel: 'platform', organizationId: ORG_B }),
    ).rejects.toThrow('仅组织级账号可固定组织');
    await expect(
      rbac.createAccount(ACTOR, { ...base, orgLevel: 'campus', organizationId: ORG_B }),
    ).rejects.toThrow('仅组织级账号可固定组织');
    // 历史口径（不传层级）带组织同样拒绝
    await expect(
      rbac.createAccount(ACTOR, { ...base, organizationId: ORG_B }),
    ).rejects.toThrow('仅组织级账号可固定组织');
  });

  it('createAccount：组织级账号落库（orgLevel/organizationId）', async () => {
    const created = await rbac.createAccount(ACTOR, {
      username: usernames[4],
      password: 'spec-password-8',
      grants: [],
      orgLevel: 'org',
      organizationId: ORG_B,
    });
    const row = await db.adminAccount.findUnique({ where: { id: created.id } });
    expect(row?.orgLevel).toBe('org');
    expect(row?.organizationId).toBe(ORG_B);
    // getEffective 装载为组织级上下文
    const ctx = await rbac.getEffective(row!);
    expect(ctx.orgLevel).toBe('org');
    expect(ctx.organizationId).toBe(ORG_B);
  });

  it('updateAccount：层级/组织变更与校验（合并态校验、显式 null 清除、grants 不误伤）', async () => {
    const target = await db.adminAccount.findUnique({ where: { username: usernames[4] } });
    expect(target).not.toBeNull();
    const id = target!.id;

    // 降级为平台级但未清组织 → 合并态非法
    await expect(
      rbac.updateAccount(ACTOR, id, { orgLevel: 'platform' }),
    ).rejects.toThrow('仅组织级账号可固定组织');
    // 换到不存在的组织 → 拒
    await expect(
      rbac.updateAccount(ACTOR, id, { organizationId: `org-x-${ts}` }),
    ).rejects.toThrow('组织不存在');

    // 显式清除回历史推导
    await rbac.updateAccount(ACTOR, id, { orgLevel: null, organizationId: null });
    const cleared = await db.adminAccount.findUnique({ where: { id } });
    expect(cleared?.orgLevel ?? null).toBeNull();
    expect(cleared?.organizationId ?? null).toBeNull();

    // grants-only 更新不误伤层级字段
    await rbac.updateAccount(ACTOR, id, { grants: [] });
    const afterGrants = await db.adminAccount.findUnique({ where: { id } });
    expect(afterGrants?.orgLevel ?? null).toBeNull();

    // 再固定为组织级：即刻生效（sessionVersion bump）
    const svBefore = afterGrants!.sessionVersion;
    await rbac.updateAccount(ACTOR, id, { orgLevel: 'org', organizationId: ORG_B });
    const refixed = await db.adminAccount.findUnique({ where: { id } });
    expect(refixed?.orgLevel).toBe('org');
    expect(refixed?.organizationId).toBe(ORG_B);
    expect(refixed!.sessionVersion).toBeGreaterThan(svBefore);

    // 空更新仍拒绝（新字段纳入"没有可更新的字段"判定）
    await expect(rbac.updateAccount(ACTOR, id, {})).rejects.toThrow('没有可更新的字段');
  });
});
