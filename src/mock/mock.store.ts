import { Injectable } from '@nestjs/common';
import type { MockOrder } from '../business/business.service';
import {
  addresses,
  banners,
  campus,
  categories,
  coupons,
  deliverySlots,
  products,
} from './mock.data';
@Injectable()
export class MockStore {
  campus = structuredClone(campus);
  categories = structuredClone(categories);
  products = structuredClone(products);
  banners = structuredClone(banners);
  addresses = structuredClone(addresses);
  coupons = structuredClone(coupons);
  deliverySlots = structuredClone(deliverySlots);
  carts: Record<string, Record<string, number>> = {
    'user-001': { p001: 2, p002: 1 },
  };
  orders: MockOrder[];
  afterSales: Array<{
    id: string;
    userId: string;
    orderId: string;
    type: string;
    description: string;
    images: string[];
    status: string;
    createdAt: string;
  }>;
  refunds: Array<{
    id: string;
    userId: string;
    orderId: string;
    amount: number;
    reason: string;
    status: string;
    createdAt: string;
  }>;
  notifications = [
    {
      id: 'notice-001',
      userId: 'user-001',
      type: 'campaign',
      title: '夜宵补给站开门啦',
      content: '今晚 22:30 前下单都能送到寝室。',
      read: false,
      createdAt: '2026-08-10T12:00:00.000Z',
    },
    {
      id: 'notice-002',
      userId: 'user-001',
      type: 'service',
      title: '欢迎来到不出寝食社',
      content: '校园零食日用，配送员与楼长接力送到寝室。',
      read: true,
      createdAt: '2026-08-09T09:00:00.000Z',
    },
    {
      id: 'notice-003',
      userId: 'user-001',
      type: 'delivery',
      title: '楼长正在送往寝室',
      content: '订单 BCQ20260810003 已到达西区 5 栋，请留意电话。',
      read: false,
      createdAt: '2026-08-10T13:28:00.000Z',
    },
    {
      id: 'notice-004',
      userId: 'user-001',
      type: 'coupon',
      title: '你有 4 张优惠券可用',
      content: '周末宅寝券和水果尝鲜券已到账，记得在有效期内使用。',
      read: false,
      createdAt: '2026-08-10T10:15:00.000Z',
    },
    {
      id: 'notice-005',
      userId: 'user-001',
      type: 'order',
      title: '订单已送达寝室',
      content: '草莓鲜果杯和茉莉绿茶已送到 612 寝室，祝你用餐愉快。',
      read: true,
      createdAt: '2026-08-09T20:42:00.000Z',
    },
    {
      id: 'notice-006',
      userId: 'user-001',
      type: 'refund',
      title: '退款已到账',
      content: '售后退款 ¥41.60 已原路返回原支付账户。',
      read: true,
      createdAt: '2026-08-08T18:20:00.000Z',
    },
  ];

  constructor() {
    this.orders = this.seedOrders();
    this.afterSales = [
      {
        id: 'after-mock-001',
        userId: 'user-001',
        orderId: 'order-mock-refunded',
        type: 'quality',
        description: '水果杯封口松动，配送途中有少量洒漏',
        images: ['/static/products/generated/strawberry-cup.webp'],
        status: 'approved',
        createdAt: '2026-08-08T18:15:00.000Z',
      },
    ];
    this.refunds = [
      {
        id: 'refund-mock-001',
        userId: 'user-001',
        orderId: 'order-mock-refunded',
        amount: 41.6,
        reason: '水果杯封口松动，配送途中有少量洒漏',
        status: 'succeeded',
        createdAt: '2026-08-08T18:20:00.000Z',
      },
    ];
  }

