import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';
import { RbacService } from './rbac/rbac.service';
import { legacyRbacCtx } from './rbac/spec-fixtures';
import { AuthController } from '../auth/auth.controller';
import { JwtService } from '@nestjs/jwt';

/** service 返回 any 视图，这里显式收窄避免 unsafe 访问。 */
type IdLike = { id: string };

/**
 * 总部分层与跨校区视角（IKAJSL，2026-08-24 道哥决策版）：
 * - hq 账号（campusId 空）dashboard 汇总全部校区；订单/用户跨校区可见
 * - 校区角色保持本校区隔离（基础过滤由 campus-isolation.spec 守护）
 * - Banner 归总部投放：空 campusId = 全部校区，任一校区用户端命中
 * - 账号守卫（IKBFJ4 2026-08-27）：平台超管 admin 与 hq 同权——可建 hq/跨校区管；
 *   hq 角色不绑校区；职能角色不可建 hq（无入口，服务层兜底）
 */
describe('hq role & cross-campus views (IKAJSL)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const rbac = new RbacService(db);
  const auth = new AuthController(
    new JwtService({ secret: 'spec-secret' }),
    db,
    business,
    rbac,
  );
  const CAMPUS_A = 'campus-hbut';
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as never;
  const tag = `hqspec-${Date.now()}`;
  let CAMPUS_B = '';
  let userB = '';
  let orderB = '';
  let bannerA = '';
  const orderIds: string[] = [];
  const bannerIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    // 角色/权限登记入库（生产为启动同步；spec 手动触发）
    try {
      await rbac.syncRegistry();
    } catch {
      await rbac.syncRegistry();
    }
    // 校区本体走 service.createCampus（顺带覆盖 IKAJSL 新增口径）
    CAMPUS_B = (
      await service.createCampus(
        {
          name: '总部视角测试大学',
          shortName: '总部视角',
          warehouseName: '总部视角仓',
        },
        'spec-hq',
      )
    ).id;
    userB = (
      await db.user.create({
        data: {
          campusId: CAMPUS_B,
          nickname: '总部视角用户',
          phone: '',
          role: 'user',
          openid: `${tag}-openid`,
        },
      })
    ).id;
    // 今日支付单：进 hq 汇总口径（createdAt 今日 + paidAt 非空）
    const order = await db.order.create({
      data: {
        orderNo: `BCQHQ${Date.now()}`,
        userId: userB,
        campusId: CAMPUS_B,
        status: 'paid',
        statusText: '仓库正在接单',
        address: json({ buildingName: '总部视角 1 栋', room: '101' }),
        deliveryMode: 'instant',
        items: json([]),
        productAmount: 1000,
        totalQuantity: 1,
        deliveryThreshold: 0,
        deliveryFee: 0,
        discount: 0,
        payableAmount: 1000,
        estimatedArrival: '',
        timeline: json([]),
        paidAt: new Date(),
      } as never,
    });
    orderB = order.id;
    orderIds.push(orderB);
  });

  afterAll(async () => {
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.banner.deleteMany({ where: { id: { in: bannerIds } } });
    await db.auditLog.deleteMany({
      where: { entityId: { in: [...accountIds, ...bannerIds, CAMPUS_B] } },
    });
    await db.adminAccount.deleteMany({ where: { id: { in: accountIds } } });
    await db.user.deleteMany({ where: { id: userB } });
    await db.campus.deleteMany({ where: { id: CAMPUS_B } });
    await db.$disconnect();
  });

  it('权限映射（RBAC V1）：banners 校区自管归 admin 超管（IKBW0A）；hq 不碰校区营销/订单写', () => {
    // 旧 canAdmin 矩阵已退役：等价断言走模板权限（legacyRbacCtx=迁移产物语义）
    const has = (role: string, code: string) => rbac.has(legacyRbacCtx(role), code);
    expect(has('hq', 'banners.write')).toBe(false);
    expect(has('hq', 'banners.read')).toBe(false);
    expect(has('admin', 'banners.read')).toBe(true);
    expect(has('admin', 'banners.write')).toBe(true);
    expect(has('operations', 'banners.read')).toBe(false);
    expect(has('hq', 'marketing.read')).toBe(false);
    expect(has('hq', 'orders.write')).toBe(false);
    expect(has('hq', 'orders.read')).toBe(true);
  });

  it('hq dashboard：跨校区汇总含两校区，B 校今日支付计入', async () => {
    const summary = (await service.dashboard('')) as {
      campusRows: Array<{ campusId: string; orders: number; revenue: number }>;
      kpis: { orders: number; revenue: number };
    };
    const ids = summary.campusRows.map((r) => r.campusId);
    expect(ids).toContain(CAMPUS_A);
    expect(ids).toContain(CAMPUS_B);
    const rowB = summary.campusRows.find((r) => r.campusId === CAMPUS_B)!;
    expect(rowB.orders).toBeGreaterThanOrEqual(1);
    expect(rowB.revenue).toBeGreaterThanOrEqual(1000);
    expect(summary.kpis.orders).toBeGreaterThanOrEqual(1);
    // 带具体校区 id 仍可看单校区明细（不进汇总分支）
    await expect(service.dashboard(CAMPUS_B)).resolves.toBeTruthy();
  });

  it('hq 订单视角：空校区=全校区含 B 校；校区视角互相隔离', async () => {
    const all = (await service.orders('all', '')) as Array<
      IdLike & { campusId: string; campusName: string }
    >;
    const rowB = all.find((x) => x.id === orderB);
    expect(rowB).toBeTruthy();
    expect(rowB!.campusName).toBe('总部视角');
    const listA = (await service.orders('all', CAMPUS_A)) as IdLike[];
    expect(listA.every((x) => x.id !== orderB)).toBe(true);
    const counts = (await service.orderStatusCounts('')) as Record<
      string,
      number
    >;
    const countsB = (await service.orderStatusCounts(CAMPUS_B)) as Record<
      string,
      number
    >;
    expect(countsB.paid ?? 0).toBeGreaterThanOrEqual(1);
    expect((counts.paid ?? 0)).toBeGreaterThanOrEqual(countsB.paid ?? 0);
  });

  it('hq 用户视角：空校区列表含 B 校用户，A 校视角不可见', async () => {
    const all = await service.users('', {
      page: 1,
      pageSize: 200,
      keyword: '总部视角用户',
    });
    expect(all.items.map((x) => x.id)).toContain(userB);
    const listA = await service.users(CAMPUS_A, {
      page: 1,
      pageSize: 200,
      keyword: '总部视角用户',
    });
    expect(listA.items.every((x) => x.id !== userB)).toBe(true);
  });

  it('Banner 校区自管（IKBW0A）：校区建即落本校区且仅本校可见，hq 投放通道关闭', async () => {
    // hq（campusId 空）创建 Banner 已被拒绝——总部不做投放
    await expect(
      service.createBanner(
        { title: `${tag}-全域`, color: 'green' },
        'spec-hq',
        '',
      ),
    ).rejects.toThrow('仅校区账号可创建 Banner');
    // 校区创建自动落本校区（body.campusId 不再被采纳）
    const bannerA = await service.createBanner(
      { title: `${tag}-A校`, color: 'green', sort: -1 },
      'spec-admin',
      CAMPUS_A,
    );
    bannerIds.push(bannerA.id);
    const homeA = (await business.home(CAMPUS_A)) as { banners: IdLike[] };
    expect(homeA.banners.map((x) => x.id)).toContain(bannerA.id);
    const homeB = (await business.home(CAMPUS_B)) as { banners: IdLike[] };
    expect(homeB.banners.map((x) => x.id)).not.toContain(bannerA.id);
  });

  it('账号管理（IKBFJ4→RBAC V1）：建号+授权分离；登录闭环与跨校区列表', async () => {
    const actor = { id: 'spec-hq', username: 'spec-hq' };
    // 平台超管 = super-admin 平台级授权（role 列只留 'rbac' 标记）
    const campusAdmin = await service.createAccount(
      { username: `${tag}-a-admin`, password: 'campus-pass-1', nickname: '规格超管' },
      'spec-hq',
    );
    accountIds.push(campusAdmin.id);
    await rbac.setAccountRoles(actor, campusAdmin.id, [
      { roleCode: 'super-admin', scope: 'platform' },
    ]);
    // 超管造总部长（hq-director 平台级授权；V1：role 字段不再入参）
    const adminMintedHq = await service.createAccount(
      { username: `${tag}-a-admin-hq`, password: 'hq-pass-12345', nickname: '规格总部长' },
      campusAdmin.id,
    );
    accountIds.push(adminMintedHq.id);
    await rbac.setAccountRoles(
      { id: campusAdmin.id, username: `${tag}-a-admin` },
      adminMintedHq.id,
      [{ roleCode: 'hq-director', scope: 'platform' }],
    );
    const hqGrants = await db.adminAccountRole.findMany({
      where: { accountId: adminMintedHq.id },
      include: { role: { select: { code: true } } },
    });
    expect(hqGrants.map((g) => g.role.code)).toEqual(['hq-director']);
    expect(hqGrants[0].scope).toBe('platform');
    const mintedRow = await db.adminAccount.findUniqueOrThrow({
      where: { id: adminMintedHq.id },
    });
    expect(mintedRow.role).toBe('rbac');
    // 纯平台级授权不绑校区（campusId 空串）
    expect(mintedRow.campusId).toBe('');
    // 授权入参校验：无效校区 / 角色不存在拒绝
    await expect(
      service.createAccount(
        {
          username: `${tag}-bad-campus`,
          password: 'whatever-123',
          grants: [
            { roleCode: 'campus-operations', scope: 'campus', campusId: 'campus-not-exist' },
          ],
        },
        'spec-hq',
      ),
    ).rejects.toThrow('所属校区不存在');
    const badRoleAcc = await service.createAccount(
      { username: `${tag}-bad-role`, password: 'whatever-123' },
      'spec-hq',
    );
    accountIds.push(badRoleAcc.id);
    await expect(
      rbac.setAccountRoles(actor, badRoleAcc.id, [
        { roleCode: 'no-such-role', scope: 'platform' },
      ]),
    ).rejects.toThrow(BadRequestException);
    // B 校校区账号 → 初始上下文落 B 校；登录 token campusId=B、role='rbac'
    const bAdmin = await service.createAccount(
      {
        username: `${tag}-b-admin`,
        password: 'campus-pass-1',
        nickname: 'B校运营',
        grants: [{ roleCode: 'campus-operations', scope: 'campus', campusId: CAMPUS_B }],
      },
      'spec-hq',
    );
    accountIds.push(bAdmin.id);
    await rbac.setAccountRoles(actor, bAdmin.id, [
      { roleCode: 'campus-operations', scope: 'campus', campusId: CAMPUS_B },
    ]);
    const login = (await auth.adminLogin({
      username: `${tag}-b-admin`,
      password: 'campus-pass-1',
    })) as { data: { user: { campusId: string; role: string } } };
    expect(login.data.user.campusId).toBe(CAMPUS_B);
    expect(login.data.user.role).toBe('rbac');
    // 平台超管可跨校区改其他账号（V1：updateAccount 只管昵称，无校区/角色门槛）
    const renamed = (await service.updateAccount(
      bAdmin.id,
      { nickname: '跨校区改名' },
      campusAdmin.id,
    )) as { nickname?: string };
    expect(renamed.nickname).toBe('跨校区改名');
    // A 校账号列表只见本校
    const listA = (await service.accounts(CAMPUS_A)) as Array<{
      campusId: string;
    }>;
    expect(listA.every((x) => x.campusId === CAMPUS_A)).toBe(true);
    // 全量列表带 campusName（空 = 平台；旧「总部」更名）
    const listHq = (await service.accounts()) as Array<{
      campusId: string;
      campusName?: string;
    }>;
    expect(listHq.find((x) => x.campusId === '')?.campusName).toBe('平台');
  });
});
