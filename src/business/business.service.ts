import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MockStore } from '../mock/mock.store';
import { CreateAddressDto, CreateOrderDto, UpdateCartDto } from './dto';
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
      (item) =>
        (!categoryId ||
          categoryId === 'all' ||
          item.categoryId === categoryId) &&
        (!keyword || item.name.includes(keyword)),
    );
  }
  product(id: string) {
    const item = this.store.products.find((p) => p.id === id);
    if (!item) throw new NotFoundException('商品不存在');
    return item;
  }
  cart(userId: string) {
    const cart = this.store.carts[userId] ?? {};
    const items = Object.entries(cart)
      .filter(([, quantity]) => quantity > 0)
      .map(([id, quantity]) => ({ product: this.product(id), quantity }));
    const productAmount = Number(
      items
        .reduce((sum, item) => sum + item.product.price * item.quantity, 0)
        .toFixed(2),
    );
    return {
      items,
      productAmount,
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
      deliveryThreshold: 10,
    };
  }
  updateCart(userId: string, dto: UpdateCartDto) {
    this.store.carts[userId] = Object.fromEntries(
      dto.items.map((i) => [i.productId, i.quantity]),
    );
    return this.cart(userId);
  }
  checkout(userId: string, dto: CreateOrderDto) {
    const cart = this.cart(userId);
    if (!cart.items.length) throw new BadRequestException('购物车为空');
    const deliveryFee = dto.deliveryMode === 'instant' ? 4 : 2;
    const coupon = this.store.coupons.find(
      (c) =>
        c.id === dto.couponId &&
        c.status === 'available' &&
        cart.productAmount >= c.threshold,
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
          : `${dto.deliverySlot ?? '20:00-21:00'} 送达`,
    };
  }
  createOrder(userId: string, dto: CreateOrderDto) {
    const settlement = this.checkout(userId, dto);
    const address = this.store.addresses.find((a) => a.id === dto.addressId);
    if (!address) throw new BadRequestException('地址不存在');
    const now = new Date();
    const id = `order-${Date.now()}`;
    const order: Record<string, any> = {
      id,
      orderNo: `BCQ${Date.now()}`,
      userId,
      campusId: this.store.campus.id,
      status: 'paid',
      statusText: '仓库正在接单',
      createdAt: now.toISOString(),
      address,
      deliveryMode: dto.deliveryMode,
      remark: dto.remark ?? '',
      ...settlement,
      timeline: [
        {
          key: 'paid',
          title: '支付成功',
          description: '订单已进入校园仓',
          time: now.toISOString(),
          done: true,
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
    this.store.carts[userId] = {};
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
  cancel(userId: string, id: string) {
    const item = this.order(userId, id);
    if (item.status !== 'paid')
      throw new BadRequestException('当前状态不可取消');
    item.status = 'cancelled';
    item.statusText = '订单已取消';
    return item;
  }
  pay(userId: string, id: string) {
    const item = this.order(userId, id);
    return {
      orderId: id,
      mock: true,
      paidAt: new Date().toISOString(),
      amount: item.payableAmount,
    };
  }
  addAddress(dto: CreateAddressDto) {
    const address = {
      id: `address-${Date.now()}`,
      campusId: this.store.campus.id,
      campusName: this.store.campus.name,
      buildingId: dto.buildingName,
      isDefault: false,
      ...dto,
    };
    this.store.addresses.push(address);
    return address;
  }
}
