import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { NightPaymentHandler } from '../payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { marketingEnabled } from '../common/capability';
import {
  beijingDate,
  beijingMinutes,
  commissionOf,
  hhmmToMinutes,
  inNightWindow,
  nightBusinessDate,
  nightDepositTradeNo,
  nightOrderNo,
} from './night.helpers';
import { NightOrderCreateDto, NightRefundDto } from './night.dto';

/** JSON → 时间线（json() 自写自读，形状恒定；round-trip 避开 any 断言规则）。 */
const asTimeline = (v: unknown): NightTimelineStep[] =>
  JSON.parse(JSON.stringify(Array.isArray(v) ? v : [])) as NightTimelineStep[];

/** 夜宵订单行快照（items JSON）。 */
export interface NightOrderLine {
  nightProductId: string;
  catalogProductId: string;
  name: string;
  image: string;
  price: number; // 夜宵售价（分）
  quantity: number;
}

/** 夜宵订单时间线节点（轻量自持，不复用白天 12 态）。 */
export interface NightTimelineStep {
  key: string;
  title: string;
  time?: string;
}

const STATUS_TEXT: Record<string, string> = {
  'pending-payment': '等待支付',
  'pending-accept': '待接单',
  delivering: '配送中',
  delivered: '已送达',
  completed: '已完成',
  cancelled: '已取消',
  refunded: '已退款',
  exception: '支付异常',
};

/** 待支付超时缺省（分钟）：校区 nightPayTimeout 未配置时的兜底。 */
const DEFAULT_PAY_TIMEOUT_MIN = 15;
/** 送达后自动完成（小时）：用户未确认时的兜底（夜间场次次日已过，24h 足够）。 */
const AUTO_COMPLETE_HOURS = 24;

type Tx = Prisma.TransactionClient;

const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/**
 * 楼栋夜宵店订单域服务（IKSW1F）：下单/取消/完成/退款/佣金/结算/支付落账。
 * 与白天业务完全隔离——不读写 Order/CartItem/Product.stock，库存只走
 * NightProduct + NightStockTxn，佣金只走 NightCommissionTxn。
 */
@Injectable()
export class NightOrderService implements NightPaymentHandler {
  private readonly logger = new Logger(NightOrderService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly payments: PaymentsService,
    // 渠道推送：可选注入（单测直接 new 时不传，跳过推送）
    @Optional() private readonly push?: NotificationsService,
  ) {
    // 注册微信回调分发（YX/ND 前缀）；setter 注入避免模块循环依赖
    this.payments.registerNightPaymentHandler(this);
  }

  /* ==================== 视图 ==================== */

  orderView(order: {
    id: string;
    orderNo: string;
    status: string;
    statusText: string;
    items: Prisma.JsonValue;
    productAmount: number;
    couponDiscount: number;
    deliveryFee: number;
    payableAmount: number;
    commissionRate: number;
    address: Prisma.JsonValue;
    remark: string;
    timeline: Prisma.JsonValue;
    couponSnapshot: Prisma.JsonValue;
    businessDate: string;
    timeoutAt: Date | null;
    createdAt: Date;
    paidAt: Date | null;
    completedAt: Date | null;
    cancelReason: string | null;
    afterSaleStatus: string | null;
    store?: {
      id: string;
      building: { name: string };
    } | null;
  }) {
    return {
      id: order.id,
      orderNo: order.orderNo,
      status: order.status,
      statusText: order.statusText,
      items: order.items,
      productAmount: order.productAmount,
      couponDiscount: order.couponDiscount,
      deliveryFee: order.deliveryFee,
      payableAmount: order.payableAmount,
      commissionRate: order.commissionRate,
      address: order.address,
      remark: order.remark,
      timeline: order.timeline,
      couponSnapshot: order.couponSnapshot,
      businessDate: order.businessDate,
      timeoutAt: order.timeoutAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
      completedAt: order.completedAt?.toISOString() ?? null,
      cancelReason: order.cancelReason,
      afterSaleStatus: order.afterSaleStatus,
      store: order.store
        ? { id: order.store.id, buildingName: order.store.building.name }
        : null,
    };
  }

  /* ==================== 用户端：下单 ==================== */

