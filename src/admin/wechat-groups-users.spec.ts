import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';

/**
 * 微信群二维码（IKAJSY：后台 upsert/删除）+ 用户端三级回落（IKAJSZ）+
 * C 端用户管理（IKAJSW：聚合列表/统计/楼栋筛选）。
 */
describe('wechat groups & admin users (IKAJSY/IKAJSZ/IKAJSW)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const CAMPUS = 'campus-wg-spec';
  const OTHER = 'campus-wg-spec-other';
  const BUILDING = 'building-wg-spec';
  const USER_A = 'user-wg-a'; // 有默认地址（BUILDING）+ 已支付订单
  const USER_B = 'user-wg-b'; // 无地址无订单
  const OPERATOR = 'admin-wg-spec';

  async function seedOrder(
    orderNo: string,
    userId: string,
    paid: boolean,
    amount: number,
  ) {
    return db.order.create({
      data: {
        orderNo,
        userId,
        campusId: CAMPUS,
        status: 'completed',
        statusText: '已完成',
        address: {},
        deliveryMode: 'instant',
        items: [],
        productAmount: amount,
        totalQuantity: 1,
        deliveryThreshold: 0,
        deliveryFee: 0,
        discount: 0,
        payableAmount: amount,
        estimatedArrival: '',
        timeline: [],
        ...(paid ? { paidAt: new Date() } : {}),
      } as any,
    });
  }

  beforeAll(async () => {
    for (const id of [CAMPUS, OTHER]) {
      await db.campus.create({
        data: {
          id,
          name: `群码校园${id}`,
          shortName: '群码',
          warehouseName: '群码仓',
        } as any,
      });
    }
    await db.building.create({
      data: { id: BUILDING, campusId: CAMPUS, name: '群码一号楼' } as any,
    });
    for (const [id, phone, withAddress] of [
      [USER_A, '13800000001', true],
      [USER_B, '13800000002', false],
    ] as const) {
      await db.user.create({
        data: {
          id,
          campusId: CAMPUS,
          nickname: `群码用户${id.slice(-1)}`,
          phone,
          ...(withAddress
            ? {
                addresses: {
                  create: {
                    campusId: CAMPUS,
                    campusName: '群码校园',
                    buildingId: BUILDING,
                    buildingName: '群码一号楼',
                    floor: 1,
                    room: '101',
                    contactName: '同學',
                    phone: '13800000001',
                    isDefault: true,
                  },
                },
              }
            : {}),
        } as any,
      });
    }
    await seedOrder('BCQWG1', USER_A, true, 1000);
    await seedOrder('BCQWG2', USER_A, true, 2500);
    await seedOrder('BCQWG3', USER_A, false, 999); // 未支付不计入消费
  });

  afterAll(async () => {
    await db.order.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
    await db.wechatGroup.deleteMany({ where: { campusId: { in: [CAMPUS, OTHER] } } });
    await db.address.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
    await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
    await db.building.deleteMany({ where: { id: BUILDING } });
    await db.campus.deleteMany({ where: { id: { in: [CAMPUS, OTHER] } } });
    await db.$disconnect();
  });

  it('upserts school-level and building-level group codes (IKAJSY)', async () => {
    const school = await service.upsertWechatGroup(
      { image: 'https://cos/school.png' },
      OPERATOR,
      CAMPUS,
    );
    expect(school.buildingId).toBe('');
    const building = await service.upsertWechatGroup(
      { buildingId: BUILDING, image: 'https://cos/b1.png' },
      OPERATOR,
      CAMPUS,
    );
    expect(building.buildingId).toBe(BUILDING);
    // 同楼栋重复保存 = 替换图片（唯一约束 upsert）
    const replaced = await service.upsertWechatGroup(
      { buildingId: BUILDING, image: 'https://cos/b2.png' },
      OPERATOR,
      CAMPUS,
    );
    expect(replaced.id).toBe(building.id);
    expect(replaced.image).toBe('https://cos/b2.png');
    const list = await service.wechatGroups(CAMPUS);
    expect(list.map((x) => x.buildingName)).toEqual([
      '校级大群',
      '群码一号楼',
    ]);
    // 楼栋不存在拒绝
    await expect(
      service.upsertWechatGroup(
        { buildingId: 'no-such-building', image: 'x' },
        OPERATOR,
        CAMPUS,
      ),
    ).rejects.toThrow('楼栋不存在');
    await service.deleteWechatGroup(school.id, OPERATOR, CAMPUS);
    expect((await service.wechatGroups(CAMPUS)).length).toBe(1);
  });

  it('falls back building → campus → null for user side (IKAJSZ)', async () => {
    const building = await service.upsertWechatGroup(
      { buildingId: BUILDING, image: 'https://cos/b1.png' },
      OPERATOR,
      CAMPUS,
    );
    // USER_A 默认地址在 BUILDING → 楼栋群
    expect(await business.wechatGroup(USER_A)).toEqual({
      image: 'https://cos/b1.png',
      scope: 'building',
    });
    // USER_B 无地址 → 无群可回落时 null
    expect(await business.wechatGroup(USER_B)).toBeNull();
    // 配了校级大群后 USER_B 回落到校园群
    await service.upsertWechatGroup(
      { image: 'https://cos/school.png' },
      OPERATOR,
      CAMPUS,
    );
    expect(await business.wechatGroup(USER_B)).toEqual({
      image: 'https://cos/school.png',
      scope: 'campus',
    });
    await service.deleteWechatGroup(building.id, OPERATOR, CAMPUS);
  });

  it('aggregates order count and spend for users (IKAJSW)', async () => {
    const page = await service.users(CAMPUS, {
      page: 1,
      pageSize: 10,
    });
    expect(page.total).toBe(2);
    const a = page.items.find((x) => x.id === USER_A)!;
    expect(a.orderCount).toBe(2); // 未支付单不计
    expect(a.totalSpend).toBe(3500); // 分
    // maskPhone 口径：前 3 + **** + 后 4
    expect(a.phoneMasked).toMatch(/^\d{3}\*\*\*\*\d{4}$/);
    expect(a.buildingName).toBe('群码一号楼');
    const b = page.items.find((x) => x.id === USER_B)!;
    expect(b.orderCount).toBe(0);
    expect(b.buildingName).toBe('');
    // 楼栋筛选：一号楼只命中 USER_A
    const filtered = await service.users(CAMPUS, {
      buildingId: BUILDING,
      page: 1,
      pageSize: 10,
    });
    expect(filtered.items.map((x) => x.id)).toEqual([USER_A]);
    // 用户订单流水
    const orders = await service.userOrders(USER_A, CAMPUS);
    expect(orders.length).toBe(3);
    expect(orders[0].payableAmount).toBeGreaterThan(0);
    // 统计：总量 2、今日新增 2（刚造）
    const stats = await service.userStats(CAMPUS);
    expect(stats.total).toBe(2);
    expect(stats.todayNew).toBe(2);
    expect(stats.avgOrders).toBeGreaterThan(0);
    expect(stats.wechatWorkBindRate).toBeNull();
  });
});