  private seedOrders(): MockOrder[] {
    const now = Date.now();
    const makeOrder = (
      id: string,
      status: string,
      statusText: string,
      productIds: string[],
      doneCount: number,
      minutesAgo: number,
      riderId?: string,
    ): MockOrder => {
      const orderProducts = productIds.map((id) =>
        structuredClone(this.products.find((item) => item.id === id)!),
      );
      const items = orderProducts.map((product, index) => ({
        product,
        quantity: index === 0 ? 2 : 1,
      }));
      const productAmount = Number(
        items
          .reduce((sum, item) => sum + item.product.price * item.quantity, 0)
          .toFixed(2),
      );
      const createdAt = new Date(now - minutesAgo * 60 * 1000).toISOString();
      // 12 态状态机 timeline（IK93GQ）：5 节点，含"楼下待交接"。
      const steps = [
        ['paid', '支付成功', '订单已进入湖工大校园仓'],
        ['picking', '仓库拣货', '仓储同学正在核对商品'],
        ['first-mile', '送往楼下', '配送员取货后前往西区 5 栋'],
        ['waiting-handover', '楼下待交接', '配送员已到楼下，等待楼长交接'],
        ['last-mile', '送到寝室', '楼长接力送到 612 寝室'],
      ].map(([key, title, description], index) => ({
        key,
        title,
        description,
        done: index < doneCount,
        ...(index < doneCount
          ? {
              time: new Date(
                now - (minutesAgo - index * 5) * 60 * 1000,
              ).toISOString(),
            }
          : {}),
      }));
      return {
        id,
        orderNo: `BCQ20260810${id.slice(-3).toUpperCase()}`,
        userId: 'user-001',
        campusId: this.campus.id,
        status,
        statusText,
        createdAt,
        ...(riderId ? { riderId } : {}),
        address: structuredClone(this.addresses[0]),
        deliveryMode: 'instant',
        remark: '',
        items,
        productAmount,
        totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
        deliveryThreshold: 10,
        deliveryFee: 4,
        discount: 0,
        payableAmount: Number((productAmount + 4).toFixed(2)),
        estimatedArrival:
          ['completed', 'delivered', 'refunded'].includes(status)
            ? '已送达寝室'
            : '预计 30-60 分钟送达',
        timeline: steps,
        ...(doneCount > 0
          ? {
              paidAt: steps[0].time,
              // 取货后的单标记 picked；delivered 单补送达凭证（绩效凭证完整率统计用）。
              package:
                status === 'delivered'
                  ? {
                      id: `package-${id}`,
                      status: 'delivered',
                      proof: {
                        images: [
                          '/static/products/generated/strawberry-cup.webp',
                        ],
                        location: '西区 5 栋 612 门口',
                        time: new Date(
                          now - (minutesAgo - 20) * 60 * 1000,
                        ).toISOString(),
                      },
                    }
                  : {
                      id: `package-${id}`,
                      status: doneCount >= 3 ? 'picked' : status,
                    },
            }
          : {}),
      };
    };
    return [
      makeOrder(
        'order-mock-pending',
        'pending-payment',
        '等待支付',
        ['p011', 'p008'],
        0,
        3,
      ),
      makeOrder('order-mock-paid', 'paid', '仓库正在接单', ['p012'], 1, 8),
      makeOrder(
        'order-mock-picking',
        'picking',
        '仓库正在拣货',
        ['p014', 'p007'],
        2,
        18,
      ),
      makeOrder(
        'order-mock-waitingfm',
        'waiting-first-mile',
        '拣货完成，待配送员接单',
        ['p009'],
        2,
        26,
      ),
      makeOrder(
        'order-mock-firstmile',
        'first-mile',
        '配送员送往楼下',
        ['p013', 'p010'],
        3,
        32,
        'staff-rider-001',
      ),
      makeOrder(
        'order-mock-waitingho',
        'waiting-handover',
        '已到楼下，等待楼长交接',
        ['p008'],
        4,
        40,
        'staff-rider-001',
      ),
      makeOrder(
        'order-mock-lastmile',
        'last-mile',
        '楼长送往寝室',
        ['p010'],
        5,
        46,
        'staff-rider-001',
      ),
      makeOrder(
        'order-mock-delivered',
        'delivered',
        '已送达寝室',
        ['p011', 'p015'],
        5,
        60,
        'staff-rider-001',
      ),
      makeOrder(
        'order-mock-completed',
        'completed',
        '已确认收货',
        ['p015', 'p008'],
        5,
        180,
        'staff-rider-001',
      ),
      makeOrder(
        'order-mock-exception',
        'exception',
        '用户不在，暂存楼长处',
        ['p007'],
        5,
        120,
        'staff-rider-001',
      ),
      makeOrder(
        'order-mock-refunded',
        'refunded',
        '售后退款完成',
        ['p015'],
        5,
        1440,
      ),
      makeOrder(
        'order-mock-cancelled',
        'cancelled',
        '订单已取消',
        ['p009', 'p012'],
        0,
        2880,
      ),
    ];
  }
}
