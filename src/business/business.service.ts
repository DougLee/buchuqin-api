import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MockStore } from '../mock/mock.store';
import {
  CreateAddressDto,
  CreateAfterSalesDto,
  CreateOrderDto,
  UpdateCartDto,
} from './dto';

interface OrderLine {
  product: {
    id: string;
    name: string;
    subtitle: string;
    price: number;
    originalPrice: number;
    image: string;
    stock: number;
    sales: number;
    tag: string;
    weight: number;
    categoryId: string;
  };
  quantity: number;
}
interface TimelineStep {
  key: string;
  title: string;
  description: string;
  time?: string;
  done: boolean;
}
export interface MockOrder {
  id: string;
  orderNo: string;
  userId: string;
  campusId: string;
  status: string;
  statusText: string;
  createdAt: string;
  address: Record<string, unknown>;
  deliveryMode: 'instant' | 'scheduled';
  deliverySlot?: string;
  couponId?: string;
  remark: string;
  items: OrderLine[];
  productAmount: number;
  totalQuantity: number;
  deliveryThreshold: number;
  deliveryFee: number;
  discount: number;
  payableAmount: number;
  estimatedArrival: string;
  timeline: TimelineStep[];
  package?: { id: string; status: string };
  paidAt?: string;
  stockRestored?: boolean;
}

