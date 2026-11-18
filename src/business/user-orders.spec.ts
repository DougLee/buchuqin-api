import { PrismaService } from '../database/prisma.service';
import {
  UserOrdersService,
  userOrderPage,
  userOrderRow,
} from './user-orders.service';
import { BusinessService } from './business.service';
import { NightOrderService } from '../night/night-order.service';
const raw = (
  id: string,
  status = 'pending-accept',
  createdAt = '2026-11-15T00:00:00.000Z',
) => ({
  id,
  status,
  statusText: status,
  createdAt,
  orderNo: id,
  payableAmount: 500,
  timeoutAt: '2026-11-16T10:00:00.000Z',
  store: { id: 'store', buildingName: '甲楼' },
  items: [{ nightProductId: 'n', name: '夜宵', image: '/n.png', quantity: 1 }],
});
describe('IKVQC3 用户订单汇总', () => {
  it('没有夜宵历史只读白天，不依赖夜宵订单来源，也不显示渠道选项', async () => {
    const day = { orders: jest.fn().mockResolvedValue([raw('day', 'paid')]) };
    const night = { myOrders: jest.fn().mockRejectedValue(Error('不应该访问夜宵来源')) };
    const service = new UserOrdersService(day as unknown as BusinessService, night as unknown as NightOrderService,
      { nightOrder: { count: jest.fn().mockResolvedValue(0) } } as unknown as PrismaService);
    expect(await service.list('buyer')).toMatchObject({ total: 1, nightVisible: false, errors: [] });
    expect(night.myOrders).not.toHaveBeenCalled();
  });
  it('未完成夜单跨日可见且排在已完成前，同ID两渠道各保留一行', () => {
    const rows = [
      userOrderRow(raw('same'), 'night'),
      userOrderRow(raw('same', 'completed', '2026-11-16T00:00:00.000Z'), 'day'),
    ];
    const page = userOrderPage(rows);
    expect(page.items.map((r) => r.key)).toEqual(['night:same', 'day:same']);
    expect(page.total).toBe(2);
  });
  it('先跨渠道全局排序再分页，混合47单不重不漏', () => {
    const rows = Array.from({ length: 47 }, (_, i) =>
      userOrderRow(raw(String(i).padStart(2, '0')), i % 2 ? 'day' : 'night'),
    );
    const pages = [1, 2, 3].flatMap(
      (page) => userOrderPage(rows, 'all', 'all', String(page), '20').items,
    );
    expect(pages).toHaveLength(47);
    expect(new Set(pages.map((r) => r.key)).size).toBe(47);
    expect(userOrderPage(rows, 'night').total).toBe(24);
  });
  it('配送中统一包含白天履约、夜宵待接单及已送达待确认', () => {
    const rows = [
      'last-mile',
      'pending-accept',
      'delivering',
      'delivered',
      'completed',
      'pending-payment',
    ].map((s) => userOrderRow(raw(s, s), 'night'));
    expect(
      userOrderPage(rows, 'all', 'delivering')
        .items.map((r) => r.status)
        .sort(),
    ).toEqual(['delivered', 'delivering', 'last-mile', 'pending-accept']);
  });
  it('归一化保持商品、金额和夜店ID，白天支付超时口径沿用原服务常量', () => {
    const day = userOrderRow(
      {
        ...raw('d'),
        items: [
          {
            product: { id: 'p', name: '白天商品', image: '/d.png' },
            quantity: 2,
          },
        ],
      },
      'day',
    );
    expect(day.items).toEqual([
      { id: 'p', name: '白天商品', image: '/d.png', quantity: 2 },
    ]);
    expect(day.timeoutAt).toBe('2026-11-15T00:15:00.000Z');
    const night = userOrderRow(raw('n'), 'night');
    expect(night.storeId).toBe('store');
    expect(night.payableAmount).toBe(500);
  });
  it('未付款取消保留未支付事实，不能伪装实付', () => {
    expect(
      userOrderRow({ ...raw('n', 'cancelled'), paidAt: null }, 'night').paidAt,
    ).toBeNull();
    expect(
      userOrderRow({ ...raw('n'), paidAt: '2026-11-16T00:00:00.000Z' }, 'night')
        .paidAt,
    ).toBe('2026-11-16T00:00:00.000Z');
  });
  it('拒绝非法筛选', () => {
    expect(() => userOrderPage([], 'other')).toThrow();
    expect(() => userOrderPage([], 'all', 'other')).toThrow();
  });
  it('所有来源始终绑定同一当前用户，不接收客户端指定userId或按营业时段隐藏', async () => {
    const day = { orders: jest.fn().mockResolvedValue([raw('d', 'paid')]) },
      night = { myOrders: jest.fn().mockResolvedValue([raw('n')]) };
    const service = new UserOrdersService(
      day as unknown as BusinessService,
      night as unknown as NightOrderService,
      { nightOrder: { count: jest.fn().mockResolvedValue(1) } } as unknown as PrismaService,
    );
    expect((await service.list('buyer-a')).total).toBe(2);
    expect(day.orders).toHaveBeenCalledWith('buyer-a');
    expect(night.myOrders).toHaveBeenCalledWith('buyer-a');
  });
  it('单来源失败保留另一来源并标记不完整，单渠道筛选不依赖另一来源', async () => {
    const day = { orders: jest.fn().mockRejectedValue(Error('offline')) },
      night = { myOrders: jest.fn().mockResolvedValue([raw('n')]) };
    const service = new UserOrdersService(
      day as unknown as BusinessService,
      night as unknown as NightOrderService,
      { nightOrder: { count: jest.fn().mockResolvedValue(1) } } as unknown as PrismaService,
    );
    const result = await service.list('buyer');
    expect(result.errors).toEqual(['day']);
    expect(result.items).toHaveLength(1);
    day.orders.mockClear();
    expect((await service.list('buyer', 'night')).errors).toEqual([]);
    expect(day.orders).not.toHaveBeenCalled();
  });
});
