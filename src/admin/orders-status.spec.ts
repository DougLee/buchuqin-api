import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';

/**
 * 订单列表状态过滤 + 状态计数（IKAJSP）：
 * 逗号分隔多状态合并查询（运营 Tab 分组）、groupBy 计数分布。
 */
describe('Admin orders status tabs (IKAJSP)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const CAMPUS = 'campus-order-tabs';
  const USER = 'user-order-tabs';
  const OTHER = 'campus-order-tabs-other';

  /** 直连库造单：只填列表过滤关心的字段，快照字段给最小合法值。 */
  async function seed(orderNo: string, status: string, campusId = CAMPUS) {
    return db.order.create({
      data: {
        orderNo,
        userId: USER,
        campusId,
        status,
        statusText: status,
        address: {},
        deliveryMode: 'slot',
        items: [],
        productAmount: 1000,
        totalQuantity: 1,
        deliveryThreshold: 0,
        deliveryFee: 0,
        discount: 0,
        payableAmount: 1000,
        estimatedArrival: '',
        timeline: [],
      } as any,
    });
  }

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '订单Tab校园',
        shortName: '订单Tab',
        warehouseName: '订单Tab仓',
      } as any,
    });
    await db.campus.create({
      data: {
        id: OTHER,
        name: '订单Tab他校',
        shortName: '他校',
        warehouseName: '他校仓',
      } as any,
    });
    await db.user.create({
      data: {
        id: USER,
        campusId: CAMPUS,
        nickname: '订单Tab用户',
        phone: '13800000000',
      } as any,
    });
    // 覆盖每个 Tab 分组各至少一单 + 干扰项（他校数据不进结果）
    await seed('BCQTAB1', 'paid');
    await seed('BCQTAB2', 'picking');
    await seed('BCQTAB3', 'waiting-first-mile');
    await seed('BCQTAB4', 'first-mile');
    await seed('BCQTAB5', 'waiting-handover');
    await seed('BCQTAB6', 'completed');
    await seed('BCQTAB7', 'cancelled');
    await seed('BCQTAB8', 'paid', OTHER);
  });

  afterAll(async () => {
    await db.order.deleteMany({ where: { userId: USER } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.campus.deleteMany({ where: { id: { in: [CAMPUS, OTHER] } } });
    await db.$disconnect();
  });

  it('merges comma-separated statuses (配送中 Tab = 3 个原始状态)', async () => {
    const xs = await service.orders(
      'waiting-first-mile,first-mile,last-mile',
      CAMPUS,
    );
    // 同毫秒造单 createdAt 并列，列表顺序不保证——断言只看命中集合
    expect(xs.map((x) => x.orderNo).sort()).toEqual(['BCQTAB3', 'BCQTAB4']);
  });

  it('keeps single-status and all compatible with the old dropdown', async () => {
    expect((await service.orders('paid', CAMPUS)).map((x) => x.orderNo)).toEqual(
      ['BCQTAB1'],
    );
    expect((await service.orders('all', CAMPUS)).length).toBe(7);
    expect((await service.orders(undefined, CAMPUS)).length).toBe(7);
  });

  it('counts per raw status within campus only', async () => {
    const counts = await service.orderStatusCounts(CAMPUS);
    expect(counts).toEqual({
      paid: 1,
      picking: 1,
      'waiting-first-mile': 1,
      'first-mile': 1,
      'waiting-handover': 1,
      completed: 1,
      cancelled: 1,
    });
  });
});