@Injectable()
export class BusinessService {
  constructor(private readonly store: MockStore) {}
  private notify(userId: string, type: string, title: string, content: string) {
    this.store.notifications.unshift({
      id: `notice-${Date.now()}`,
      userId,
      type,
      title,
      content,
      read: false,
      createdAt: new Date().toISOString(),
    });
  }
  home() {
    return {
      campus: this.store.campus,
      banners: this.store.banners,
      categories: this.store.categories,
      hotProducts: this.store.products,
    };
  }
  listProducts(categoryId?: string, keyword?: string) {
    return this.store.products.filter(
      (i) =>
        (!categoryId || categoryId === 'all' || i.categoryId === categoryId) &&
        (!keyword || i.name.includes(keyword)),
    );
  }
  product(id: string) {
    const item = this.store.products.find((p) => p.id === id);
    if (!item) throw new NotFoundException('商品不存在');
    return item;
  }
  cart(userId: string) {
    const raw = this.store.carts[userId] ?? {};
    const items = Object.entries(raw)
      .filter(([, q]) => q > 0)
      .map(([id, quantity]) => ({ product: this.product(id), quantity }));
    const productAmount = Number(
      items
        .reduce((sum, i) => sum + i.product.price * i.quantity, 0)
        .toFixed(2),
    );
    return {
      items,
      productAmount,
      totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
      deliveryThreshold: 10,
    };
  }
  updateCart(userId: string, dto: UpdateCartDto) {
    for (const line of dto.items) {
      const product = this.product(line.productId);
      if (line.quantity > product.stock)
        throw new BadRequestException(`${product.name}库存不足`);
    }
    this.store.carts[userId] = Object.fromEntries(
      dto.items.map((i) => [i.productId, i.quantity]),
    );
    return this.cart(userId);
  }
  private validateQuote(userId: string, dto: CreateOrderDto) {
    const cart = this.cart(userId);
    if (!cart.items.length) throw new BadRequestException('购物车为空');
    if (cart.productAmount < cart.deliveryThreshold)
      throw new BadRequestException(
        `商品金额满${cart.deliveryThreshold}元起送`,
      );
    const address = this.store.addresses.find(
      (a) =>
        a.id === dto.addressId &&
        a.userId === userId &&
        a.campusId === this.store.campus.id,
    );
    if (!address) throw new BadRequestException('地址不存在或无权使用');
    for (const line of cart.items)
      if (line.quantity > line.product.stock)
        throw new BadRequestException(`${line.product.name}库存不足`);
    if (
      dto.deliveryMode === 'scheduled' &&
      !this.store.deliverySlots.some(
        (s) => s.label === dto.deliverySlot && s.available,
      )
    )
      throw new BadRequestException('请选择可用的送达时段');
    return { cart, address };
  }
  checkout(userId: string, dto: CreateOrderDto) {
    const { cart } = this.validateQuote(userId, dto);
    const deliveryFee = dto.deliveryMode === 'instant' ? 4 : 2;
    const coupon = this.store.coupons.find(
      (c) =>
        c.id === dto.couponId &&
        c.status === 'available' &&
        cart.productAmount >= c.threshold &&
        new Date(c.expiresAt) > new Date(),
    );
    const discount = coupon?.amount ?? 0;
    return {
      ...cart,
      deliveryFee,
      discount,
      payableAmount: Number(
        (cart.productAmount + deliveryFee - discount).toFixed(2),
      ),
      estimatedArrival:
        dto.deliveryMode === 'instant'
          ? '预计 30-60 分钟送达'
          : `${dto.deliverySlot} 送达`,
    };
  }
  createOrder(userId: string, dto: CreateOrderDto) {
    const { address } = this.validateQuote(userId, dto);
    const settlement = this.checkout(userId, dto);
    const now = new Date(),
      id = `order-${Date.now()}`;
    const order: MockOrder = {
      id,
      orderNo: `BCQ${Date.now()}`,
      userId,
      campusId: this.store.campus.id,
      status: 'pending-payment',
      statusText: '等待支付',
      createdAt: now.toISOString(),
      address: structuredClone(address),
      deliveryMode: dto.deliveryMode,
      deliverySlot: dto.deliverySlot,
      couponId: dto.couponId,
      remark: dto.remark ?? '',
      ...settlement,
      items: structuredClone(settlement.items),
      timeline: [
        {
          key: 'paid',
          title: '支付成功',
          description: '订单将进入校园仓',
          done: false,
        },
        {
          key: 'picking',
          title: '仓库拣货',
          description: '预计 10 分钟完成',
          done: false,
        },
        {
          key: 'first-mile',
          title: '送往楼下',
          description: '配送员取货后展示',
          done: false,
        },
        {
          key: 'last-mile',
          title: '送到寝室',
          description: `${address.buildingName} ${address.room}`,
          done: false,
        },
      ],
    };
    this.store.orders.unshift(order);
    return order;
  }
  orders(userId: string, status?: string) {
    this.expirePendingOrders(userId);
    const delivering = new Set(['paid', 'picking', 'first-mile', 'last-mile']);
    return this.store.orders.filter(
      (o) =>
        o.userId === userId &&
        (!status ||
          status === 'all' ||
          o.status === status ||
          (status === 'delivering' && delivering.has(o.status))),
    );
  }
  order(userId: string, id: string) {
    const item = this.store.orders.find(
      (o) => o.id === id && o.userId === userId,
    );
    if (!item) throw new NotFoundException('订单不存在');
    return item;
  }
  pay(userId: string, id: string) {
    const item = this.order(userId, id);
    if (item.status === 'paid') return item;
    if (Date.now() - new Date(item.createdAt).getTime() >= 15 * 60 * 1000) {
      item.status = 'cancelled';
      item.statusText = '支付超时已关闭';
      throw new BadRequestException('订单支付已超时');
    }
    if (item.status !== 'pending-payment')
      throw new BadRequestException('当前状态不可支付');
    for (const line of item.items) {
      const product = this.product(line.product.id);
      if (product.stock < line.quantity)
        throw new BadRequestException(`${product.name}库存不足`);
    }
    for (const line of item.items)
      this.product(line.product.id).stock -= line.quantity;
    item.status = 'paid';
    item.statusText = '仓库正在接单';
    item.paidAt = new Date().toISOString();
    item.timeline[0].done = true;
    item.timeline[0].time = item.paidAt;
    item.package = { id: `package-${Date.now()}`, status: 'waiting-pick' };
    if (item.couponId) {
      const coupon = this.store.coupons.find((c) => c.id === item.couponId);
      if (coupon) coupon.status = 'used';
    }
    this.store.carts[userId] = {};
    this.notify(
      userId,
      'order',
      '支付成功',
      '订单已进入湖工大校园仓，仓储人员即将开始拣货。',
    );
    return item;
  }
  advance(userId: string, id: string) {
    const item = this.order(userId, id);
    if (!['paid', 'picking', 'first-mile', 'last-mile'].includes(item.status))
      throw new BadRequestException('当前状态不可推进履约');
    const next = item.timeline.findIndex((step) => !step.done);
    if (next < 0) {
      item.status = 'completed';
      item.statusText = '已送达寝室';
      return item;
    }
    item.timeline[next].done = true;
    item.timeline[next].time = new Date().toISOString();
    const states = [
      ['picking', '仓库正在拣货'],
      ['first-mile', '配送员送往楼下'],
      ['last-mile', '楼长送往寝室'],
    ];
    const state = states[Math.max(0, next - 1)];
    if (state) {
      item.status = state[0];
      item.statusText = state[1];
    }
    if (item.timeline.every((s) => s.done)) {
      item.status = 'completed';
      item.statusText = '已送达寝室';
    }
    this.notify(
      userId,
      'delivery',
      item.statusText,
      `${item.orderNo} 的履约状态已更新。`,
    );
    return item;
  }
  cancel(userId: string, id: string) {
    const item = this.order(userId, id);
    const wasPaid = item.status === 'paid';
    if (!['pending-payment', 'paid'].includes(item.status))
      throw new BadRequestException('当前状态不可取消');
    if (item.status === 'paid' && !item.stockRestored) {
      for (const line of item.items)
        this.product(line.product.id).stock += line.quantity;
      item.stockRestored = true;
    }
    if (item.couponId) {
      const coupon = this.store.coupons.find((c) => c.id === item.couponId);
      if (coupon) coupon.status = 'available';
    }
    item.status = 'cancelled';
    item.statusText = wasPaid ? '订单已取消并退款' : '订单已取消';
    if (wasPaid)
      this.store.refunds.unshift({
        id: `refund-${Date.now()}`,
        userId,
        orderId: id,
        amount: item.payableAmount,
        reason: '用户取消订单',
        status: 'succeeded',
        createdAt: new Date().toISOString(),
      });
    this.notify(
      userId,
      wasPaid ? 'refund' : 'order',
      wasPaid ? '退款已原路返回' : '订单已取消',
      wasPaid
        ? `订单 ${item.orderNo} 已取消，退款 ¥${item.payableAmount}。`
        : `订单 ${item.orderNo} 未支付，已关闭。`,
    );
    return item;
  }
  private expirePendingOrders(userId: string) {
    const deadline = Date.now() - 15 * 60 * 1000;
    for (const item of this.store.orders) {
      if (
        item.userId === userId &&
        item.status === 'pending-payment' &&
        new Date(item.createdAt).getTime() < deadline
      ) {
        item.status = 'cancelled';
        item.statusText = '支付超时已关闭';
      }
    }
  }
  createAfterSales(userId: string, orderId: string, dto: CreateAfterSalesDto) {
    const order = this.order(userId, orderId);
    if (order.status !== 'completed')
      throw new BadRequestException('订单送达后才能申请售后');
    const deliveredAt = order.timeline.at(-1)?.time;
    if (
      !deliveredAt ||
      Date.now() - new Date(deliveredAt).getTime() > 24 * 60 * 60 * 1000
    )
      throw new BadRequestException('已超过送达后 24 小时售后期限');
    if (this.store.afterSales.some((a) => a.orderId === orderId))
      throw new BadRequestException('该订单已提交售后');
    const record = {
      id: `after-${Date.now()}`,
      userId,
      orderId,
      type: dto.type,
      description: dto.description,
      images: dto.images,
      status: 'approved',
      createdAt: new Date().toISOString(),
    };
    this.store.afterSales.unshift(record);
    this.store.refunds.unshift({
      id: `refund-${Date.now()}`,
      userId,
      orderId,
      amount: order.payableAmount,
      reason: dto.description,
      status: 'succeeded',
      createdAt: new Date().toISOString(),
    });
    order.status = 'refunded';
    order.statusText = '售后退款完成';
    this.notify(
      userId,
      'refund',
      '售后申请已通过',
      `订单 ${order.orderNo} 已退款 ¥${order.payableAmount}。`,
    );
    return record;
  }
  afterSales(userId: string) {
    return this.store.afterSales.filter((a) => a.userId === userId);
  }
  refunds(userId: string) {
    return this.store.refunds.filter((r) => r.userId === userId);
  }
  notifications(userId: string) {
    return this.store.notifications.filter((n) => n.userId === userId);
  }
  readNotification(userId: string, id: string) {
    const item = this.store.notifications.find(
      (n) => n.id === id && n.userId === userId,
    );
    if (!item) throw new NotFoundException('消息不存在');
    item.read = true;
    return item;
  }
  addresses(userId: string, campusId: string) {
    return this.store.addresses.filter(
      (a) => a.userId === userId && a.campusId === campusId,
    );
  }
  addAddress(userId: string, campusId: string, dto: CreateAddressDto) {
    const address = {
      id: `address-${Date.now()}`,
      userId,
      campusId,
      campusName: this.store.campus.name,
      buildingId: dto.buildingName,
      isDefault: false,
      ...dto,
    };
    this.store.addresses.push(address);
    return address;
  }
}
