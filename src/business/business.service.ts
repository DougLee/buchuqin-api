import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

/** @deprecated Seed/test compatibility only; production services use Prisma. */
export type MockOrder = any;
import {
  CreateAddressDto,
  CreateAfterSalesDto,
  CreateOrderDto,
  UpdateAddressDto,
  UpdateCartDto,
} from './dto';

export interface ProductSnapshot {
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
}
export interface OrderLine {
  product: ProductSnapshot;
  quantity: number;
}
export interface TimelineStep {
  key: string;
  title: string;
  description: string;
  time?: string;
  done: boolean;
}
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const number = (value: Prisma.Decimal | number) => Number(value);

@Injectable()
export class BusinessService {
  constructor(private readonly db: PrismaService) {}
  private productView(product: any) {
    return {
      ...product,
      price: number(product.price),
      originalPrice: number(product.originalPrice),
      weight: number(product.weight),
    };
  }
  private orderView(order: any) {
    return {
      ...order,
      productAmount: number(order.productAmount),
      deliveryThreshold: number(order.deliveryThreshold),
      deliveryFee: number(order.deliveryFee),
      discount: number(order.discount),
      payableAmount: number(order.payableAmount),
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt?.toISOString(),
      items: order.items as OrderLine[],
      timeline: order.timeline as TimelineStep[],
    };
  }
  private async notify(
    userId: string,
    type: string,
    title: string,
    content: string,
  ) {
    return this.db.notification.create({
      data: {
        id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        userId,
        type,
        title,
        content,
      },
    });
  }
  async campus() {
    const item = await this.db.campus.findFirst();
    if (!item) throw new NotFoundException('校园不存在');
    return item;
  }
  async categories() {
    return this.db.category.findMany({ orderBy: { sort: 'asc' } });
  }
  async coupons(userId: string, campusId = 'campus-hbut') {
    const [items, usedOrders] = await Promise.all([
      this.db.coupon.findMany({
        where: { campusId },
        orderBy: { expiresAt: 'asc' },
      }),
      this.db.order.findMany({
        where: {
          userId,
          couponId: { not: null },
          status: { notIn: ['pending-payment', 'cancelled'] },
        },
        select: { couponId: true },
      }),
    ]);
    const used = new Set(usedOrders.map((order) => order.couponId));
    return items.map((i) => ({
      ...i,
      status: used.has(i.id) ? 'used' : i.status,
      amount: number(i.amount),
      threshold: number(i.threshold),
      expiresAt: i.expiresAt.toISOString(),
    }));
  }
  async slots(campusId = 'campus-hbut') {
    return this.db.deliverySlot.findMany({
      where: { campusId },
      orderBy: { label: 'asc' },
    });
  }
  async home() {
    const [campus, banners, categories, products] = await Promise.all([
      this.campus(),
      this.db.banner.findMany({
        where: { status: 'active' },
        orderBy: { sort: 'asc' },
      }),
      this.categories(),
      this.db.product.findMany({
        where: { status: 'on-sale' },
        orderBy: { sales: 'desc' },
        take: 18,
      }),
    ]);
    return {
      campus,
      banners,
      categories,
      hotProducts: products.map((p) => this.productView(p)),
    };
  }
  async listProducts(categoryId?: string, keyword?: string) {
    const products = await this.db.product.findMany({
      where: {
        status: 'on-sale',
        ...(categoryId && categoryId !== 'all' ? { categoryId } : {}),
        ...(keyword
          ? { name: { contains: keyword, mode: 'insensitive' } }
          : {}),
      },
      orderBy: { sales: 'desc' },
    });
    return products.map((p) => this.productView(p));
  }
  async product(id: string) {
    const item = await this.db.product.findFirst({
      where: { id, status: 'on-sale' },
    });
    if (!item) throw new NotFoundException('商品不存在');
    return this.productView(item);
  }
  async cart(userId: string) {
    const rows = await this.db.cartItem.findMany({
      where: { userId, quantity: { gt: 0 } },
      include: { product: true },
    });
    const items = rows.map((row) => ({
      product: this.productView(row.product),
      quantity: row.quantity,
    }));
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
  async updateCart(userId: string, dto: UpdateCartDto) {
    await this.db.$transaction(async (tx) => {
      for (const line of dto.items) {
        const p = await tx.product.findUnique({
          where: { id: line.productId },
        });
        if (!p || p.status !== 'on-sale')
          throw new BadRequestException('商品不存在或已下架');
        if (line.quantity > p.stock - p.lockedStock)
          throw new BadRequestException(`${p.name}库存不足`);
      }
      await tx.cartItem.deleteMany({ where: { userId } });
      if (dto.items.some((i) => i.quantity > 0))
        await tx.cartItem.createMany({
          data: dto.items
            .filter((i) => i.quantity > 0)
            .map((i) => ({
              userId,
              productId: i.productId,
              quantity: i.quantity,
            })),
        });
    });
    return this.cart(userId);
  }
  async setCartItem(userId: string, productId: string, quantity: number) {
    const p = await this.db.product.findUnique({ where: { id: productId } });
    if (!p) throw new NotFoundException('商品不存在');
    if (quantity > p.stock - p.lockedStock)
      throw new BadRequestException(`${p.name}库存不足`);
    if (quantity === 0)
      await this.db.cartItem.deleteMany({ where: { userId, productId } });
    else
      await this.db.cartItem.upsert({
        where: { userId_productId: { userId, productId } },
        create: { userId, productId, quantity },
        update: { quantity },
      });
    return this.cart(userId);
  }
  async clearCart(userId: string) {
    await this.db.cartItem.deleteMany({ where: { userId } });
    return this.cart(userId);
  }
  private async validateQuote(userId: string, dto: CreateOrderDto) {
    const [cart, address] = await Promise.all([
      this.cart(userId),
      this.db.address.findFirst({ where: { id: dto.addressId, userId } }),
    ]);
    if (!cart.items.length) throw new BadRequestException('购物车为空');
    if (cart.productAmount < cart.deliveryThreshold)
      throw new BadRequestException(
        `商品金额满${cart.deliveryThreshold}元起送`,
      );
    if (!address) throw new BadRequestException('地址不存在或无权使用');
    for (const line of cart.items) {
      const p = await this.db.product.findUnique({
        where: { id: line.product.id },
      });
      if (!p || line.quantity > p.stock - p.lockedStock)
        throw new BadRequestException(`${line.product.name}库存不足`);
    }
    if (dto.deliveryMode === 'scheduled') {
      if (!dto.deliverySlot) throw new BadRequestException('请选择送达时段');
      const slot = await this.db.deliverySlot.findFirst({
        where: {
          campusId: address.campusId,
          label: dto.deliverySlot,
          available: true,
          capacity: { gt: 0 },
        },
      });
      if (!slot) throw new BadRequestException('请选择可用的送达时段');
    }
    return { cart, address };
  }
  async checkout(userId: string, dto: CreateOrderDto) {
    const { cart } = await this.validateQuote(userId, dto);
    const deliveryFee = dto.deliveryMode === 'instant' ? 4 : 2;
    const coupon = dto.couponId
      ? await this.db.coupon.findFirst({
          where: {
            id: dto.couponId,
            status: 'available',
            expiresAt: { gt: new Date() },
          },
        })
      : null;
    if (dto.couponId) {
      if (!coupon) throw new BadRequestException('优惠券不可用或已过期');
      if (cart.productAmount < number(coupon.threshold))
        throw new BadRequestException(`商品金额未达到优惠券使用门槛`);
      const used = await this.db.order.findFirst({
        where: {
          userId,
          couponId: dto.couponId,
          status: { notIn: ['pending-payment', 'cancelled'] },
        },
      });
      if (used) throw new BadRequestException('优惠券已使用');
    }
    const discount =
      coupon && cart.productAmount >= number(coupon.threshold)
        ? number(coupon.amount)
        : 0;
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
  async createOrder(userId: string, dto: CreateOrderDto) {
    const { address } = await this.validateQuote(userId, dto);
    const settlement = await this.checkout(userId, dto);
    const id = `order-${Date.now()}`,
      now = new Date();
    const timeline: TimelineStep[] = [
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
    ];
    const order = await this.db.order.create({
      data: {
        id,
        orderNo: `BCQ${Date.now()}`,
        userId,
        campusId: address.campusId,
        status: 'pending-payment',
        statusText: '等待支付',
        address: json(address),
        deliveryMode: dto.deliveryMode,
        deliverySlot: dto.deliverySlot,
        couponId: dto.couponId,
        remark: dto.remark ?? '',
        items: json(settlement.items),
        productAmount: settlement.productAmount,
        totalQuantity: settlement.totalQuantity,
        deliveryThreshold: settlement.deliveryThreshold,
        deliveryFee: settlement.deliveryFee,
        discount: settlement.discount,
        payableAmount: settlement.payableAmount,
        estimatedArrival: settlement.estimatedArrival,
        timeline: json(timeline),
        createdAt: now,
      },
    });
    return this.orderView(order);
  }
  private async expirePendingOrders(userId: string) {
    const deadline = new Date(Date.now() - 15 * 60 * 1000);
    await this.db.order.updateMany({
      where: { userId, status: 'pending-payment', createdAt: { lt: deadline } },
      data: { status: 'cancelled', statusText: '支付超时已关闭' },
    });
  }
  async orders(userId: string, status?: string) {
    await this.expirePendingOrders(userId);
    const delivering = ['paid', 'picking', 'first-mile', 'last-mile'];
    const rows = await this.db.order.findMany({
      where: {
        userId,
        ...(!status || status === 'all'
          ? {}
          : status === 'delivering'
            ? { status: { in: delivering } }
            : { status }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((o) => this.orderView(o));
  }
  async order(userId: string, id: string) {
    await this.expirePendingOrders(userId);
    const item = await this.db.order.findFirst({ where: { id, userId } });
    if (!item) throw new NotFoundException('订单不存在');
    return this.orderView(item);
  }
  async pay(userId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const raw = await tx.order.findFirst({ where: { id, userId } });
      if (!raw) throw new NotFoundException('订单不存在');
      if (raw.status === 'paid') return this.orderView(raw);
      if (Date.now() - raw.createdAt.getTime() >= 15 * 60 * 1000) {
        await tx.order.update({
          where: { id },
          data: { status: 'cancelled', statusText: '支付超时已关闭' },
        });
        throw new BadRequestException('订单支付已超时');
      }
      if (raw.status !== 'pending-payment')
        throw new BadRequestException('当前状态不可支付');
      const items = raw.items as unknown as OrderLine[];
      for (const line of items) {
        const p = await tx.product.findUnique({
          where: { id: line.product.id },
        });
        if (!p || p.stock - p.lockedStock < line.quantity)
          throw new BadRequestException(`${line.product.name}库存不足`);
      }
      for (const line of items)
        await tx.product.update({
          where: { id: line.product.id },
          data: { stock: { decrement: line.quantity } },
        });
      const timeline = raw.timeline as unknown as TimelineStep[],
        paidAt = new Date();
      timeline[0] = { ...timeline[0], done: true, time: paidAt.toISOString() };
      const updated = await tx.order.update({
        where: { id },
        data: {
          status: 'paid',
          statusText: '仓库正在接单',
          paidAt,
          timeline: json(timeline),
          package: json({
            id: `package-${Date.now()}`,
            status: 'waiting-pick',
          }),
        },
      });
      if (raw.couponId)
        await tx.coupon.updateMany({
          where: { id: raw.couponId, status: 'available' },
          data: { used: { increment: 1 } },
        });
      await tx.cartItem.deleteMany({ where: { userId } });
      await tx.notification.create({
        data: {
          id: `notice-${Date.now()}`,
          userId,
          type: 'order',
          title: '支付成功',
          content: '订单已进入湖工大校园仓，仓储人员即将开始拣货。',
        },
      });
      return this.orderView(updated);
    });
  }
  async advance(userId: string, id: string) {
    const raw = await this.db.order.findFirst({ where: { id, userId } });
    if (!raw) throw new NotFoundException('订单不存在');
    if (!['paid', 'picking', 'first-mile', 'last-mile'].includes(raw.status))
      throw new BadRequestException('当前状态不可推进履约');
    const timeline = raw.timeline as unknown as TimelineStep[];
    const next = timeline.findIndex((s) => !s.done);
    if (next >= 0)
      timeline[next] = {
        ...timeline[next],
        done: true,
        time: new Date().toISOString(),
      };
    const states = [
      ['picking', '仓库正在拣货'],
      ['first-mile', '配送员送往楼下'],
      ['last-mile', '楼长送往寝室'],
      ['completed', '已送达寝室'],
    ];
    const [status, statusText] = states[Math.max(0, next - 1)] ?? states[3];
    const updated = await this.db.order.update({
      where: { id },
      data: {
        status: timeline.every((s) => s.done) ? 'completed' : status,
        statusText: timeline.every((s) => s.done) ? '已送达寝室' : statusText,
        timeline: json(timeline),
      },
    });
    await this.notify(
      userId,
      'delivery',
      updated.statusText,
      `${updated.orderNo} 的履约状态已更新。`,
    );
    return this.orderView(updated);
  }
  async confirmReceipt(userId: string, id: string) {
    const raw = await this.db.order.findFirst({ where: { id, userId } });
    if (!raw) throw new NotFoundException('订单不存在');
    if (!['last-mile', 'completed'].includes(raw.status))
      throw new BadRequestException('当前状态不可确认收货');
    const timeline = raw.timeline as unknown as TimelineStep[];
    const last = timeline.at(-1);
    if (last) {
      last.done = true;
      last.time ??= new Date().toISOString();
    }
    return this.orderView(
      await this.db.order.update({
        where: { id },
        data: {
          status: 'completed',
          statusText: '已确认收货',
          timeline: json(timeline),
        },
      }),
    );
  }
  async cancel(userId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const raw = await tx.order.findFirst({ where: { id, userId } });
      if (!raw) throw new NotFoundException('订单不存在');
      const wasPaid = raw.status === 'paid';
      if (!['pending-payment', 'paid'].includes(raw.status))
        throw new BadRequestException('当前状态不可取消');
      if (wasPaid && !raw.stockRestored)
        for (const line of raw.items as unknown as OrderLine[])
          await tx.product.update({
            where: { id: line.product.id },
            data: { stock: { increment: line.quantity } },
          });
      if (raw.couponId)
        await tx.coupon.updateMany({
          where: { id: raw.couponId },
          data: { status: 'available' },
        });
      const updated = await tx.order.update({
        where: { id },
        data: {
          status: 'cancelled',
          statusText: wasPaid ? '订单已取消并退款' : '订单已取消',
          stockRestored: wasPaid || raw.stockRestored,
        },
      });
      if (wasPaid)
        await tx.refund.create({
          data: {
            id: `refund-${Date.now()}`,
            userId,
            orderId: id,
            amount: raw.payableAmount,
            reason: '用户取消订单',
            status: 'succeeded',
          },
        });
      return this.orderView(updated);
    });
  }
  async addresses(userId: string, campusId: string) {
    return this.db.address.findMany({
      where: { userId, campusId },
      orderBy: { isDefault: 'desc' },
    });
  }
  async addAddress(userId: string, campusId: string, dto: CreateAddressDto) {
    if (dto.isDefault)
      await this.db.address.updateMany({
        where: { userId, campusId },
        data: { isDefault: false },
      });
    const campus = await this.campus();
    return this.db.address.create({
      data: {
        id: `address-${Date.now()}`,
        userId,
        campusId,
        campusName: campus.name,
        buildingId: dto.buildingName,
        ...dto,
        isDefault: dto.isDefault ?? false,
      },
    });
  }
  async updateAddress(
    userId: string,
    campusId: string,
    id: string,
    dto: UpdateAddressDto,
  ) {
    const found = await this.db.address.findFirst({
      where: { id, userId, campusId },
    });
    if (!found) throw new NotFoundException('地址不存在');
    return this.db.address.update({ where: { id }, data: dto });
  }
  async deleteAddress(userId: string, campusId: string, id: string) {
    const found = await this.db.address.findFirst({
      where: { id, userId, campusId },
    });
    if (!found) throw new NotFoundException('地址不存在');
    await this.db.$transaction(async (tx) => {
      await tx.address.delete({ where: { id } });
      if (found.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId, campusId },
          orderBy: { id: 'asc' },
        });
        if (next)
          await tx.address.update({
            where: { id: next.id },
            data: { isDefault: true },
          });
      }
    });
    return { id, deleted: true };
  }
  async setDefaultAddress(userId: string, campusId: string, id: string) {
    const found = await this.db.address.findFirst({
      where: { id, userId, campusId },
    });
    if (!found) throw new NotFoundException('地址不存在');
    await this.db.$transaction([
      this.db.address.updateMany({
        where: { userId, campusId },
        data: { isDefault: false },
      }),
      this.db.address.update({ where: { id }, data: { isDefault: true } }),
    ]);
    return { ...found, isDefault: true };
  }
  async availableCoupons(userId: string, dto: CreateOrderDto) {
    const { cart } = await this.validateQuote(userId, {
      ...dto,
      couponId: undefined,
    });
    const [items, usedOrders] = await Promise.all([
      this.db.coupon.findMany({ where: { campusId: 'campus-hbut' } }),
      this.db.order.findMany({
        where: {
          userId,
          couponId: { not: null },
          status: { notIn: ['pending-payment', 'cancelled'] },
        },
        select: { couponId: true },
      }),
    ]);
    const used = new Set(usedOrders.map((order) => order.couponId));
    return items.map((c) => {
      const amount = number(c.amount),
        threshold = number(c.threshold);
      const reason = used.has(c.id)
        ? '优惠券已使用'
        : c.status !== 'available'
          ? '优惠券不可用'
          : c.expiresAt <= new Date()
            ? '优惠券已过期'
            : cart.productAmount < threshold
              ? `还差${Number((threshold - cart.productAmount).toFixed(2))}元可用`
              : undefined;
      return {
        ...c,
        amount,
        threshold,
        expiresAt: c.expiresAt.toISOString(),
        available: !reason,
        unavailableReason: reason,
      };
    });
  }
  async createAfterSales(
    userId: string,
    orderId: string,
    dto: CreateAfterSalesDto,
  ) {
    const order = await this.db.order.findFirst({
      where: { id: orderId, userId },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'completed')
      throw new BadRequestException('订单送达后才能申请售后');
    const timeline = order.timeline as unknown as TimelineStep[],
      deliveredAt = timeline.at(-1)?.time;
    if (
      !deliveredAt ||
      Date.now() - new Date(deliveredAt).getTime() > 24 * 60 * 60 * 1000
    )
      throw new BadRequestException('已超过送达后 24 小时售后期限');
    if (await this.db.afterSale.findFirst({ where: { orderId } }))
      throw new BadRequestException('该订单已提交售后');
    return this.db.$transaction(async (tx) => {
      const record = await tx.afterSale.create({
        data: {
          id: `after-${Date.now()}`,
          userId,
          orderId,
          type: dto.type,
          description: dto.description,
          images: json(dto.images),
          status: 'pending',
        },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'after-sales', statusText: '售后审核中' },
      });
      return {
        ...record,
        createdAt: record.createdAt.toISOString(),
        images: dto.images,
      };
    });
  }
  async afterSales(userId: string) {
    const items = await this.db.afterSale.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((i) => ({
      ...i,
      images: i.images as string[],
      createdAt: i.createdAt.toISOString(),
    }));
  }
  async afterSale(userId: string, id: string) {
    const item = await this.db.afterSale.findFirst({ where: { id, userId } });
    if (!item) throw new NotFoundException('售后单不存在');
    return {
      ...item,
      images: item.images as string[],
      createdAt: item.createdAt.toISOString(),
    };
  }
  async cancelAfterSale(userId: string, id: string) {
    const item = await this.db.afterSale.findFirst({ where: { id, userId } });
    if (!item) throw new NotFoundException('售后单不存在');
    if (item.status !== 'pending')
      throw new BadRequestException('当前售后状态不可撤销');
    return this.db.afterSale.update({
      where: { id },
      data: { status: 'cancelled' },
    });
  }
  async refunds(userId: string) {
    const items = await this.db.refund.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((i) => ({
      ...i,
      amount: number(i.amount),
      createdAt: i.createdAt.toISOString(),
    }));
  }
  async refund(userId: string, id: string) {
    const item = await this.db.refund.findFirst({ where: { id, userId } });
    if (!item) throw new NotFoundException('退款记录不存在');
    return {
      ...item,
      amount: number(item.amount),
      createdAt: item.createdAt.toISOString(),
    };
  }
  async notifications(userId: string) {
    const items = await this.db.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() }));
  }
  async readNotification(userId: string, id: string) {
    const item = await this.db.notification.findFirst({
      where: { id, userId },
    });
    if (!item) throw new NotFoundException('消息不存在');
    return this.db.notification.update({ where: { id }, data: { read: true } });
  }
  async readAllNotifications(userId: string, type?: string) {
    await this.db.notification.updateMany({
      where: { userId, ...(type ? { type } : {}) },
      data: { read: true },
    });
    return this.unreadNotificationCount(userId);
  }
  async unreadNotificationCount(userId: string) {
    const rows = await this.db.notification.groupBy({
      by: ['type'],
      where: { userId, read: false },
      _count: { _all: true },
    });
    return {
      total: rows.reduce((n, r) => n + r._count._all, 0),
      byType: Object.fromEntries(rows.map((r) => [r.type, r._count._all])),
    };
  }
}