  /**
   * 提交夜宵订单（服务端全量重验）：营业状态/场次窗口/上架售卖许可/库存
   * 足量/本楼地址/夜宵券资格。事务内原子生效：券锁定 + 库存扣减（条件
   * UPDATE 防超卖）+ 订单落库（YX 单号，timeoutAt=now+校区配置）。
   * 库存在下单即扣（预占口径），支付成功只是状态推进；超时关单回补。
   */
  async submitOrder(userId: string, dto: NightOrderCreateDto) {
    const store = await this.db.nightStore.findUnique({
      where: { id: dto.storeId },
      include: {
        campus: {
          select: {
            id: true,
            nightEnabled: true,
            nightStartAt: true,
            nightEndAt: true,
            nightPayTimeout: true,
            nightDeliveryFee: true,
            deliveryFeeInstant: true,
            closeStart: true,
            closeEnd: true,
            manualClosed: true,
          },
        },
      },
    });
    if (!store) throw new NotFoundException('夜宵店不存在');
    if (!store.managerStaffId)
      throw new BadRequestException('本楼夜宵店暂无楼长经营');
    if (store.status !== 'open')
      throw new BadRequestException('夜宵店当前未营业');
    this.assertNightWindow(store.campus);
    const address = await this.db.address.findFirst({
      where: { id: dto.addressId, userId },
    });
    if (!address) throw new BadRequestException('地址不存在或无权使用');
    if (address.campusId !== store.campusId)
      throw new BadRequestException('请选择当前校区的收货地址');
    if (address.buildingId !== store.buildingId)
      throw new BadRequestException('夜宵订单仅支持本楼配送，请重新选店');

    // 行合并（同商品多行合并数量）后逐行验货验价
    const merged = new Map<string, number>();
    for (const line of dto.items) {
      merged.set(
        line.productId,
        (merged.get(line.productId) ?? 0) + line.quantity,
      );
    }
    const productRows = await this.db.nightProduct.findMany({
      where: { id: { in: [...merged.keys()] }, storeId: store.id },
      include: {
        catalogProduct: {
          select: { name: true, image: true, price: true, status: true },
        },
      },
    });
    if (productRows.length !== merged.size)
      throw new BadRequestException('存在无效商品，请重新选购');
    const lines: NightOrderLine[] = productRows.map((p) => ({
      nightProductId: p.id,
      catalogProductId: p.catalogProductId,
      name: p.catalogProduct.name,
      image: p.catalogProduct.image,
      price: p.catalogProduct.price,
      quantity: merged.get(p.id)!,
    }));
    for (const p of productRows) {
      if (!p.onShelf || !p.saleAllowed)
        throw new BadRequestException(`${p.catalogProduct.name}已下架`);
      if (p.catalogProduct.status !== 'on-sale')
        throw new BadRequestException(`${p.catalogProduct.name}已停售`);
      if (p.stock < merged.get(p.id)!)
        throw new BadRequestException(`${p.catalogProduct.name}库存不足`);
    }
    const productAmount = lines.reduce((s, l) => s + l.price * l.quantity, 0);
    const deliveryFee =
      store.campus.nightDeliveryFee ?? store.campus.deliveryFeeInstant;

    // 夜宵券校验（businessType=night 强隔离：白天券在夜宵结算不可用）
    const userCoupon = dto.couponId
      ? await this.validateNightCoupon(userId, dto.couponId, store.campusId)
      : null;
    const couponDiscount = userCoupon ? userCoupon.coupon.amount : 0;
    if (userCoupon && productAmount < userCoupon.coupon.threshold)
      throw new BadRequestException('商品金额未达到夜宵券使用门槛');
    // 无门槛大额券防负数单：抵扣超过商品金额的差额不生效（券不抵配送费，
    // PRD 6.9「券优惠不超过适用商品金额，不找零」）
    const effectiveDiscount = Math.min(couponDiscount, productAmount);
    const payableAmount = productAmount - effectiveDiscount + deliveryFee;

    const order = await this.db.$transaction(async (tx) => {
      if (userCoupon) {
        // 下单锁定优惠券：claimed/released -> locked（与白天同构，防并发双占）
        const locked = await tx.userCoupon.updateMany({
          where: {
            id: userCoupon.id,
            userId,
            status: { in: ['claimed', 'released'] },
          },
          data: { status: 'locked' },
        });
        if (!locked.count)
          throw new BadRequestException('优惠券不可用或已被锁定');
      }
      // 条件扣库存：影响行数=0 即超卖竞争失败，整个事务回滚（券锁定一并回滚）
      for (const line of lines) {
        const dec = await tx.$executeRaw`
          UPDATE "NightProduct" SET stock = stock - ${line.quantity}
          WHERE id = ${line.nightProductId} AND stock >= ${line.quantity}`;
        if (!dec) throw new BadRequestException(`${line.name}库存不足`);
      }
      const now = new Date();
      return tx.nightOrder.create({
        data: {
          orderNo: nightOrderNo(),
          storeId: store.id,
          managerStaffId: store.managerStaffId,
          userId,
          businessDate: nightBusinessDate(now),
          status: 'pending-payment',
          statusText: STATUS_TEXT['pending-payment'],
          items: json(lines),
          productAmount,
          couponDiscount: effectiveDiscount,
          deliveryFee,
          payableAmount,
          couponId: userCoupon?.id ?? null,
          couponSnapshot: userCoupon
            ? json({
                name: userCoupon.coupon.name,
                amount: userCoupon.coupon.amount,
                threshold: userCoupon.coupon.threshold,
              })
            : Prisma.JsonNull,
          commissionRate: store.commissionRate,
          address: json({
            buildingId: address.buildingId,
            buildingName: address.buildingName,
            floor: address.floor,
            room: address.room,
            contactName: address.contactName,
            phone: address.phone,
          }),
          remark: dto.remark ?? '',
          timeline: json([{ key: 'submit', title: '订单已提交' }]),
          timeoutAt: new Date(
            now.getTime() +
              (store.campus.nightPayTimeout ?? DEFAULT_PAY_TIMEOUT_MIN) *
                60 *
                1000,
          ),
        },
      });
    });
    return this.orderView(order);
  }

  /** 夜宵券校验（下单用）：businessType/校区/有效期/状态强校验。 */
  private async validateNightCoupon(
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
    if (record.coupon.campusId !== campusId)
      throw new BadRequestException('该优惠券不属于当前校区');
    // 券双向隔离（T52）：夜宵订单只能用夜宵券
    if (record.coupon.businessType !== 'night')
      throw new BadRequestException('白天券不可用于夜宵订单');
    if (!['claimed', 'released'].includes(record.status))
      throw new BadRequestException('优惠券当前状态不可使用');
    if (record.coupon.kind === 'partner')
      throw new BadRequestException('异业券不参与下单抵扣');
    if (
      record.coupon.expiresAt &&
      record.coupon.expiresAt.getTime() <= Date.now()
    )
      throw new BadRequestException('优惠券已过期');
    return record;
  }

  /* ==================== 用户端：查询/取消/确认/售后 ==================== */

  /** 懒执行：本人待支付超时单先关单（与支付回调/取消并发互斥靠条件更新）。 */
  private async expireMyPendingOrders(userId: string) {
    const stale = await this.db.nightOrder.findMany({
      where: {
        userId,
        status: 'pending-payment',
        timeoutAt: { lt: new Date() },
      },
      select: { id: true },
      take: 20,
    });
    for (const row of stale)
      await this.closePendingPayment(row.id, '支付超时已关闭');
  }

