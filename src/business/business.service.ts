import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MockStore } from '../mock/mock.store';
import { CreateAddressDto, CreateOrderDto, UpdateCartDto } from './dto';

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
}

@Injectable()
export class BusinessService {
  constructor(private readonly store: MockStore) {}
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
    return this.store.orders.filter(
      (o) =>
        o.userId === userId &&
        (!status || status === 'all' || o.status === status),
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
    return item;
  }
  advance(userId: string, id: string) {
    const item = this.order(userId, id);
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
    return item;
  }
  cancel(userId: string, id: string) {
    const item = this.order(userId, id);
    if (!['pending-payment', 'paid'].includes(item.status))
      throw new BadRequestException('当前状态不可取消');
    if (item.status === 'paid')
      for (const line of item.items)
        this.product(line.product.id).stock += line.quantity;
    if (item.couponId) {
      const coupon = this.store.coupons.find((c) => c.id === item.couponId);
      if (coupon) coupon.status = 'available';
    }
    item.status = 'cancelled';
    item.statusText = '订单已取消并退款';
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
