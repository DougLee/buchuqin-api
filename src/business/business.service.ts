import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  buildOrderTimeline,
  DELIVERING_STATUSES,
  markTimelineStep,
  statusPhase,
} from '../common/order-state';

/** @deprecated Seed/test compatibility only; production services use Prisma. */
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
/** 金额展示：分 → 元字符串（仅错误文案/通知文本用，接口一律返回分）。 */
const yuan = (cents: number) => (cents / 100).toFixed(2);

@Injectable()
export class BusinessService {
  /** IKA0BI：赠券额度/模板异常只记日志，不阻断支付主流程 */
  private static readonly logger = new Logger(BusinessService.name);
  constructor(
    private readonly db: PrismaService,
    // 渠道推送（IK8W5M）：可选注入——测试直接 new BusinessService(db) 时不传，跳过推送。
    @Optional() private readonly push?: NotificationsService,
  ) {}
  /** 金额单位:分（IK8W5K）。IK9SO6：生效值存 Campus 表（后台可配置），
   *  以下常量仅在 Campus 行缺失/字段为空时的兜底默认。 */
  static readonly DELIVERY_THRESHOLD_CENTS = 1000;
  static readonly DELIVERY_FEE_CENTS = {
    instant: 400,
    scheduled: 200,
  } as const;
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
      // 用户端异常单统一话术（履约侧细分原因由后台/履约端展示）。
      statusText:
        order.status === 'exception'
          ? '履约异常，客服处理中'
          : order.statusText,
      statusPhase: statusPhase(order.status),
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
      data: { userId, type, title, content },
    });
  }
  async campus(campusId: string) {
    const item = await this.db.campus.findFirst({ where: { id: campusId } });
    if (!item) throw new NotFoundException('校园不存在');
    return item;
  }
  async categories() {
    // 分类为全局字典（无 campusId 维度），商品侧按校园过滤。
    return this.db.category.findMany({ orderBy: { sort: 'asc' } });
  }
  private couponView(coupon: {
    id: string;
    name: string;
    amount: number;
    threshold: number;
    total: number;
    claimed: number;
    status: string;
    expiresAt: Date;
  }) {
    return {
      id: coupon.id,
      name: coupon.name,
      amount: coupon.amount,
      threshold: coupon.threshold,
      total: coupon.total,
      remain: Math.max(0, coupon.total - coupon.claimed),
      status: coupon.status,
      expiresAt: coupon.expiresAt.toISOString(),
    };
  }
  async coupons(userId: string, campusId: string) {
    const [items, mine] = await Promise.all([
      this.db.coupon.findMany({
        where: { campusId },
        orderBy: { expiresAt: 'asc' },
      }),
      this.db.userCoupon.findMany({
        where: { userId },
        include: { coupon: true },
        orderBy: { claimedAt: 'desc' },
      }),
    ]);
    const now = new Date();
    const holding = new Set(
      mine.filter((x) => x.status !== 'used').map((x) => x.couponId),
    );
    return {
      claimable: items
        .filter(
          (c) =>
            c.status === 'active' &&
            c.expiresAt > now &&
            c.claimed < c.total &&
            !holding.has(c.id),
        )
        .map((c) => this.couponView(c)),
      mine: mine.map((x) => ({
        id: x.id,
        couponId: x.couponId,
        status: x.status,
        claimedAt: x.claimedAt.toISOString(),
        coupon: this.couponView(x.coupon),
      })),
    };
  }
  async claimCoupon(userId: string, couponId: string, campusId: string) {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.userCoupon.findFirst({
        where: { userId, couponId },
      });
      if (existing) {
        // 幂等：重复领取直接返回已有记录。
        if (existing.status === 'used')
          throw new BadRequestException('该优惠券已使用');
        return existing;
      }
      const coupon = await tx.coupon.findUnique({ where: { id: couponId } });
      if (!coupon) throw new NotFoundException('优惠券不存在');
      // 券跨校园隔离：只能领取本校发放的券。
      if (coupon.campusId !== campusId)
        throw new BadRequestException('该优惠券不属于当前校园');
      if (coupon.status !== 'active')
        throw new BadRequestException('优惠券暂不可领取');
      if (coupon.expiresAt.getTime() <= Date.now())
        throw new BadRequestException('优惠券已过期');
      // 并发不超发：条件更新占用名额，抢不到名额即已领完。
      const won = await tx.coupon.updateMany({
        where: { id: couponId, claimed: { lt: coupon.total } },
        data: { claimed: { increment: 1 }, issued: { increment: 1 } },
      });
      if (!won.count) throw new BadRequestException('优惠券已被领完');
      return tx.userCoupon.create({
        data: { userId, couponId, status: 'claimed' },
      });
    });
  }
  /** 校验用于下单的 UserCoupon（couponId 语义为 UserCoupon id）。 */
  private async validateUserCoupon(
    userId: string,
    userCouponId: string,
    campusId: string,
  ) {
    const record = await this.db.userCoupon.findUnique({
      where: { id: userCouponId },
      include: { coupon: true },
    });
    if (!record || record.userId !== userId)
      throw new BadRequestException('优惠券不存在或无权使用');
    // 券跨校园隔离：只能使用本校发放的券。
    if (record.coupon.campusId !== campusId)
      throw new BadRequestException('该优惠券不属于当前校园');
    if (!['claimed', 'released'].includes(record.status))
      throw new BadRequestException('优惠券当前状态不可使用');
    // IKA0BI：bonus 为 2 小时送达专属赠券模板状态——不进公开可领列表、
    // 领取接口拒收，但已发放到账的券正常可用（active=常规券）
    if (!['active', 'bonus'].includes(record.coupon.status))
      throw new BadRequestException('优惠券已下架');
    if (record.coupon.expiresAt.getTime() <= Date.now())
      throw new BadRequestException('优惠券已过期');
    return record;
  }
  async buildings(campusId: string) {
    const xs = await this.db.building.findMany({
      where: { campusId, status: 'active' },
      orderBy: { createdAt: 'asc' },
    });
    return xs.map((x) => ({
      id: x.id,
      name: x.name,
      minFloor: 1,
      maxFloor: x.floors,
      hasElevator: x.hasElevator,
      gender: x.gender,
      available: true,
    }));
  }
  async slots(campusId: string) {
    return this.db.deliverySlot.findMany({
      where: { campusId },
      orderBy: { label: 'asc' },
    });
  }
  async home(campusId: string) {
    const [campus, banners, categories, products] = await Promise.all([
      this.campus(campusId),
      this.db.banner.findMany({
        where: { campusId, status: 'active' },
        orderBy: { sort: 'asc' },
      }),
      this.categories(),
      this.db.product.findMany({
        where: { campusId, status: 'on-sale' },
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
  async listProducts(campusId: string, categoryId?: string, keyword?: string) {
    const products = await this.db.product.findMany({
      where: {
        campusId,
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
  async product(id: string, campusId: string) {
    const item = await this.db.product.findFirst({
      where: { id, campusId, status: 'on-sale' },
    });
    if (!item) throw new NotFoundException('商品不存在');
    return this.productView(item);
  }
  async cart(userId: string) {
    const [rows, user] = await Promise.all([
      this.db.cartItem.findMany({
        where: { userId, quantity: { gt: 0 } },
        include: { product: true },
      }),
      this.db.user.findUnique({
        where: { id: userId },
        select: { campusId: true },
      }),
    ]);
    // IK9SO6：起送门槛读校园配置（后台可改），缺省回退常量
    const campus = user
      ? await this.db.campus.findUnique({
          where: { id: user.campusId },
          select: { deliveryThreshold: true },
        })
      : null;
    const items = rows.map((row) => ({
      product: this.productView(row.product),
      quantity: row.quantity,
    }));
    // 金额单位:分——全整数运算，无浮点误差（IK8W5K）。
    const productAmount = items.reduce(
      (sum, i) => sum + i.product.price * i.quantity,
      0,
    );
    return {
      items,
      productAmount,
      totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
      deliveryThreshold:
        campus?.deliveryThreshold ?? BusinessService.DELIVERY_THRESHOLD_CENTS,
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
        `商品金额满${yuan(cart.deliveryThreshold)}元起送`,
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
  async checkout(userId: string, campusId: string, dto: CreateOrderDto) {
    const { cart } = await this.validateQuote(userId, dto);
    // 运费（单位:分，IK9SO6）：读校园配置（后台可改），缺省回退常量。
    const campus = await this.db.campus.findUnique({
      where: { id: campusId },
      select: { deliveryFeeInstant: true, deliveryFeeScheduled: true },
    });
    const deliveryFee =
      dto.deliveryMode === 'instant'
        ? campus?.deliveryFeeInstant ?? BusinessService.DELIVERY_FEE_CENTS.instant
        : campus?.deliveryFeeScheduled ??
          BusinessService.DELIVERY_FEE_CENTS.scheduled;
    const userCoupon = dto.couponId
      ? await this.validateUserCoupon(userId, dto.couponId, campusId)
      : null;
    const discount = userCoupon ? userCoupon.coupon.amount : 0;
    if (userCoupon && cart.productAmount < userCoupon.coupon.threshold)
      throw new BadRequestException('商品金额未达到优惠券使用门槛');
    return {
      ...cart,
      deliveryFee,
      discount,
      payableAmount: cart.productAmount + deliveryFee - discount,
      estimatedArrival:
        dto.deliveryMode === 'instant'
          ? '预计 30-60 分钟送达'
          : `${dto.deliverySlot} 送达`,
    };
  }
  async createOrder(userId: string, campusId: string, dto: CreateOrderDto) {
    const { address } = await this.validateQuote(userId, dto);
    const settlement = await this.checkout(userId, campusId, dto);
    const now = new Date();
    // 12 态状态机标准 timeline（IK93GQ）：含"楼下待交接"节点。
    const timeline: TimelineStep[] = buildOrderTimeline(
      `${address.buildingName} ${address.room}`,
    );
    const order = await this.db.$transaction(async (tx) => {
      if (dto.couponId) {
        // 下单锁定优惠券：claimed/released -> locked，条件更新防并发重复占用。
        const locked = await tx.userCoupon.updateMany({
          where: {
            id: dto.couponId,
            userId,
            status: { in: ['claimed', 'released'] },
          },
          data: { status: 'locked' },
        });
        if (!locked.count)
          throw new BadRequestException('优惠券不可用或已被锁定');
      }
      return tx.order.create({
        data: {
          // orderNo 唯一约束：时间戳 + 随机后缀防同毫秒并发冲突
          orderNo: `BCQ${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
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
    });
    return this.orderView(order);
  }
  /** 待支付超时阈值：15 分钟。 */
  static readonly PAYMENT_TIMEOUT_MS = 15 * 60 * 1000;
  /**
   * 条件关单一批超时待支付单（与并发 pay/cancel 互斥）。
   * 用户侧懒执行（expirePendingOrders）与支付超时 Cron（IK8W5I）共用。
   */
  private async closeStalePendingOrders(
    stale: Array<{ id: string; couponId: string | null }>,
  ) {
    if (!stale.length) return;
    await this.db.$transaction(async (tx) => {
      for (const order of stale) {
        // 逐单条件关单：仅当仍处于待支付时生效，避免与并发 pay/cancel 双写。
        // 待支付单未扣库存，关单只需释放券，无需回补库存。
        const closed = await tx.order.updateMany({
          where: { id: order.id, status: 'pending-payment' },
          data: { status: 'cancelled', statusText: '支付超时已关闭' },
        });
        if (closed.count && order.couponId)
          await tx.userCoupon.updateMany({
            where: { id: order.couponId, status: 'locked' },
            data: { status: 'released' },
          });
      }
    });
  }
  private async expirePendingOrders(userId: string) {
    const deadline = new Date(Date.now() - BusinessService.PAYMENT_TIMEOUT_MS);
    const stale = await this.db.order.findMany({
      where: {
        userId,
        status: 'pending-payment',
        createdAt: { lt: deadline },
      },
      select: { id: true, couponId: true },
    });
    await this.closeStalePendingOrders(stale);
  }
  /** 全量超时待支付关单（支付超时 Cron 调用，见 IK8W5I）。 */
  async expireAllPendingOrders() {
    const deadline = new Date(Date.now() - BusinessService.PAYMENT_TIMEOUT_MS);
    const stale = await this.db.order.findMany({
      where: { status: 'pending-payment', createdAt: { lt: deadline } },
      select: { id: true, couponId: true },
    });
    await this.closeStalePendingOrders(stale);
    return stale.length;
  }
  async orders(userId: string, status?: string) {
    await this.expirePendingOrders(userId);
    const delivering = DELIVERING_STATUSES;
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
      // 顺序重复点击：已支付直接幂等返回。
      if (raw.status === 'paid') return this.orderView(raw);
      if (
        Date.now() - raw.createdAt.getTime() >=
        BusinessService.PAYMENT_TIMEOUT_MS
      ) {
        // 条件关单：仅当仍待支付才关闭并释放券（与并发 pay/cancel 互斥）。
        await tx.order.updateMany({
          where: { id, status: 'pending-payment' },
          data: { status: 'cancelled', statusText: '支付超时已关闭' },
        });
        if (raw.couponId)
          await tx.userCoupon.updateMany({
            where: { id: raw.couponId, status: 'locked' },
            data: { status: 'released' },
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
      const timeline = raw.timeline as unknown as TimelineStep[],
        paidAt = new Date();
      timeline[0] = { ...timeline[0], done: true, time: paidAt.toISOString() };
      // 条件更新抢占支付权：并发的第二笔支付 count=0 直接失败，
      // 库存扣减与后续副作用都移到抢占成功之后，防止双扣。
      const won = await tx.order.updateMany({
        where: { id, status: 'pending-payment' },
        data: {
          status: 'paid',
          statusText: '仓库正在接单',
          paidAt,
          timeline: json(timeline),
          // 包裹码随支付生成（骑手取货扫码时须回传校验）
          package: json({
            id: `PKG-${randomUUID().slice(0, 8).toUpperCase()}`,
            status: 'waiting-pick',
          }),
        },
      });
      if (!won.count) throw new BadRequestException('订单状态已变化');
      for (const line of items)
        await tx.product.update({
          where: { id: line.product.id },
          data: { stock: { decrement: line.quantity } },
        });
      const updated = await tx.order.findUniqueOrThrow({ where: { id } });
      if (raw.couponId) {
        // 支付成功：locked -> used，并累计券维度的已使用计数。
        const used = await tx.userCoupon.updateMany({
          where: { id: raw.couponId, status: 'locked' },
          data: { status: 'used' },
        });
        if (used.count) {
          const holding = await tx.userCoupon.findUniqueOrThrow({
            where: { id: raw.couponId },
            select: { couponId: true },
          });
          await tx.coupon.update({
            where: { id: holding.couponId },
            data: { used: { increment: 1 } },
          });
        }
      }
      await tx.cartItem.deleteMany({ where: { userId } });
      // IKA0BI：2 小时送达赠券（结算页对用户的承诺）——预约单支付成功随
      // 事务发放。券模板由运营在后台创建后切 status=paused（隐藏于公开
      // 可领列表，领取接口也拒非 active），再配 SCHEDULED_BONUS_COUPON_ID
      // 启用；额度不足/未配置只记日志，绝不影响支付主流程。
      // pay() 幂等（已支付早退）保证不重发。
      const bonusCouponId = process.env.SCHEDULED_BONUS_COUPON_ID;
      if (bonusCouponId && raw.deliveryMode === 'scheduled') {
        const bonus = await tx.coupon.findUnique({
          where: { id: bonusCouponId },
        });
        if (bonus && bonus.expiresAt.getTime() > Date.now()) {
          const wonBonus = await tx.coupon.updateMany({
            where: { id: bonus.id, claimed: { lt: bonus.total } },
            data: { claimed: { increment: 1 }, issued: { increment: 1 } },
          });
          if (wonBonus.count) {
            await tx.userCoupon.create({
              data: { userId, couponId: bonus.id },
            });
            await tx.notification.create({
              data: {
                userId,
                type: 'coupon',
                title: '赠券到账',
                content: `感谢选择 2 小时送达，${bonus.name} 已放入你的账户，下次下单可用。`,
              },
            });
          } else {
            BusinessService.logger.warn(
              `赠券额度不足：order=${raw.orderNo} coupon=${bonusCouponId}`,
            );
          }
        } else {
          BusinessService.logger.warn(
            `赠券模板未配置/停用/已过期：order=${raw.orderNo} coupon=${bonusCouponId ?? '未配置'}`,
          );
        }
      }
      await tx.notification.create({
        data: {
          userId,
          type: 'order',
          title: '支付成功',
          content: '订单已进入湖工大校园仓，仓储人员即将开始拣货。',
        },
      });
      // 渠道推送（IK8W5M）：支付成功订阅消息。fire-and-forget，不进事务、不阻断。
      void this.push?.orderStatusPush({
        id: updated.id,
        userId,
        orderNo: updated.orderNo,
        status: 'paid',
        statusText: '支付成功',
        payableAmount: updated.payableAmount,
      });
      return this.orderView(updated);
    });
  }
  /**
   * 管理端推进履约（orderAction advance）：沿 12 态状态机单步前进。
   * 迁移表见 src/common/order-state.ts 注释（IK93GQ）。
   */
  private static readonly ADVANCE_MAP: Record<string, [string, string]> = {
    paid: ['picking', '仓库正在拣货'],
    picking: ['waiting-first-mile', '已出库，待配送员接单'],
    'waiting-first-mile': ['first-mile', '配送中，骑手送往楼下'],
    'first-mile': ['waiting-handover', '已到楼下，等待楼长交接'],
    'waiting-handover': ['last-mile', '楼长送往寝室'],
    'last-mile': ['delivered', '已送达寝室'],
    delivered: ['completed', '已确认收货'],
  };
  async advance(userId: string, id: string) {
    const raw = await this.db.order.findFirst({ where: { id, userId } });
    if (!raw) throw new NotFoundException('订单不存在');
    const next = BusinessService.ADVANCE_MAP[raw.status];
    if (!next) throw new BadRequestException('当前状态不可推进履约');
    const [status, statusText] = next;
    // 条件更新：并发推进（双人操作/与履约端同时改单）时仅一笔生效。
    const won = await this.db.order.updateMany({
      where: { id, status: raw.status },
      data: {
        status,
        statusText,
        timeline: markTimelineStep(raw.timeline, status),
      },
    });
    if (!won.count) throw new BadRequestException('订单状态已变化');
    const updated = await this.db.order.findUniqueOrThrow({ where: { id } });
    await this.notify(
      userId,
      'delivery',
      updated.statusText,
      `${updated.orderNo} 的履约状态已更新。`,
    );
    // 渠道推送（IK8W5M）：出库/一级配送中/即将到楼/已送达 订阅消息（已送达带短信兜底）。
    void this.push?.orderStatusPush({
      id: updated.id,
      userId,
      orderNo: updated.orderNo,
      status: updated.status,
      statusText: updated.statusText,
      payableAmount: updated.payableAmount,
    });
    return this.orderView(updated);
  }
  /**
   * 仓库出库（IKA0UQ）：paid/picking 一步转 waiting-first-mile（已出库，待配送），
   * 跳过拣货中间态——v1 履约简化（IKA0UM 同批）后 picking 不在主链路上。
   * 库存不在此扣减：支付时已扣（pay 事务），此处仅记出库流水供「出入库流水」
   * 页对账，delta 记商品出库数量、reason 注明支付已扣，避免被当二次扣减。
   */
  async outbound(id: string, operator: string) {
    const raw = await this.db.order.findUnique({ where: { id } });
    if (!raw) throw new NotFoundException('订单不存在');
    if (!['paid', 'picking'].includes(raw.status))
      throw new BadRequestException(
        raw.status === 'waiting-first-mile'
          ? '该订单已出库，无需重复操作'
          : '当前状态不可出库',
      );
    const lines = (raw.items as Array<{
      product?: { id?: string };
      quantity: number;
    }>) ?? [];
    const updated = await this.db.$transaction(async (tx) => {
      // 条件更新：与后台改状态/另一管理员同时出库并发时仅一笔生效。
      const won = await tx.order.updateMany({
        where: { id, status: raw.status },
        data: {
          status: 'waiting-first-mile',
          statusText: '已出库，待配送员接单',
          timeline: markTimelineStep(raw.timeline, 'waiting-first-mile'),
        },
      });
      if (!won.count) throw new BadRequestException('订单状态已变化');
      // 出库流水（IKA0UQ 验收：库存正确扣减——支付时已扣，此处记账不重复扣）。
      for (const line of lines) {
        const productId = line.product?.id;
        if (productId)
          await tx.inventoryTxn.create({
            data: {
              productId,
              type: 'out',
              delta: -line.quantity,
              reason: `订单出库 ${raw.orderNo}（库存已于支付时扣减）`,
              operator,
            },
          });
      }
      return tx.order.findUniqueOrThrow({ where: { id } });
    });
    await this.notify(
      updated.userId,
      'delivery',
      updated.statusText,
      `${updated.orderNo} 已从仓库发出，等待配送员接单。`,
    );
    void this.push?.orderStatusPush({
      id: updated.id,
      userId: updated.userId,
      orderNo: updated.orderNo,
      status: updated.status,
      statusText: updated.statusText,
      payableAmount: updated.payableAmount,
    });
    return this.orderView(updated);
  }
  async confirmReceipt(userId: string, id: string) {
    const raw = await this.db.order.findFirst({ where: { id, userId } });
    if (!raw) throw new NotFoundException('订单不存在');
    // delivered（楼长已送达）与 completed 分离：确认收货才进入终态 completed。
    if (!['delivered', 'completed'].includes(raw.status))
      throw new BadRequestException('当前状态不可确认收货');
    if (raw.status === 'completed') return this.orderView(raw);
    // 条件更新：与售后退款/异常标记并发时仅一笔生效。
    const won = await this.db.order.updateMany({
      where: { id, status: 'delivered' },
      data: {
        status: 'completed',
        statusText: '已确认收货',
        timeline: markTimelineStep(raw.timeline, 'completed'),
      },
    });
    if (!won.count) throw new BadRequestException('订单状态已变化');
    return this.orderView(
      await this.db.order.findUniqueOrThrow({ where: { id } }),
    );
  }
  async cancel(userId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const raw = await tx.order.findFirst({ where: { id, userId } });
      if (!raw) throw new NotFoundException('订单不存在');
      // ADR-0004：试点期不退款，已支付订单不可自助取消（客服人工处理），
      // 系统任何路径都不再创建 Refund 记录。
      if (raw.status === 'paid')
        throw new BadRequestException('订单已支付，如需取消请联系客服处理');
      if (raw.status !== 'pending-payment')
        throw new BadRequestException('当前状态不可取消');
      // 条件更新抢占取消权：并发双取消只有一单成功，
      // 释放券等补偿动作全部移到抢占成功之后，防止双补。
      const won = await tx.order.updateMany({
        where: { id, status: raw.status },
        data: { status: 'cancelled', statusText: '订单已取消' },
      });
      if (!won.count) throw new BadRequestException('订单状态已变化');
      if (raw.couponId)
        // 取消订单：locked/used -> released，released 状态可再次选用。
        await tx.userCoupon.updateMany({
          where: { id: raw.couponId, status: { in: ['locked', 'used'] } },
          data: { status: 'released' },
        });
      const updated = await tx.order.findUniqueOrThrow({ where: { id } });
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
    const campus = await this.campus(campusId);
    const building = await this.db.building.findFirst({
      where: { campusId, name: dto.buildingName },
    });
    return this.db.address.create({
      data: {
        userId,
        campusId,
        campusName: campus.name,
        buildingId: building?.id ?? dto.buildingName,
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
  async availableCoupons(
    userId: string,
    campusId: string,
    dto: CreateOrderDto,
  ) {
    const { cart } = await this.validateQuote(userId, {
      ...dto,
      couponId: undefined,
    });
    const rows = await this.db.userCoupon.findMany({
      // 只看本校发放的券（跨校园券不可用）。
      where: {
        userId,
        status: { in: ['claimed', 'released'] },
        coupon: { campusId },
      },
      include: { coupon: true },
      orderBy: { claimedAt: 'desc' },
    });
    const now = new Date();
    return rows.map((row) => {
      const amount = row.coupon.amount,
        threshold = row.coupon.threshold;
      let reason: string | undefined;
      if (row.coupon.status !== 'active') reason = '优惠券已下架';
      else if (row.coupon.expiresAt <= now) reason = '优惠券已过期';
      else if (cart.productAmount < threshold)
        reason = `还差${yuan(threshold - cart.productAmount)}元可用`;
      return {
        id: row.id,
        couponId: row.couponId,
        name: row.coupon.name,
        amount,
        threshold,
        status: row.status,
        expiresAt: row.coupon.expiresAt.toISOString(),
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
    // delivered（已送达待确认）即可申请售后，不必等用户确认收货。
    if (!['delivered', 'completed'].includes(order.status))
      throw new BadRequestException('订单送达后才能申请售后');
    // 送达时间优先取送达凭证时间（delivered 动作写入），历史单回退 timeline 末节点。
    const proof = (order.package as unknown as Record<string, any> | null)
      ?.proof;
    const timeline = order.timeline as unknown as TimelineStep[];
    const deliveredAt = proof?.time ?? timeline.at(-1)?.time;
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
