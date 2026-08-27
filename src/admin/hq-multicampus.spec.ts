import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';
import { canAdmin } from './permissions';
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
  const auth = new AuthController(new JwtService({ secret: 'spec-secret' }), db);
  const CAMPUS_A = 'campus-hbut';
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as never;
  const tag = `hqspec-${Date.now()}`;
  let CAMPUS_B = '';
  let userB = '';
  let orderB = '';
  let bannerAll = '';
  let bannerB = '';
  const orderIds: string[] = [];
  const bannerIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
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

  it('权限矩阵：banners 归 hq+admin（2026-08-26 全菜单开放）；hq 不碰校区营销/订单写', () => {
    expect(canAdmin('hq', 'banners', 'write')).toBe(true);
    expect(canAdmin('admin', 'banners', 'read')).toBe(true);
    expect(canAdmin('admin', 'banners', 'write')).toBe(true);
    expect(canAdmin('operations', 'banners', 'read')).toBe(false);
    expect(canAdmin('hq', 'marketing', 'read')).toBe(false);
    expect(canAdmin('hq', 'orders', 'write')).toBe(false);
    expect(canAdmin('hq', 'orders', 'read')).toBe(true);
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

  it('Banner 归总部：全部校区投放任一校区命中，定向仅本校', async () => {
    const all = await service.createBanner(
      { title: `${tag}-全域`, color: 'green', campusId: '' },
      'spec-hq',
      '',
    );
    const targeted = await service.createBanner(
      { title: `${tag}-定向`, color: 'green', campusId: CAMPUS_B, sort: -1 },
      'spec-hq',
      '',
    );
    bannerAll = all.id;
    bannerB = targeted.id;
    bannerIds.push(bannerAll, bannerB);
    const homeA = (await business.home(CAMPUS_A)) as { banners: IdLike[] };
    expect(homeA.banners.map((x) => x.id)).toContain(bannerAll);
    expect(homeA.banners.map((x) => x.id)).not.toContain(bannerB);
    const homeB = (await business.home(CAMPUS_B)) as { banners: IdLike[] };
    expect(homeB.banners.map((x) => x.id)).toContain(bannerAll);
    // hq 列表附 campusName（空 = 全部校区）
    const list = (await service.banners('')) as Array<{ campusName: string }>;
    const rowAll = list.find((x) => (x as IdLike).id === bannerAll);
    expect(rowAll?.campusName).toBe('全部校区');
  });

  it('账号同权（IKBFJ4）：admin 可建 hq/跨校区管理；hq 建号规则与登录闭环', async () => {
    const campusAdmin = await service.createAccount(
      { username: `${tag}-a-admin`, password: 'campus-pass-1', role: 'admin' },
      'spec-hq',
      CAMPUS_A,
      'admin',
    );
    accountIds.push(campusAdmin.id);
    // IKBFJ4：平台超管 admin（campusId 绑 A 校）创建 hq 合法（总部角色不绑校区）
    const adminMintedHq = await service.createAccount(
      { username: `${tag}-a-admin-hq`, password: 'hq-pass-12345', role: 'hq' },
      campusAdmin.id,
      CAMPUS_A,
      'admin',
    );
    expect(adminMintedHq.role).toBe('hq');
    accountIds.push(adminMintedHq.id);
    // 职能角色不可创建 hq 角色（服务层兜底，正常无入口）
    await expect(
      service.createAccount(
        { username: `${tag}-bad-hq`, password: 'whatever-123', role: 'hq' },
        'spec-hq',
        CAMPUS_A,
        'operations',
      ),
    ).rejects.toThrow(ForbiddenException);
    // hq 角色不允许绑校区
    await expect(
      service.createAccount(
        {
          username: `${tag}-bad-bind`,
          password: 'whatever-123',
          role: 'hq',
          campusId: CAMPUS_A,
        },
        'spec-hq',
        '',
        'hq',
      ),
    ).rejects.toThrow('总部角色账号不绑定校区');
    // hq 建校区账号必须选校区
    await expect(
      service.createAccount(
        { username: `${tag}-bad-empty`, password: 'whatever-123', role: 'admin' },
        'spec-hq',
        '',
        'hq',
      ),
    ).rejects.toThrow('请为校区账号选择所属校区');
    // hq 建 hq 账号（不绑校区）合法
    const hqAccount = await service.createAccount(
      { username: `${tag}-hq2`, password: 'hq-pass-12345', role: 'hq' },
      'spec-hq',
      '',
      'hq',
    );
    accountIds.push(hqAccount.id);
    // hq 建 B 校 admin → 登录 token campusId 落 B 校
    const bAdmin = await service.createAccount(
      {
        username: `${tag}-b-admin`,
        password: 'campus-pass-1',
        role: 'admin',
        campusId: CAMPUS_B,
      },
      'spec-hq',
      '',
      'hq',
    );
    accountIds.push(bAdmin.id);
    const login = (await auth.adminLogin({
      username: `${tag}-b-admin`,
      password: 'campus-pass-1',
    })) as { data: { user: { campusId: string; role: string } } };
    expect(login.data.user.campusId).toBe(CAMPUS_B);
    expect(login.data.user.role).toBe('admin');
    // IKBFJ4：A 校绑定的平台 admin 可跨校区改 B 校账号
    const renamed = (await service.updateAccount(
      bAdmin.id,
      { nickname: '跨校区改名' },
      campusAdmin.id,
      CAMPUS_A,
      'admin',
    )) as { nickname?: string };
    expect(renamed.nickname).toBe('跨校区改名');
    // A 校账号列表只见本校
    const listA = (await service.accounts(CAMPUS_A)) as Array<{
      campusId: string;
    }>;
    expect(listA.every((x) => x.campusId === CAMPUS_A)).toBe(true);
    // hq 列表带 campusName（空 = 总部）
    const listHq = (await service.accounts()) as Array<{
      campusId: string;
      campusName?: string;
    }>;
    expect(listHq.find((x) => x.campusId === '')?.campusName).toBe('总部');
  });
});