  async myOrders(userId: string, status?: string) {
    await this.expireMyPendingOrders(userId);
    const rows = await this.db.nightOrder.findMany({
      where: {
        userId,
        ...(status && status !== 'all' ? { status } : {}),
      },
      include: { store: { include: { building: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((o) => this.orderView(o));
  }

  async myOrder(userId: string, id: string) {
    await this.expireMyPendingOrders(userId);
    const order = await this.db.nightOrder.findFirst({
      where: { id, userId },
      include: { store: { include: { building: { select: { name: true } } } } },
    });
    if (!order) throw new NotFoundException('订单不存在');
    return this.orderView(order);
  }

  /**
   * 用户取消：未支付直接关单（释放券+回补库存）；已支付未接单走全额原路
   * 退款（券恢复/库存回补/佣金冲销）。接单后不可取消，走售后。
   */
  async cancelByUser(userId: string, id: string, reason?: string) {
    const order = await this.db.nightOrder.findFirst({ where: { id, userId } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status === 'pending-payment') {
      await this.closePendingPayment(id, '用户取消');
      return this.myOrder(userId, id);
    }
    if (order.status !== 'pending-accept')
      throw new BadRequestException('楼长已接单，请联系客服处理售后');
    // 已支付未接单：状态流转 + 资源释放在一个事务里（退款在事务外尝试）
    await this.db.$transaction(async (tx) => {
      const won = await tx.nightOrder.updateMany({
        where: { id, status: 'pending-accept' },
        data: {
          status: 'cancelled',
          statusText: '已取消',
          cancelReason: (reason ?? '用户取消').slice(0, 120),
          timeline: json([
            ...asTimeline(order.timeline),
            {
              key: 'cancel',
              title: '用户取消（退款原路退回中）',
              time: new Date().toISOString(),
            },
          ]),
        },
      });
      if (!won.count) throw new BadRequestException('订单状态已变化');
      await this.releaseOrderResources(tx, order);
      await this.reverseCommission(tx, order.id, '订单取消冲销');
      await tx.notification.create({
        data: {
          userId,
          type: 'order',
          title: '夜宵订单已取消',
          content: `订单 ${order.orderNo} 已取消，货款将原路退回。`,
        },
      });
    });
    // 原路退款：微信未配置（测试环境）留痕人工处理，不阻塞取消
    await this.tryWechatRefund(
      order,
      order.payableAmount,
      `NR${order.id}`,
      reason ?? '用户取消',
    );
    return this.myOrder(userId, id);
  }

  /** 送达确认（用户）：completed + 佣金 estimated → pending。 */
  async confirmOrder(userId: string, id: string) {
    const order = await this.db.nightOrder.findFirst({ where: { id, userId } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'delivered')
      throw new BadRequestException('订单当前状态不可确认收货');
    const won = await this.db.nightOrder.updateMany({
      where: { id, status: 'delivered' },
      data: {
        status: 'completed',
        statusText: STATUS_TEXT.completed,
        completedAt: new Date(),
        timeline: json([
          ...asTimeline(order.timeline),
          { key: 'completed', title: '已完成', time: new Date().toISOString() },
        ]),
      },
    });
    if (!won.count) throw new BadRequestException('订单状态已变化');
    await this.promoteCommissionToPending(id);
    return this.myOrder(userId, id);
  }

  /**
   * 售后申请（一期轻量承载）：写 timeline + afterSaleStatus=requested。
   * requested 期间该单佣金不得转 pending（「无进行中售后」判定）；
   * 实际退款由后台 /admin/night/orders/:id/refund 完成（回写 resolved）。
   */
  async applyAfterSale(
    userId: string,
    id: string,
    body: {
      type: string;
      description: string;
      images?: string[];
    },
  ) {
    const order = await this.db.nightOrder.findFirst({ where: { id, userId } });
    if (!order) throw new NotFoundException('订单不存在');
    if (!['delivered', 'completed'].includes(order.status))
      throw new BadRequestException('当前状态不可申请售后');
    const updated = await this.db.nightOrder.updateMany({
      where: { id, status: order.status, afterSaleStatus: null },
      data: {
        afterSaleStatus: 'requested',
        timeline: json([
          ...asTimeline(order.timeline),
          {
            key: 'after-sale',
            title: `用户申请售后（${body.type}）：${body.description.slice(0, 60)}`,
            time: new Date().toISOString(),
          },
        ]),
      },
    });
    if (!updated.count)
      throw new BadRequestException('售后申请已存在，请等待处理');
    return { id, afterSaleStatus: 'requested' };
  }

  /* ==================== 楼长端：接单/送达 ==================== */

  async acceptOrder(staffId: string, storeId: string, id: string) {
    const order = await this.db.nightOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.storeId !== storeId) throw new ForbiddenException('非本店订单');
    if (order.status !== 'pending-accept')
      throw new BadRequestException('当前状态不可接单');
    const won = await this.db.nightOrder.updateMany({
      where: { id, status: 'pending-accept' },
      data: {
        status: 'delivering',
        statusText: STATUS_TEXT.delivering,
        timeline: json([
          ...asTimeline(order.timeline),
          {
            key: 'accepted',
            title: '楼长已接单',
            time: new Date().toISOString(),
          },
        ]),
      },
    });
    if (!won.count) throw new BadRequestException('订单状态已变化');
    await this.db.notification.create({
      data: {
        userId: order.userId,
        type: 'order',
        title: '夜宵订单已接单',
        content: `订单 ${order.orderNo} 楼长已接单，正在为你配送。`,
      },
    });
    return { id, status: 'delivering' };
  }

  async deliverOrder(staffId: string, storeId: string, id: string) {
    const order = await this.db.nightOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.storeId !== storeId) throw new ForbiddenException('非本店订单');
    if (order.status !== 'delivering')
      throw new BadRequestException('当前状态不可标记送达');
    const won = await this.db.nightOrder.updateMany({
      where: { id, status: 'delivering' },
      data: {
        status: 'delivered',
        statusText: STATUS_TEXT.delivered,
        timeline: json([
          ...asTimeline(order.timeline),
          { key: 'delivered', title: '已送达', time: new Date().toISOString() },
        ]),
      },
    });
    if (!won.count) throw new BadRequestException('订单状态已变化');
    await this.db.notification.create({
      data: {
        userId: order.userId,
        type: 'delivery',
        title: '夜宵订单已送达',
        content: `订单 ${order.orderNo} 已送达，请确认收货。`,
      },
    });
    return { id, status: 'delivered' };
  }

  /* ==================== 支付 ==================== */

  /** 夜宵订单微信支付下单（复用 payments JSAPI 通道，业务标记 YX 单号）。 */
  async prepayOrder(userId: string, orderId: string) {
    const order = await this.db.nightOrder.findFirst({
      where: { id: orderId, userId },
      include: { store: { select: { campusId: true } } },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'pending-payment')
      throw new BadRequestException('当前状态不可支付');
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { openid: true },
    });
    if (!user.openid)
      throw new BadRequestException('当前用户无微信 openid，无法发起支付');
    const payParams = await this.payments.nightPrepay({
      campusId: order.store.campusId,
      outTradeNo: order.orderNo,
      amount: order.payableAmount,
      openid: user.openid,
      description: `夜宵订单 ${order.orderNo}`,
    });
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      amount: order.payableAmount,
      payParams,
    };
  }

  /** 支付结果轮询兜底：超 30 秒未收到回调时主动向微信查单落账。 */
  async orderPayStatus(userId: string, orderId: string) {
    let order = await this.db.nightOrder.findFirst({
      where: { id: orderId, userId },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (
      order.status === 'pending-payment' &&
      Date.now() - order.createdAt.getTime() > 30_000
    ) {
      try {
        const store = await this.db.nightStore.findUnique({
          where: { id: order.storeId },
          select: { campusId: true },
        });
        const trade = await this.payments.nightTradeState(
          order.orderNo,
          store?.campusId ?? '',
        );
        if (trade.tradeState === 'SUCCESS')
          await this.applyNightOrderPaid(order.orderNo, trade.transactionId);
        order =
          (await this.db.nightOrder.findUnique({ where: { id: order.id } })) ??
          order;
      } catch {
        // 查单/落账失败不阻塞状态返回
      }
    }
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      status: order.status,
      statusText: order.statusText,
      paid: order.paidAt != null,
    };
  }

  /**
   * 夜宵订单支付落账（回调 + 查单兜底共用，幂等）：
   * pending-payment → pending-accept；券 locked → used；佣金流水两条
   * （commission=券后基数×比例快照 / deliveryFee=配送费全额）status=estimated；
   * 触发楼长新单推送（复用履约端订阅链，fire-and-forget）。
   * 库存已于下单扣减，此处只确认不再重复扣。
   */
  async applyNightOrderPaid(orderNo: string, transactionId?: string) {
    void transactionId; // 留参对齐回调签名（交易号仅日志用，一期不落库）
    await this.db.$transaction(async (tx) => {
      const order = await tx.nightOrder.findUnique({ where: { orderNo } });
      if (!order) throw new NotFoundException('夜宵订单不存在');
      // 幂等：已支付直接返回（重复回调/并发回调只生效一次）
      if (order.status !== 'pending-payment') {
        if (order.status === 'cancelled') {
          // 超时关单后微信才扣款成功：不复活店铺/订单（PRD 6.2），转异常单
          // 冻结现场待客服退款——条件更新防重复通知
          const frozen = await tx.nightOrder.updateMany({
            where: { id: order.id, status: 'cancelled' },
            data: {
              status: 'exception',
              statusText: '支付已收到但订单已关闭，请联系客服处理',
              paidAt: new Date(),
            },
          });
          if (frozen.count)
            await tx.notification.create({
              data: {
                userId: order.userId,
                type: 'order',
                title: '夜宵订单异常提醒',
                content: `订单 ${order.orderNo} 支付已收到但订单已超时关闭，客服会尽快处理退款，请勿重复支付。`,
              },
            });
        }
        return;
      }
      const won = await tx.nightOrder.updateMany({
        where: { id: order.id, status: 'pending-payment' },
        data: {
          status: 'pending-accept',
          statusText: STATUS_TEXT['pending-accept'],
          paidAt: new Date(),
          timeline: json([
            ...asTimeline(order.timeline),
            { key: 'paid', title: '支付成功', time: new Date().toISOString() },
          ]),
        },
      });
      if (!won.count) return; // 并发竞争败者直接退出（幂等）
      if (order.couponId) {
        const used = await tx.userCoupon.updateMany({
          where: { id: order.couponId, status: 'locked' },
          data: { status: 'used' },
        });
        if (used.count) {
          const holding = await tx.userCoupon.findUniqueOrThrow({
            where: { id: order.couponId },
            select: { couponId: true },
          });
          await tx.coupon.update({
            where: { id: holding.couponId },
            data: { used: { increment: 1 } },
          });
        }
      }
      // 佣金流水两条（estimated）：商品佣金（券后基数×比例快照）+ 配送费全额
      const managerId = order.managerStaffId ?? '';
      const base = order.productAmount - order.couponDiscount;
      await tx.nightCommissionTxn.createMany({
        data: [
          {
            orderId: order.id,
            storeId: order.storeId,
            managerStaffId: managerId,
            type: 'commission',
            base,
            rate: order.commissionRate,
            amount: commissionOf(base, order.commissionRate),
            status: 'estimated',
            remark: '商品佣金（券后净实收×比例快照）',
          },
          {
            orderId: order.id,
            storeId: order.storeId,
            managerStaffId: managerId,
            type: 'deliveryFee',
            base: null,
            rate: null,
            amount: order.deliveryFee,
            status: 'estimated',
            remark: '夜间配送费收入（全额）',
          },
        ],
      });
      await tx.notification.create({
        data: {
          userId: order.userId,
          type: 'order',
          title: '夜宵订单支付成功',
          content: `订单 ${order.orderNo} 支付成功，楼长即将接单配送。`,
        },
      });
      // 楼长新单推送：fire-and-forget（复用履约端订阅消息链），不进事务
      const store = await tx.nightStore.findUnique({
        where: { id: order.storeId },
        include: { building: { select: { name: true } } },
      });
      if (store?.managerStaffId && this.push) {
        void this.push.notifyNightManagerNewOrder({
          staffId: store.managerStaffId,
          campusId: store.campusId,
          orderNo: order.orderNo,
          amountFen: order.payableAmount,
          buildingName: store.building.name,
        });
      }
    });
  }

  /**
   * 楼长押金缴纳落账（回调 + 查单兜底共用，幂等）：
   * NightDepositOrder pending/closed → paid；写 NightDepositTxn(deposit)
   * + NightStore.deposit 原子增加。重复回调只落账一次。
   */
  async applyNightDepositPaid(outTradeNo: string, transactionId?: string) {
    void transactionId; // 留参对齐回调签名（交易号仅日志用，一期不落库）
    await this.db.$transaction(async (tx) => {
      const intent = await tx.nightDepositOrder.findUnique({
        where: { outTradeNo },
      });
      if (!intent) throw new NotFoundException('押金支付单不存在');
      // 幂等：条件抢占 paid 位，败者直接返回
      const won = await tx.nightDepositOrder.updateMany({
        where: { id: intent.id, status: { not: 'paid' } },
        data: { status: 'paid', paidAt: new Date() },
      });
      if (!won.count) return;
      await tx.nightDepositTxn.create({
        data: {
          storeId: intent.storeId,
          type: 'deposit',
          amount: intent.amount,
          payOrderNo: intent.outTradeNo,
          remark: `押金缴纳至 ${intent.targetTier / 100} 元档`,
        },
      });
      await tx.nightStore.update({
        where: { id: intent.storeId },
        data: { deposit: { increment: intent.amount } },
      });
    });
  }

  /* ==================== 退款（后台 + 用户取消共用通道） ==================== */

  /**
   * 尽力而为的原路退款：微信凭证未配置（本地/测试环境）时留痕跳过不阻塞
   * 业务流；受理结果未知时同样留痕（资金状态由后台退款同步接口核对）。
   * 返回实际是否已发起。
   */
  private async tryWechatRefund(
    order: { orderNo: string; payableAmount: number; storeId: string },
    refundFen: number,
    refundNo: string,
    reason: string,
  ): Promise<boolean> {
    try {
      const store = await this.db.nightStore.findUnique({
        where: { id: order.storeId },
        select: { campusId: true },
      });
      await this.payments.applyWechatRefund(
        order.orderNo,
        order.payableAmount,
        refundFen,
        refundNo,
        reason.slice(0, 80) || '夜宵订单退款',
        store?.campusId,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `夜宵退款未即时受理（已留痕）：refundNo=${refundNo} ` +
          `reason=${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * 后台退款：整单（缺省）或部分商品金额；可选退配送费；可选回库。
   * 佣金联动：商品退款按「重算应得−已记账」写 adjust 行（避免多次退款
   * 舍入重复，PRD 6.6）；配送费退款写 clawback 冲回行。
   * 全额退款（商品+配送费）成功 → 订单转 refunded + 券恢复（PRD 6.9）。
   * 一期一单一次退款：已退过的单拒绝（二次退款走人工/财务通道）。
   */
  async adminRefund(operatorId: string, orderId: string, body: NightRefundDto) {
    const order = await this.db.nightOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (!order.paidAt) throw new BadRequestException('订单未支付，无需退款');
    if (['cancelled', 'refunded'].includes(order.status))
      throw new BadRequestException('订单当前状态不可退款');
    const productPaid = order.productAmount - order.couponDiscount;
    const productRefund = Math.min(
      body.productRefund ?? productPaid,
      productPaid,
    );
    if (productRefund <= 0) throw new BadRequestException('退款金额不合法');
    const feeRefund = body.refundDeliveryFee ? order.deliveryFee : 0;
    const totalRefund = productRefund + feeRefund;
    const fullRefund = totalRefund === order.payableAmount;
    // 部分商品退款不支持自动回库（回库数量无法从金额推导）
    if (body.restock !== false && productRefund !== productPaid)
      throw new BadRequestException(
        '部分退款不自动回库；如需回库请用库存调整接口',
      );
    // 一单一次退款守门（V1）：timeline 已有 refund 节点拒绝二次退款
    const timelineSteps = asTimeline(order.timeline);
    if (timelineSteps.some((s) => s.key === 'refund'))
      throw new BadRequestException(
        '该订单已发生过退款，二次退款请走人工财务通道',
      );

    await this.db.$transaction(async (tx) => {
      const won = await tx.nightOrder.updateMany({
        where: { id: order.id, status: order.status },
        data: {
          status: fullRefund ? 'refunded' : order.status,
          statusText: fullRefund
            ? STATUS_TEXT.refunded
            : STATUS_TEXT[order.status],
          afterSaleStatus:
            order.afterSaleStatus === 'requested'
              ? 'resolved'
              : order.afterSaleStatus,
          timeline: json([
            ...timelineSteps,
            {
              key: 'refund',
              title: `后台退款 ¥${(totalRefund / 100).toFixed(2)}（${body.reason.slice(0, 40)}）`,
              time: new Date().toISOString(),
            },
          ]),
        },
      });
      if (!won.count) throw new BadRequestException('订单状态已变化');
      // 商品退款回库（整单场景）：refundBack 流水 + 库存回补
      if (body.restock !== false && productRefund === productPaid) {
        const lines = order.items as unknown as NightOrderLine[];
        for (const line of lines) {
          const updated = await tx.nightProduct.updateMany({
            where: { id: line.nightProductId },
            data: { stock: { increment: line.quantity } },
          });
          if (updated.count) {
            const fresh = await tx.nightProduct.findUniqueOrThrow({
              where: { id: line.nightProductId },
              select: { stock: true },
            });
            await tx.nightStockTxn.create({
              data: {
                storeId: order.storeId,
                nightProductId: line.nightProductId,
                type: 'refundBack',
                delta: line.quantity,
                afterStock: fresh.stock,
                refType: 'night-order',
                refId: order.id,
                operatorId,
                remark: '订单退款回库',
              },
            });
          }
        }
      }
      // 佣金联动：商品退款重算 adjust；配送费退款 clawback
      await this.adjustCommissionOnRefund(tx, order, productRefund, feeRefund);
      // 全额退款成功恢复原券（不延长有效期；used→released 可再次使用）
      if (fullRefund && order.couponId) {
        await tx.userCoupon.updateMany({
          where: { id: order.couponId, status: 'used' },
          data: { status: 'released' },
        });
      }
      await tx.notification.create({
        data: {
          userId: order.userId,
          type: 'refund',
          title: fullRefund ? '夜宵订单已退款' : '夜宵订单部分退款',
          content: `订单 ${order.orderNo} 退款 ¥${(totalRefund / 100).toFixed(2)} 将原路退回。`,
        },
      });
    });
    await this.tryWechatRefund(
      order,
      totalRefund,
      `NR${order.id}`,
      body.reason,
    );
    return { id: order.id, refundAmount: totalRefund, fullRefund };
  }

  /** 佣金退款联动（PRD 6.6/T19/T20）：重算 adjust + 配送费 clawback。 */
  private async adjustCommissionOnRefund(
    tx: Tx,
    order: {
      id: string;
      productAmount: number;
      couponDiscount: number;
      deliveryFee: number;
      commissionRate: number;
      storeId: string;
      managerStaffId: string | null;
    },
    productRefund: number,
    feeRefund: number,
  ) {
    const managerId = order.managerStaffId ?? '';
    const originals = await tx.nightCommissionTxn.findMany({
      where: {
        orderId: order.id,
        type: { in: ['commission', 'deliveryFee'] },
        // 冲销行（负向）不作为重算基准
        amount: { gte: 0 },
      },
    });
    const commissionRow = originals.find((r) => r.type === 'commission');
    if (commissionRow && productRefund > 0) {
      const newBase =
        order.productAmount - order.couponDiscount - productRefund;
      const newAmount = commissionOf(newBase, order.commissionRate);
      const delta = newAmount - commissionRow.amount;
      if (delta !== 0) {
        await tx.nightCommissionTxn.create({
          data: {
            orderId: order.id,
            storeId: order.storeId,
            managerStaffId: managerId,
            type: 'commission',
            base: newBase,
            rate: order.commissionRate,
            amount: delta, // 负向调整（跨期冲回）
            status: commissionRow.status,
            settleBatch: commissionRow.settleBatch,
            remark: `退款重算：基数 ${newBase}，应得 ${newAmount}，调整 ${delta}`,
          },
        });
      }
    }
    if (feeRefund > 0) {
      await tx.nightCommissionTxn.create({
        data: {
          orderId: order.id,
          storeId: order.storeId,
          managerStaffId: managerId,
          type: 'deliveryFee',
          base: null,
          rate: null,
          amount: -feeRefund, // clawback：配送费退款同步冲回（V1.5 修订项 3）
          status: 'estimated',
          remark: '配送费退款冲回（clawback）',
        },
      });
    }
  }

  /** 订单取消冲销预计佣金（取消不形成佣金，PRD 6.2）。 */
  private async reverseCommission(tx: Tx, orderId: string, remark: string) {
    const originals = await tx.nightCommissionTxn.findMany({
      where: { orderId, amount: { gt: 0 } },
    });
    if (!originals.length) return;
    await tx.nightCommissionTxn.createMany({
      data: originals.map((r) => ({
        orderId,
        storeId: r.storeId,
        managerStaffId: r.managerStaffId,
        type: r.type,
        base: r.base,
        rate: r.rate,
        amount: -r.amount,
        status: r.status,
        settleBatch: r.settleBatch,
        remark: `${remark}（冲销 ${r.remark}）`,
      })),
    });
  }

  /**
   * 订单完成且无进行中售后 → 佣金 estimated → pending（PRD B13）。
   * 用户确认收货与自动完成 Cron 共用。
   */
  async promoteCommissionToPending(orderId: string) {
    const order = await this.db.nightOrder.findUnique({
      where: { id: orderId },
      select: { afterSaleStatus: true, status: true },
    });
    if (!order) return;
    if (order.afterSaleStatus === 'requested') return; // 售后进行中暂缓
    await this.db.nightCommissionTxn.updateMany({
      where: { orderId, status: 'estimated' },
      data: { status: 'pending' },
    });
  }

  /* ==================== 超时关单 / 自动完成（Cron 与懒执行共用） ==================== */

  /** 待支付超时关单：释放券 + 回补库存（条件更新与支付/取消互斥）。 */
  async closePendingPayment(orderId: string, reason: string) {
    await this.db.$transaction(async (tx) => {
      const order = await tx.nightOrder.findUnique({ where: { id: orderId } });
      if (!order || order.status !== 'pending-payment') return;
      const closed = await tx.nightOrder.updateMany({
        where: { id: orderId, status: 'pending-payment' },
        data: {
          status: 'cancelled',
          statusText: reason,
          cancelReason: reason,
          timeline: json([
            ...asTimeline(order.timeline),
            { key: 'cancel', title: reason, time: new Date().toISOString() },
          ]),
        },
      });
      if (!closed.count) return;
      await this.releaseOrderResources(tx, order);
    });
  }

  /** 关单资源释放：券 locked → released；库存逐行回补（refundBack 流水）。 */
  private async releaseOrderResources(
    tx: Tx,
    order: {
      id: string;
      storeId: string;
      couponId: string | null;
      items: Prisma.JsonValue;
    },
  ) {
    if (order.couponId) {
      await tx.userCoupon.updateMany({
        where: { id: order.couponId, status: 'locked' },
        data: { status: 'released' },
      });
    }
    const lines = order.items as unknown as NightOrderLine[];
    for (const line of lines) {
      const updated = await tx.nightProduct.updateMany({
        where: { id: line.nightProductId },
        data: { stock: { increment: line.quantity } },
      });
      if (updated.count) {
        const fresh = await tx.nightProduct.findUniqueOrThrow({
          where: { id: line.nightProductId },
          select: { stock: true },
        });
        await tx.nightStockTxn.create({
          data: {
            storeId: order.storeId,
            nightProductId: line.nightProductId,
            type: 'refundBack',
            delta: line.quantity,
            afterStock: fresh.stock,
            refType: 'night-order',
            refId: order.id,
            remark: '订单关闭回补库存',
          },
        });
      }
    }
  }

  /** 送达超时自动完成（Cron 调用）：24h 未确认 → completed + 佣金转 pending。 */
  async autoCompleteDelivered(limit = 50): Promise<number> {
    const due = Date.now() - AUTO_COMPLETE_HOURS * 3600 * 1000;
    const orders = await this.db.nightOrder.findMany({
      where: { status: 'delivered' },
      select: { id: true, timeline: true },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });
    let total = 0;
    for (const order of orders) {
      const steps = asTimeline(order.timeline);
      const deliveredAt = steps.find((s) => s.key === 'delivered')?.time;
      if (!deliveredAt || new Date(deliveredAt).getTime() > due) continue;
      const won = await this.db.nightOrder.updateMany({
        where: { id: order.id, status: 'delivered' },
        data: {
          status: 'completed',
          statusText: '超时自动确认',
          completedAt: new Date(),
          timeline: json([
            ...steps,
            {
              key: 'completed',
              title: '超时自动确认',
              time: new Date().toISOString(),
            },
          ]),
        },
      });
      if (won.count) {
        total++;
        await this.promoteCommissionToPending(order.id);
      }
    }
    return total;
  }

  /* ==================== 后台：订单查询 / 结算 ==================== */

  async adminOrders(
    campusId: string,
    filters: { storeId?: string; status?: string; date?: string },
  ) {
    const storeIds = filters.storeId
      ? [filters.storeId]
      : (
          await this.db.nightStore.findMany({
            where: { campusId },
            select: { id: true },
          })
        ).map((s) => s.id);
    const rows = await this.db.nightOrder.findMany({
      where: {
        storeId: { in: storeIds },
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.date ? { businessDate: filters.date } : {}),
      },
      include: {
        store: { include: { building: { select: { name: true } } } },
        user: { select: { id: true, nickname: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map((o) => ({ ...this.orderView(o), user: o.user }));
  }

  async adminOrderDetail(id: string) {
    const order = await this.db.nightOrder.findUnique({
      where: { id },
      include: {
        store: {
          include: {
            building: { select: { name: true } },
            managerStaff: { select: { id: true, name: true, staffNo: true } },
          },
        },
        commissionTxns: true,
        user: { select: { id: true, nickname: true, phone: true } },
      },
    });
    if (!order) throw new NotFoundException('订单不存在');
    return {
      ...this.orderView(order),
      user: order.user,
      manager: order.store.managerStaff,
      commissionTxns: order.commissionTxns,
    };
  }

  /**
   * 周账单出账：范围内 pending（待结算）佣金流水 → settled + settleBatch。
   * estimated（未完成订单）不进批次（PRD B13：完成且无进行中售后才可结算）。
   */
  async settleBatch(campusId: string, storeIds?: string[]) {
    const scope = storeIds?.length
      ? storeIds
      : (
          await this.db.nightStore.findMany({
            where: { campusId },
            select: { id: true },
          })
        ).map((s) => s.id);
    if (!scope.length) throw new BadRequestException('范围内没有夜宵店');
    const batch = `NW${beijingDate().replace(/-/g, '')}${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;
    const result = await this.db.nightCommissionTxn.updateMany({
      where: {
        storeId: { in: scope },
        status: 'pending',
        settleBatch: null,
      },
      data: { status: 'settled', settleBatch: batch },
    });
    const rows = await this.db.nightCommissionTxn.findMany({
      where: { settleBatch: batch },
    });
    return {
      batch,
      txnCount: result.count,
      commissionTotal: rows
        .filter((r) => r.type === 'commission')
        .reduce((s, r) => s + r.amount, 0),
      deliveryFeeTotal: rows
        .filter((r) => r.type === 'deliveryFee')
        .reduce((s, r) => s + r.amount, 0),
    };
  }

  /** 批次列表（含标记打款留痕 remark）。 */
  async settlements(campusId: string) {
    const storeIds = (
      await this.db.nightStore.findMany({
        where: { campusId },
        select: { id: true },
      })
    ).map((s) => s.id);
    const rows = await this.db.nightCommissionTxn.findMany({
      where: { storeId: { in: storeIds }, status: 'settled' },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    const byBatch = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r.settleBatch) continue;
      const list = byBatch.get(r.settleBatch) ?? [];
      list.push(r);
      byBatch.set(r.settleBatch, list);
    }
    return [...byBatch.entries()].map(([batch, list]) => ({
      batch,
      txnCount: list.length,
      commissionTotal: list
        .filter((r) => r.type === 'commission')
        .reduce((s, r) => s + r.amount, 0),
      deliveryFeeTotal: list
        .filter((r) => r.type === 'deliveryFee')
        .reduce((s, r) => s + r.amount, 0),
      latestAt: list
        .map((r) => r.createdAt.toISOString())
        .sort()
        .at(-1),
    }));
  }

  /** 标记打款（财务线下打款后留痕）：批次流水 remark 追加打款标记。 */
  async markBatchPaid(batch: string, operatorId: string, remark: string) {
    const list = await this.db.nightCommissionTxn.findMany({
      where: { settleBatch: batch, status: 'settled' },
      select: { id: true, remark: true },
    });
    if (!list.length) throw new NotFoundException('批次不存在或无已结算流水');
    const stamp = ` | 已打款 ${new Date().toISOString()} by ${operatorId}${remark ? ` ${remark}` : ''}`;
    await this.db.$transaction(
      list.map((r) =>
        this.db.nightCommissionTxn.update({
          where: { id: r.id },
          data: { remark: `${r.remark}${stamp}`.slice(0, 500) },
        }),
      ),
    );
    return { batch, txnCount: list.length };
  }

  /* ==================== 押金支付单（楼长端发起） ==================== */

  /**
   * 发起押金缴纳：按 500 元档递增补缴（下一档 − 当前余额 = 本次缴纳额）。
   * 生成 ND 前缀微信支付单（幂等：旧 pending 单直接复用其单号重新预下单）。
   */
  async initiateDepositPay(
    storeId: string,
    campusId: string,
    openid: string,
    payerAppId?: string,
  ) {
    const store = await this.db.nightStore.findUnique({
      where: { id: storeId },
    });
    if (!store) throw new NotFoundException('夜宵店不存在');
    const targetTier = Math.max(
      50000,
      (Math.floor(store.deposit / 50000) + 1) * 50000,
    );
    const amount = targetTier - store.deposit;
    if (amount <= 0) throw new BadRequestException('押金已足额，无需缴纳');
    // 复用未支付旧单（幂等；避免堆积死单）
    let intent = await this.db.nightDepositOrder.findFirst({
      where: { storeId, status: 'pending', amount },
      orderBy: { createdAt: 'desc' },
    });
    if (!intent) {
      // 关闭过期旧单（不同金额的 pending 单）
      await this.db.nightDepositOrder.updateMany({
        where: { storeId, status: 'pending' },
        data: { status: 'closed' },
      });
      intent = await this.db.nightDepositOrder.create({
        data: {
          storeId,
          outTradeNo: nightDepositTradeNo(),
          amount,
          targetTier,
        },
      });
    }
    const payParams = await this.payments.nightPrepay({
      campusId,
      outTradeNo: intent.outTradeNo,
      amount: intent.amount,
      openid,
      description: '夜宵店经营押金缴纳',
      payerAppId,
    });
    return {
      depositOrderId: intent.id,
      outTradeNo: intent.outTradeNo,
      amount: intent.amount,
      targetTier: intent.targetTier,
      payParams,
    };
  }

  /** 押金支付结果轮询兜底（回调故障时查单落账）。 */
  async depositPayStatus(
    storeId: string,
    campusId: string,
    outTradeNo?: string,
  ) {
    const intent = await this.db.nightDepositOrder.findFirst({
      where: { storeId, ...(outTradeNo ? { outTradeNo } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    if (!intent) throw new NotFoundException('押金支付单不存在');
    if (intent.status === 'pending') {
      try {
        const trade = await this.payments.nightTradeState(
          intent.outTradeNo,
          campusId,
        );
        if (trade.tradeState === 'SUCCESS')
          await this.applyNightDepositPaid(
            intent.outTradeNo,
            trade.transactionId,
          );
      } catch {
        // 查单失败不阻塞状态返回
      }
    }
    const fresh = await this.db.nightDepositOrder.findUniqueOrThrow({
      where: { id: intent.id },
    });
    return {
      outTradeNo: fresh.outTradeNo,
      amount: fresh.amount,
      status: fresh.status,
      paidAt: fresh.paidAt?.toISOString() ?? null,
    };
  }

  /* ==================== 微信回调分发（NightPaymentHandler） ==================== */

  async onPaid(outTradeNo: string, transactionId?: string): Promise<void> {
    if (outTradeNo.startsWith('ND'))
      return this.applyNightDepositPaid(outTradeNo, transactionId);
    return this.applyNightOrderPaid(outTradeNo, transactionId);
  }

  /* ==================== 内部：场次窗口 ==================== */

  /**
   * 夜晚场次校验（V1.5 修订项 1 互斥判定）：校区开夜宵 + 处于夜宵窗口 +
   * 校区白天业务已闭店（手动闭店或打烊窗内）。不满足抛具体原因（T71）。
   */
  assertNightWindow(campus: {
    nightEnabled: boolean;
    nightStartAt: string | null;
    nightEndAt: string | null;
    closeStart: string;
    closeEnd: string;
    manualClosed: boolean;
  }) {
    if (!campus.nightEnabled)
      throw new BadRequestException('本校区未开通夜宵服务');
    if (!inNightWindow(campus.nightStartAt, campus.nightEndAt))
      throw new BadRequestException(
        `未到夜宵营业时间（${campus.nightStartAt ?? '--:--'}~${campus.nightEndAt ?? '--:--'}）`,
      );
    // 白天闭店判定与白天业务 isClosedNow 同构：手动闭店优先，时间窗跨零点合法；
    // closeStart === closeEnd = 24 小时营业 = 白天永不闭店 = 夜宵恒不可开（互斥）
    const dayClosed =
      campus.manualClosed ||
      this.dayCloseWindowHit(campus.closeStart, campus.closeEnd);
    if (!dayClosed)
      throw new BadRequestException('校区白天业务未闭店，夜宵店暂不能营业');
  }

  /** 白天打烊窗命中判定（照抄 business.service isClosedNow 时间窗分支）。 */
  private dayCloseWindowHit(start?: string | null, end?: string | null) {
    const s = hhmmToMinutes(start);
    const e = hhmmToMinutes(end);
    if (s === null || e === null || s === e) return false;
    const nowMin = beijingMinutes();
    return s < e ? nowMin >= s && nowMin < e : nowMin >= s || nowMin < e;
  }

  /** 静态出口：营状态下发文案（三态页面用）。 */
  statusTextOf(status: string) {
    return STATUS_TEXT[status] ?? status;
  }

  /** 领券中心/我的夜宵券（businessType=night 隔离；结构对齐白天 coupons）。 */
  async nightCoupons(userId: string, campusId: string) {
    const marketing = await marketingEnabled(this.db, campusId);
    const [items, mine] = await Promise.all([
      this.db.coupon.findMany({
        where: { campusId, businessType: 'night' },
        orderBy: { expiresAt: 'asc' },
      }),
      this.db.userCoupon.findMany({
        where: { userId, coupon: { campusId, businessType: 'night' } },
        include: { coupon: true },
        orderBy: { claimedAt: 'desc' },
      }),
    ]);
    const now = new Date();
    return {
      claimable: marketing
        ? items
            .filter(
              (c) =>
                c.trigger === 'manual' &&
                !c.targetedOnly &&
                c.status === 'active' &&
                (!c.expiresAt || c.expiresAt > now) &&
                (c.total === null || c.claimed < c.total) &&
                ((c.perUserLimit ?? 1) === 0 ||
                  mine.filter((x) => x.couponId === c.id && x.status !== 'used')
                    .length < (c.perUserLimit ?? 1)),
            )
            .map((c) => ({
              id: c.id,
              name: c.name,
              amount: c.amount,
              threshold: c.threshold,
              businessType: c.businessType,
              remain:
                c.total === null ? null : Math.max(0, c.total - c.claimed),
              expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
            }))
        : [],
      mine: mine.map((x) => ({
        id: x.id,
        couponId: x.couponId,
        status: x.status,
        claimedAt: x.claimedAt.toISOString(),
        coupon: {
          id: x.coupon.id,
          name: x.coupon.name,
          amount: x.coupon.amount,
          threshold: x.coupon.threshold,
          businessType: x.coupon.businessType,
          expiresAt: x.coupon.expiresAt
            ? x.coupon.expiresAt.toISOString()
            : null,
        },
      })),
    };
  }

  /** 领取夜宵券（复刻白天 claimCoupon 逻辑 + businessType=night 强校验）。 */
  async claimNightCoupon(userId: string, couponId: string, campusId: string) {
    if (!(await marketingEnabled(this.db, campusId)))
      throw new ForbiddenException('营销能力未开通');
    return this.db.$transaction(async (tx) => {
      const coupon = await tx.coupon.findUnique({ where: { id: couponId } });
      if (!coupon) throw new NotFoundException('优惠券不存在');
      if (coupon.campusId !== campusId)
        throw new BadRequestException('该优惠券不属于当前校区');
      // 券双向隔离：夜宵领券口只收夜宵券（T52）
      if (coupon.businessType !== 'night')
        throw new BadRequestException('该券不可在夜宵渠道领取');
      if (coupon.status !== 'active')
        throw new BadRequestException('优惠券暂不可领取');
      if (coupon.trigger !== 'manual' || coupon.targetedOnly)
        throw new BadRequestException('该优惠券不支持手动领取');
      if (coupon.expiresAt && coupon.expiresAt.getTime() <= Date.now())
        throw new BadRequestException('优惠券已过期');
      const limit = coupon.perUserLimit ?? 1;
      if (limit !== 0) {
        const holdings = await tx.userCoupon.findMany({
          where: { userId, couponId },
        });
        const holding = holdings.find((x) => x.status !== 'used');
        if (holdings.length >= limit) {
          if (holding) return holding;
          throw new BadRequestException('该优惠券已使用');
        }
        if (holding) return holding;
      }
      const won = await tx.coupon.updateMany({
        where: {
          id: couponId,
          ...(coupon.total === null ? {} : { claimed: { lt: coupon.total } }),
        },
        data: { claimed: { increment: 1 }, issued: { increment: 1 } },
      });
      if (!won.count) throw new BadRequestException('优惠券已被领完');
      return tx.userCoupon.create({
        data: { userId, couponId, status: 'claimed' },
      });
    });
  }
}
